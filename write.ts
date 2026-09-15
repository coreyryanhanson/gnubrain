// §4 write tool — kb_write. Sprint scope: the confirmation gate and the
// `create` flow end to end (title guard, mint policy, verified-create,
// guard-stop staging). Every kernel-touching step rides the S1 gate
// (runKbCall) and the write-path probe gate (gateWriteAttempt).

import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { CircuitBreaker } from "./breaker.js";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { gateWriteAttempt, runKbCall } from "./gate.js";
import {
	renderOutline,
	rowPayload,
	sqlString,
	textResult,
	walkBlockTree,
	type KernelReadClient,
} from "./tools.js";
import {
	type KernelProbeClient,
	type SessionValidation,
} from "./validation.js";
import { spillFile } from "./spill.js";

/** Structural client subset the write tools need (tests stub it). */
export interface WriteKernelClient extends KernelReadClient, KernelProbeClient {
	createDocWithMarkdown(params: {
		notebook: string;
		path: string;
		markdown: string;
		parentID?: string;
	}): Promise<string>;
}

export interface WriteToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): WriteKernelClient | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped confirm_timeout state — same lifecycle class as the breaker. */
	confirmState: WriteConfirmState;
	/** Injectable seams (unit tests); defaults wire to ctx at execute time. */
	confirm?: WriteConfirmFn;
	hasUI?: boolean;
	readBodyFile?: (path: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Write confirmation (§5)
// ---------------------------------------------------------------------------

export type WriteConfirmFn = (
	title: string,
	message: string,
	opts: { signal?: AbortSignal },
) => Promise<boolean>;

export interface WriteConfirmState {
	/** Keys of writes that hit confirm_timeout — terminal for that write in this session (§5). */
	timedOut: Set<string>;
}

export function createWriteConfirmState(): WriteConfirmState {
	return { timedOut: new Set() };
}

/** Identifies "that write" for the terminal-timeout rule (§5). */
export function writeConfirmKey(parts: (string | undefined)[]): string {
	return parts.map((p) => p ?? "-").join("|");
}

export const DEFAULT_WRITE_CONFIRM_TIMEOUT = 60;

/**
 * Pre-dialog permission check (§5): headless default-deny and the terminal
 * confirm_timeout rule — both zero-kernel-call checks that run before the
 * guard so a denied write costs no kernel round-trips. Returns `dialog:
 * true` when the interactive dialog must run after the guard, `dialog:
 * false` for an approved unattended write (dialog skipped, §5).
 */
export function preflightWrite(input: {
	hasUI: boolean;
	allowUnattendedWrites: boolean | undefined;
	state: WriteConfirmState;
	key: string;
	summary: string;
}): { ok: true; dialog: boolean } | { ok: false; envelope: Envelope } {
	if (input.state.timedOut.has(input.key)) {
		return {
			ok: false,
			envelope: refusedEnvelope(
				`this write already hit confirm_timeout in this session — the refusal is terminal. Do not retry; stop and report the pending write ('${input.summary}') to the user.`,
				{ reason: "confirm_timeout" },
			),
		};
	}
	if (!input.hasUI) {
		if (input.allowUnattendedWrites === true) {
			// Dialog skipped; the write proceeds unattended (§5).
			return { ok: true, dialog: false };
		}
		return {
			ok: false,
			envelope: refusedEnvelope(
				`no UI is available to confirm the write (headless session) — writes are denied by default. Set gnubrain.allowUnattendedWrites: true in the global settings file to allow unattended writes.`,
			),
		};
	}
	return { ok: true, dialog: true };
}

/**
 * The dialog half of the write-confirmation gate (§5). Runs only after
 * preflightWrite passed. Returns null to proceed with the write; otherwise
 * a `refused` envelope. Fail-closed by construction: every non-answer —
 * dismissal, thrown dialog call, timeout expiry — resolves to refused. The
 * timeout clock is extension-owned via AbortSignal; the native dialog
 * auto-dismisses on abort and `controller.signal.aborted` distinguishes a
 * real timeout from an explicit decline (pi's documented timed-confirm
 * pattern). Timeout 0 waits indefinitely (no signal, no timer).
 */
export async function confirmWrite(input: {
	confirm: WriteConfirmFn;
	writeConfirmTimeout: number | undefined;
	state: WriteConfirmState;
	key: string;
	summary: string;
}): Promise<Envelope | null> {
	const { confirm, key } = input;
	const timeoutSeconds =
		input.writeConfirmTimeout ?? DEFAULT_WRITE_CONFIRM_TIMEOUT;
	const controller = new AbortController();
	const timer =
		timeoutSeconds > 0
			? setTimeout(() => controller.abort(), timeoutSeconds * 1000)
			: undefined;
	let confirmed: boolean;
	try {
		confirmed = await confirm(
			"GNUbrain write",
			`${input.summary}\n\nConfirm?`,
			timer === undefined ? {} : { signal: controller.signal },
		);
	} catch (err) {
		return refusedEnvelope(
			`write confirmation dialog failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	if (confirmed) return null;
	if (controller.signal.aborted) {
		// Terminal for this write in this session (§5): a re-request refuses
		// immediately without a new dialog — no confirm/timeout/refuse loop.
		input.state.timedOut.add(key);
		return refusedEnvelope(
			`write confirmation timed out after ${timeoutSeconds}s (confirm_timeout) — terminal for this write in this session. Do not retry; stop and report the pending write ('${input.summary}') to the user.`,
			{ reason: "confirm_timeout" },
		);
	}
	// Explicit decline stays ordinary recoverable refused (§5).
	return refusedEnvelope(
		`write declined by the user — a re-ask with a rephrased variant is legitimate.`,
	);
}

// ---------------------------------------------------------------------------
// File-path input (§4) — markdown XOR markdownFile, read once at call start
// ---------------------------------------------------------------------------

/** Structured error for file-path input failures (missing / not a regular
 * file / unreadable) — always resolved before any kernel call (§4). */
export class BodyFileError extends Error {}

/** The §4 trust posture: "must exist, must be a regular file" — no path
 * allowlisting (single-user VM holding an admin token). */
export async function readBodyFile(path: string): Promise<string> {
	let stat;
	try {
		stat = await fsStat(path);
	} catch (err) {
		throw new BodyFileError(
			`markdownFile '${path}' is not readable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!stat.isFile()) {
		throw new BodyFileError(`markdownFile '${path}' is not a regular file`);
	}
	try {
		return await fsReadFile(path, "utf8");
	} catch (err) {
		throw new BodyFileError(
			`markdownFile '${path}' is unreadable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Mint policy (§4) + guard patterns
// ---------------------------------------------------------------------------

/** The kernel stores title IALs entity-escaped in blocks.content; the guard
 * computes the stored form rather than being blind to it (§4). The double
 * quote maps to `&#30;` — the kernel's own encoding. */
export function htmlEscape(title: string): string {
	return title
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&#30;")
		.replaceAll("'", "&#39;");
}

/** LIKE-wildcard escaping for the guard patterns (ESCAPE '\', §4): the
 * HTML-escaped form contains no % or _, so this composes trivially. */
export function likeEscape(fragment: string): string {
	return fragment
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

/** Exact-leg pattern: the HTML-escaped submitted title, LIKE-escaped. */
export function guardExactPattern(title: string): string {
	return likeEscape(htmlEscape(title));
}

/** Near-match prefix variants (§4): the title's separator runs canonicalized
 * to space / hyphen / underscore — built from the HTML-escaped title (same
 * parity as the exact leg); the intentional `_` is LIKE-escaped like any
 * other wildcard (`docker\_networking%`). */
export function guardNearPatterns(title: string): string[] {
	const words = htmlEscape(title)
		.split(/[ \-_]+/)
		.filter((w) => w !== "");
	if (words.length === 0) return [];
	// One-word titles produce three identical legs — dedupe.
	return [
		...new Set([" ", "-", "_"].map((sep) => `${likeEscape(words.join(sep))}%`)),
	];
}

/**
 * §4 mint policy — the rejection set covers every transform the kernel's
 * `normalizeDocTitle` applies (superset claim, pinned live by the §10 title
 * round-trip): any title that survives stores verbatim.
 */
export function validateMintTitle(
	raw: string,
): { ok: true; title: string } | { ok: false; message: string } {
	const title = raw.trim();
	if (title === "") {
		return {
			ok: false,
			message: "title is empty after trim — supply a non-empty title",
		};
	}
	if (title.includes("/")) {
		return {
			ok: false,
			message: `title '${title}' contains '/' — the tool builds the doc path itself; rephrase the title without '/'`,
		};
	}
	if ([...title].length > 512) {
		return {
			ok: false,
			message:
				"title exceeds 512 runes — the kernel silently truncates longer titles; shorten it",
		};
	}
	// eslint-disable-next-line no-control-regex
	if (/[\t\n\r\x00-\x1f\x7f]/.test(title)) {
		return {
			ok: false,
			message: `title '${title}' contains tab/newline/control characters — their stored form is unpredictable; rephrase the title`,
		};
	}
	return { ok: true, title };
}

/** Rows at a guard stop are few; the near-match scan is capped at 20 (§4). */
export const GUARD_NEAR_CAP = 20;

interface GuardRow {
	id: string;
	root_id: string;
	content: string;
	updated: string;
}

function toGuardRows(rows: Record<string, unknown>[]): GuardRow[] {
	return rows.map((r) => ({
		id: String(r.id),
		root_id: String(r.root_id),
		content: String(r.content),
		updated: String(r.updated ?? ""),
	}));
}

export function guardExactStmt(boxId: string, title: string): string {
	return (
		`SELECT id, root_id, content, updated FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' ` +
		`AND content LIKE ${sqlString(guardExactPattern(title))} ESCAPE ${sqlString("\\")}`
	);
}

export function guardNearStmt(boxId: string, title: string): string {
	const legs = guardNearPatterns(title)
		.map((p) => `content LIKE ${sqlString(p)} ESCAPE ${sqlString("\\")}`)
		.join(" OR ");
	// LIMIT caps returned rows, not scan work (content has no index — §4);
	// +1 so the caller can distinguish "exactly 20" from "20+".
	return (
		`SELECT id, root_id, content, updated FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' AND (${legs}) ` +
		`LIMIT ${GUARD_NEAR_CAP + 1}`
	);
}

// ---------------------------------------------------------------------------
// Create flow (§4) — guard → confirm → mint → verified-create → echo
// ---------------------------------------------------------------------------

export interface CreateFlowInput {
	sessionId: string;
	kernel: WriteKernelClient;
	validation: SessionValidation;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	title: string;
	parentId?: string | undefined;
	body: string;
	/** True when the body came from markdownFile — staging is skipped (§4). */
	bodyFromFile: boolean;
	confirmNew: boolean;
	confirm: WriteConfirmFn;
	hasUI: boolean;
	confirmState: WriteConfirmState;
}

async function duplicateStop(
	input: CreateFlowInput,
	title: string,
	rows: GuardRow[],
): Promise<Envelope> {
	const { kernel, sessionId, name } = input;
	const detailed: Record<string, unknown>[] = [];
	for (const row of rows) {
		const docId = row.root_id;
		const outline = await renderOutline(kernel, sessionId, "kb_write", docId);
		const md = await kernel.exportMarkdown(docId);
		const markdownPath = spillFile(
			sessionId,
			"kb_write-candidate",
			md.content,
			"md",
		);
		detailed.push({
			docId,
			title: row.content,
			updated: row.updated,
			outline: outline.outline,
			markdownPath,
		});
	}
	const docIds = detailed.map((d) => d.docId).join(", ");
	const envelope: Envelope = {
		status: "duplicate",
		message:
			`${rows.length} existing doc${rows.length === 1 ? "" : "s"} titled '${title}' in KB '${name}': ${docIds} — ` +
			`reconcile by docId (edit/append onto the wanted doc), or pass confirmNew: true to mint a conscious second doc`,
		kb: name,
		rows: detailed,
	};
	// Single-row: block IDs with content so the agent can go straight to
	// `edit` by blockId (§4 step 1).
	if (rows.length === 1) {
		const docId = rows[0]!.root_id;
		const blocks = (await walkBlockTree(kernel, docId, 1)).map((b) => ({
			id: b.id,
			type: b.type,
			content: b.content,
		}));
		const payload = rowPayload(sessionId, "kb_write-blocks", blocks);
		if (payload.rows !== undefined) {
			envelope.blockIds = payload.rows;
		} else {
			envelope.preview = payload.preview;
			envelope.fullResultPath = payload.fullResultPath;
		}
	}
	return stagedEnvelope(envelope, input);
}

async function nearMatchStop(
	input: CreateFlowInput,
	title: string,
	rows: GuardRow[],
): Promise<Envelope> {
	const { kernel, name } = input;
	const candidates: Record<string, unknown>[] = [];
	for (const row of rows) {
		// First paragraph of each candidate (§4): the first child block's
		// content — cheap and excerpt-only by design (§4 near-match tier).
		let firstParagraph = "";
		try {
			const children = await kernel.getChildBlocks(row.root_id);
			firstParagraph = String(children[0]?.content ?? "");
		} catch {
			// vanished candidate mid-scan — empty excerpt, row still shown
		}
		candidates.push({
			docId: row.root_id,
			title: row.content,
			firstParagraph,
			updated: row.updated,
		});
	}
	const envelope: Envelope = {
		status: "near_matches",
		message:
			`near-matches exist for '${title}' in KB '${name}' — pass confirmNew: true to create anyway, ` +
			`or read an existing topic by docId and edit it`,
		kb: name,
		candidates,
	};
	if (rows.length > GUARD_NEAR_CAP) {
		envelope.truncated = `capped at ${GUARD_NEAR_CAP} candidates — refine the title`;
		candidates.length = GUARD_NEAR_CAP;
	}
	return stagedEnvelope(envelope, input);
}

/** Guard-stop draft staging (§4): an inline body is staged so the retry
 * travels by path (~25 tokens) instead of re-transmitting the full draft.
 * Creates that already used markdownFile stage nothing. */
function stagedEnvelope(envelope: Envelope, input: CreateFlowInput): Envelope {
	if (input.bodyFromFile) return envelope;
	const stagedPath = spillFile(input.sessionId, "draft", input.body, "md");
	envelope.stagedPath = stagedPath;
	envelope.message += ` — body staged at ${stagedPath}; retry with markdownFile: '${stagedPath}'`;
	return envelope;
}

function parentLookupStmt(boxId: string, parentId: string): string {
	return (
		`SELECT id, hpath, content FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(parentId)} AND type = 'd'`
	);
}

function verifiedRootStmt(boxId: string, returnedId: string): string {
	return (
		`SELECT id, root_id, content, hpath, updated FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(returnedId)} AND type = 'd'`
	);
}

/**
 * The `create` flow (§4): title guard (exact leg, then near-match scan) →
 * write confirmation → submission path built from ground truth →
 * verified-create by-ID asserts → echo (root docId, stored title, real
 * hpath, fresh outline). `confirmNew: true` bypasses both guard legs; the
 * confirmation and verified-create still apply.
 */
export async function runCreateFlow(input: CreateFlowInput): Promise<Envelope> {
	const { kernel, validation, sessionId, name, boxId } = input;
	const mint = validateMintTitle(input.title);
	if (!mint.ok) return refusedEnvelope(mint.message);
	const title = mint.title;
	const confirmKey = writeConfirmKey([name, "create", title]);
	const summary = `Create '${title}' in KB '${name}' (${input.body.length} chars)`;

	// Pre-dialog permission (§5): headless default-deny + terminal
	// confirm_timeout — both before the guard, so a denied write costs zero
	// kernel calls.
	const preflight = preflightWrite({
		hasUI: input.hasUI,
		allowUnattendedWrites: validation.settings?.allowUnattendedWrites,
		state: input.confirmState,
		key: confirmKey,
		summary,
	});
	if (!preflight.ok) return preflight.envelope;

	// Guard (§4) — exact leg first; only an empty exact leg runs the scan.
	if (!input.confirmNew) {
		const exact = toGuardRows(await kernel.query(guardExactStmt(boxId, title)));
		if (exact.length > 0) return duplicateStop(input, title, exact);
		const near = toGuardRows(await kernel.query(guardNearStmt(boxId, title)));
		if (near.length > 0) return nearMatchStop(input, title, near);
	}

	// Write confirmation (§5) — after the guard, so a stop costs no dialog.
	if (preflight.dialog) {
		const gate = await confirmWrite({
			confirm: input.confirm,
			writeConfirmTimeout: validation.settings?.writeConfirmTimeout,
			state: input.confirmState,
			key: confirmKey,
			summary,
		});
		if (gate !== null) return gate;
	}

	// Submission path from ground truth, never predicted (§4 step 3).
	let path: string;
	let parentID: string | undefined;
	let storedParentHpath: string | undefined;
	if (input.parentId !== undefined) {
		const parentRows = await kernel.query(
			parentLookupStmt(boxId, input.parentId),
		);
		const parent = parentRows[0];
		if (parent === undefined) {
			return errorEnvelope(
				`parentId '${input.parentId}' does not resolve to a doc in KB '${name}' (stale or foreign target)`,
			);
		}
		storedParentHpath = String(parent.hpath ?? "");
		path = `${storedParentHpath}/${title}`;
		parentID = input.parentId;
	} else {
		path = `/${title}`;
	}

	const returnedId = await kernel.createDocWithMarkdown({
		notebook: boxId,
		path,
		markdown: input.body,
		...(parentID !== undefined ? { parentID } : {}),
	});

	// Verified-create (§4 step 4): by-ID asserts on the kernel-returned root
	// ID — fail-loud on shape, never a by-title re-lookup.
	const rootRows = (
		await kernel.query(verifiedRootStmt(boxId, returnedId))
	).map((r) => ({
		id: String(r.id),
		root_id: String(r.root_id),
		content: String(r.content),
		hpath: String(r.hpath),
	}));
	const root = rootRows[0];
	if (root === undefined) {
		return errorEnvelope(
			`verified-create failed: the kernel returned doc id '${returnedId}' but no type='d' row exists for it in KB '${name}' — the mint is unconfirmable; do not retry blindly`,
		);
	}
	if (parentID !== undefined) {
		// Nested asserts: the parent must still exist with the hpath that was
		// used, and the child's hpath must equal storedParentHpath + "/" +
		// the child's STORED title (ground truth, never the submitted form).
		const parentNow = (
			await kernel.query(parentLookupStmt(boxId, parentID))
		).map((r) => ({ hpath: String(r.hpath) }))[0];
		if (parentNow === undefined || parentNow.hpath !== storedParentHpath) {
			return errorEnvelope(
				`verified-create failed: parent '${parentID}' was deleted or renamed between the hpath read-back and the create — the kernel minted a ghost intermediate; drop the ghost subtree and retry`,
			);
		}
		const expectedChildHpath = `${storedParentHpath}/${root.content}`;
		if (root.hpath !== expectedChildHpath) {
			return errorEnvelope(
				`verified-create failed: stored hpath '${root.hpath}' does not match ground truth '${expectedChildHpath}' — unexpected kernel title normalization`,
			);
		}
	}

	const outline = await renderOutline(
		kernel,
		sessionId,
		"kb_write",
		root.root_id,
	);
	return {
		status: "ok",
		message: `created '${root.content}' in KB '${name}' — docId ${root.root_id}, hpath ${root.hpath}`,
		kb: name,
		docId: root.root_id,
		title: root.content,
		hpath: root.hpath,
		outline: outline.outline,
		...(outline.fullOutlinePath !== undefined
			? { fullOutlinePath: outline.fullOutlinePath }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/** Modes that carry a body (§4 schema table) — delete/move carry neither
 * markdown nor markdownFile and are valid without them. */
const CONTENT_BEARING_MODES = new Set([
	"create",
	"edit",
	"replace-section",
	"append",
]);

const WRITE_DESCRIPTION = `Write to a GNUbrain knowledge base. Registered modes: create — mint a new doc by title (topic), optionally nested under an echoed parentId. The body travels via markdown (inline) XOR markdownFile (path to a prepared markdown file; read once at call start). The tool guards against existing stored titles: an exact or near title match stops the mint and returns the existing docs (docId, outline, spilled markdown) — reconcile by docId, or mint a conscious duplicate with confirmNew: true (you learn this exit from the rejection; do not pass it preemptively). Every write is confirmed with the user unless the session is headless with allowUnattendedWrites: true. Targets (docId) are echoed values from kb_query/kb_search/kb_read — never invented. The discovery name 'kbs' is read-only; writes always target a real KB by name.`;

const writeSchema = Type.Object({
	kb: Type.String({
		description: "KB name to write into — must be in the active scope",
	}),
	mode: Type.String({
		description: 'write mode — currently "create"',
	}),
	topic: Type.Optional(
		Type.String({
			description: 'title for mode "create" — minted by title after the guard',
		}),
	),
	parentId: Type.Optional(
		Type.String({
			description: 'echoed docId — nested mint under this doc (mode "create")',
		}),
	),
	markdown: Type.Optional(
		Type.String({
			description:
				"inline markdown body — exactly one of markdown / markdownFile on content-bearing modes",
		}),
	),
	markdownFile: Type.Optional(
		Type.String({
			description:
				"path to a prepared markdown file — read once at call start; exactly one of markdown / markdownFile",
		}),
	),
});
export type WriteParams = Static<typeof writeSchema> & {
	confirmNew?: unknown; // never declared in the schema (§4 decision record)
};

export function registerWriteTool(pi: ExtensionAPI, hooks: WriteToolHooks) {
	pi.registerTool({
		name: "kb_write",
		label: "KB Write",
		description: WRITE_DESCRIPTION,
		parameters: writeSchema,
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(
					errorEnvelope(
						"kb tools are not ready — session validation has not run",
					),
				);
			}
			const kernel = hooks.getKernel();
			const p = params as WriteParams;
			const envelope = await runKbCall(
				{ validation, breaker: hooks.breaker, kb: p.kb, arity: "single" },
				async (names) => {
					if (kernel === undefined) {
						return errorEnvelope(
							"kb tools are not ready — settings did not load",
						);
					}
					// Write-path probe gate (§5): a successful probe (or a
					// per-attempt retry) must precede any write.
					const probeEnv = await gateWriteAttempt({ validation, kernel });
					if (probeEnv !== null) return probeEnv;
					const name = names[0] as string;
					const boxId = validation.validKBs.get(name);
					if (boxId === undefined) {
						return errorEnvelope(`KB '${name}' is not in the valid set`);
					}
					if (p.mode !== "create") {
						return refusedEnvelope(
							`mode '${p.mode}' is not supported — supported modes: create`,
						);
					}
					// Content-body shape: markdown XOR markdownFile (§4). The file
					// read is the call's first content step — before any guard
					// query — so a bad path refuses with zero kernel calls.
					let body: string | undefined = p.markdown;
					const fromFile = p.markdownFile !== undefined;
					if (CONTENT_BEARING_MODES.has(p.mode)) {
						if ((body !== undefined) === fromFile) {
							return refusedEnvelope(
								"provide exactly one of 'markdown' (inline string) or 'markdownFile' (path)",
							);
						}
						if (fromFile) {
							const read = hooks.readBodyFile ?? readBodyFile;
							try {
								body = await read(p.markdownFile as string);
							} catch (err) {
								return errorEnvelope(
									err instanceof Error ? err.message : String(err),
								);
							}
						}
					}
					return runCreateFlow({
						sessionId: ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						name,
						boxId,
						title: p.topic ?? "",
						parentId: p.parentId,
						body: body ?? "",
						bodyFromFile: fromFile,
						confirmNew: p.confirmNew === true,
						confirm:
							hooks.confirm ??
							((title, message, opts) => ctx.ui.confirm(title, message, opts)),
						hasUI: hooks.hasUI ?? ctx.hasUI,
						confirmState: hooks.confirmState,
					});
				},
			);
			return textResult(envelope);
		},
	});
}
