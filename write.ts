// §4 write tool — kb_write. Sprint scope: the confirmation gate and the
// `create` flow end to end (title guard, mint policy, verified-create,
// guard-stop staging). Every kernel-touching step rides the S1 gate
// (runKbCall) and the write-path probe gate (gateWriteAttempt).

import { createHash } from "node:crypto";
import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { SiYuanApiError, type BlockTransaction } from "siyuan-kernel-api";
import { CircuitBreaker } from "./breaker.js";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { gateWriteAttempt, runKbCall } from "./gate.js";
import {
	renderOutline,
	renderOutlineFromWalk,
	rowPayload,
	sqlString,
	textResult,
	walkBlockTree,
	type KernelReadClient,
	type WalkedBlock,
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
	updateBlock(params: {
		id: string;
		data: string;
	}): Promise<BlockTransaction[]>;
	insertBlock(params: {
		data: string;
		nextID?: string;
		previousID?: string;
		parentID?: string;
	}): Promise<BlockTransaction[]>;
	appendBlock(params: {
		data: string;
		parentID: string;
	}): Promise<BlockTransaction[]>;
	deleteBlock(id: string): Promise<BlockTransaction[]>;
	moveBlock(params: {
		id: string;
		previousID?: string;
		parentID?: string;
	}): Promise<null>;
	removeDocByID(id: string): Promise<null>;
	moveDocsByID(params: { fromIDs: string[]; toID: string }): Promise<null>;
}

export interface WriteToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): WriteKernelClient | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped confirm_timeout state — same lifecycle class as the breaker. */
	confirmState: WriteConfirmState;
	/** Session-scoped fresh-content baselines (§4 decision record) — same
	 * lifecycle class as the breaker/confirm state. */
	baselines: ContentBaselines;
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
// Content baselines (§4 fresh-content precondition)
// ---------------------------------------------------------------------------

/** sha256-16hex of one block's content — the fresh-content baseline key. */
export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Session-scoped served-content baselines (§4 fresh-content precondition,
 * decision record): hash of each block's content as the tool last SERVED it
 * this session — never persisted, never seeded from submitted markdown
 * (the kernel re-parses it, so the stored form is unknowable at submit
 * time). Same lifecycle class as the breaker/confirm state: after
 * resume/fork the map is empty and the no-baseline fallback applies. */
export class ContentBaselines {
	private hashes = new Map<string, string>();

	remember(blockId: string, content: string): void {
		this.hashes.set(blockId, contentHash(content));
	}

	servedHash(blockId: string): string | undefined {
		return this.hashes.get(blockId);
	}

	clear(): void {
		this.hashes.clear();
	}
}

export function createContentBaselines(): ContentBaselines {
	return new ContentBaselines();
}

interface BaselineView {
	blockId: string;
	content: string;
}

function rowsToBaselineView(rows: Record<string, unknown>[]): BaselineView[] {
	return rows.map((r) => ({
		blockId: String(r.id),
		content: String(r.content),
	}));
}

function baselineContentsStmt(ids: string[]): string {
	return (
		`SELECT id, content FROM blocks WHERE id IN ` +
		`(${ids.map(sqlString).join(", ")})`
	);
}

/**
 * The fresh-content baseline for the targeted blocks (§4 decision record):
 * served content where the session has seen the block, else the block's
 * CURRENT content — the no-baseline fallback's read, displayed in the write
 * confirmation; the confirmation approval establishes the baseline.
 * Single batched read; called before the dialog so the displayed content is
 * the baseline.
 */
async function loadBaselines(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	ids: string[],
): Promise<Map<string, string>> {
	const view = new Map<string, string>();
	if (ids.length === 0) return view;
	const fresh = rowsToBaselineView(
		await kernel.query(baselineContentsStmt(ids)),
	);
	for (const row of fresh) {
		const served = baselines.servedHash(row.blockId);
		view.set(row.blockId, served ?? contentHash(row.content));
	}
	return view;
}

/**
 * §4 precondition, re-checked after confirmation approval, before any kernel
 * write: the current content must still hash to the baseline. A mismatch →
 * `stale_content` refusal with the current content and fresh outline, no
 * kernel write fired (the message names the re-read path, never a retry).
 */
async function assertFreshContent(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	targets: { blockId: string; baseline: string | undefined }[],
	context: { sessionId: string; docId: string } | undefined,
): Promise<Envelope | null> {
	if (targets.length === 0) return null;
	// Raw current content — never through the served-preference read: the
	// precondition compares the kernel's NOW against the baseline.
	const currentRows = await kernel.query(
		baselineContentsStmt(targets.map((t) => t.blockId)),
	);
	const current = new Map(
		rowsToBaselineView(currentRows).map((r) => [r.blockId, r.content]),
	);
	for (const target of targets) {
		const nowContent = current.get(target.blockId);
		if (nowContent === undefined) continue; // vanished target → delete no-op class
		if (contentHash(nowContent) !== target.baseline) {
			const currentContent = nowContent;
			// The refusal payload serves the new content — it becomes the
			// baseline, so the agent's re-read/re-target doesn't refuse-loop.
			baselines.remember(target.blockId, currentContent);
			let outline: Record<string, unknown> = {};
			if (context !== undefined) {
				const fresh = renderOutlineFromWalk(
					context.sessionId,
					"kb_write",
					await walkBlockTree(kernel, context.docId, 1),
				);
				outline = {
					outline: fresh.outline,
					...(fresh.fullOutlinePath !== undefined
						? { fullOutlinePath: fresh.fullOutlinePath }
						: {}),
				};
			}
			return refusedEnvelope(
				`the content of block '${target.blockId}' changed since it was last seen in this session — re-read the current state with kb_read, then re-target (reason: stale_content)`,
				{
					reason: "stale_content",
					blockId: target.blockId,
					currentContent,
					...outline,
				},
			);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Write-result contract (§4) — echoes + verification evidence
// ---------------------------------------------------------------------------

/** `data[0].doOperations[0].id` — the pinned response shape (§4 write-result
 * contract; the minted ID serializes as the first insert operation's id). */
export function newBlockIdFrom(tx: BlockTransaction[]): string | undefined {
	return tx[0]?.doOperations[0]?.id;
}

const REFS_BACKLINK_STMT_HEAD =
	"SELECT DISTINCT root_id FROM refs WHERE def_block_id IN";

function refsBacklinkStmt(ids: string[]): string {
	return `${REFS_BACKLINK_STMT_HEAD} (${ids.map(sqlString).join(", ")})`;
}

/** A nested doc's parent doc id (type='d' rows chain via parent_id) — the
 * doc-level self-descendant pre-check walks this. */
function parentDocStmt(docId: string): string {
	return `SELECT parent_id FROM blocks WHERE id = ${sqlString(docId)} AND type = 'd'`;
}

/** Referring docs' display paths — the confirmation's "who cites this" list. */
function referringHpathsStmt(rootIds: string[]): string {
	return (
		`SELECT DISTINCT hpath FROM blocks WHERE root_id IN ` +
		`(${rootIds.map(sqlString).join(", ")})`
	);
}

/** Inbound block-refs over the delete set (§4 delete mode) — same documented
 * SQL surface as every read; the count is advisory (the derived refs index
 * can lag, §9). */
async function backlinkCheck(
	kernel: WriteKernelClient,
	ids: string[],
): Promise<{ count: number; hpaths: string[] }> {
	if (ids.length === 0) return { count: 0, hpaths: [] };
	const rows = await kernel.query(refsBacklinkStmt(ids));
	const rootIds = [...new Set(rows.map((r) => String(r.root_id)))];
	if (rootIds.length === 0) return { count: 0, hpaths: [] };
	const hpathRows = await kernel.query(referringHpathsStmt(rootIds));
	return {
		count: rootIds.length,
		hpaths: hpathRows.map((r) => String(r.hpath)),
	};
}

/** Root row echo (§4 write-result contract): root docId + stored title +
 * real hpath — display plus the echoed target R1 requires. */
async function rootEcho(
	kernel: WriteKernelClient,
	boxId: string,
	docId: string,
): Promise<{ docId: string; title: string; hpath: string } | undefined> {
	const rows = await kernel.query(rootEchoStmt(boxId, docId));
	const row = rows[0];
	return row === undefined
		? undefined
		: {
				docId: String(row.root_id),
				title: String(row.content),
				hpath: String(row.hpath),
			};
}

function rootEchoStmt(boxId: string, docId: string): string {
	return (
		`SELECT root_id, content, hpath FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(docId)} AND type = 'd'`
	);
}

/** Ownership query (§4): resolves the docId's root within the KB — doubles
 * as the scope check (an id from another KB matches no row). */
function ownershipStmt(boxId: string, docId: string): string {
	return (
		`SELECT root_id FROM blocks WHERE id = ${sqlString(docId)}` +
		` AND box = ${sqlString(boxId)}`
	);
}

/** The unfiltered post-write walk (§4 stale-target record) — evidence for
 * insert/move/delete verification. */
async function walkIdSet(
	kernel: WriteKernelClient,
	docId: string,
): Promise<WalkedBlock[]> {
	return walkBlockTree(kernel, docId, 1);
}

function idSet(walk: WalkedBlock[]): Set<string> {
	return new Set(walk.map((b) => b.id));
}

/** Fresh outline + root echo + content-baseline refresh — the tail every
 * doc-targeting result shares (§4 write-result contract). One full
 * unfiltered walk; a pre-fetched walk (the verification evidence the flow
 * already holds) is reused instead of re-traversing. */
async function writeEchoTail(input: {
	kernel: WriteKernelClient;
	sessionId: string;
	boxId: string;
	docId: string;
	baselines: ContentBaselines;
	walk?: WalkedBlock[];
}): Promise<{
	walk: WalkedBlock[];
	envelope: Record<string, unknown>;
}> {
	const { kernel, sessionId, boxId, docId, baselines } = input;
	const walk = input.walk ?? (await walkBlockTree(kernel, docId, 1));
	const outline = renderOutlineFromWalk(sessionId, "kb_write", walk);
	const root = await rootEcho(kernel, boxId, docId);
	const envelope: Record<string, unknown> = { outline: outline.outline };
	if (outline.fullOutlinePath !== undefined) {
		envelope.fullOutlinePath = outline.fullOutlinePath;
	}
	if (root !== undefined) {
		envelope.docId = root.docId;
		envelope.title = root.title;
		envelope.hpath = root.hpath;
	}
	// Refresh baselines for the target doc's blocks (§4: write results
	// refresh the map for blocks whose content the result carried).
	for (const block of walk) {
		baselines.remember(block.id, block.content);
	}
	return { walk, envelope };
}

// ---------------------------------------------------------------------------
// Anchors + section slicing (§4) — always tool-derived, never agent-supplied
// ---------------------------------------------------------------------------

/** `appendBlock` on the doc root — the doc-end fallback (§4 anchor echo). */
const DOC_END_ANCHOR = "appendBlock(root) — no next heading";

/**
 * `append`/replace-section anchor (§4, pinned): `nextID` = the NEXT heading
 * in document order — never a last-block or heading anchor (the list/quote
 * nesting trap, §4). The heading-only outline IS the anchor data; a walk
 * node's position decides. No next heading (target IS the last heading, or
 * no heading given) → `appendBlock` on the doc root.
 */
export function deriveAppendAnchor(
	walk: WalkedBlock[],
	headingId: string | undefined,
):
	| { kind: "insert"; nextID: string; anchor: string }
	| { kind: "appendRoot"; anchor: string } {
	if (headingId !== undefined) {
		const index = walk.findIndex((b) => b.id === headingId && b.type === "h");
		if (index >= 0) {
			const next = walk.slice(index + 1).find((b) => b.type === "h");
			if (next !== undefined) {
				return {
					kind: "insert",
					nextID: next.id,
					anchor: `nextID=${next.id} (next heading)`,
				};
			}
		}
	}
	return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
}

/**
 * §4 delete-set enumeration — the getChildBlocks document-order walk, never
 * SQL (§3's superseded-outline record). The section slice runs from the
 * target heading to the next heading of same-or-shallower depth; the target
 * heading itself survives (the new body lands under it, preserving its ID
 * and every ref into it). Deeper headings inside the section belong to it.
 * Final section (no boundary): the slice runs to end of doc, sweeping
 * trailing non-heading content (§4's final-section pin).
 */
export function sectionDeleteSet(
	walk: WalkedBlock[],
	headingId: string,
): WalkedBlock[] {
	const target = walk.find((b) => b.id === headingId && b.type === "h");
	if (target === undefined) return []; // caller refuses an unresolvable target
	const targetIndex = walk.indexOf(target);
	const targetLevel = Number(String(target.subType).slice(1)) || 1;
	const slice: WalkedBlock[] = [];
	for (let i = targetIndex + 1; i < walk.length; i++) {
		const block = walk[i];
		if (block === undefined) break;
		if (block.type === "h") {
			const level = Number(String(block.subType).slice(1)) || 1;
			if (level <= targetLevel) break; // same-or-shallower boundary
		}
		slice.push(block);
	}
	return slice;
}

/**
 * §4 move anchor: the last top-level node of the toHeadingId section,
 * heading-recursed (a section ending in a subheading → after the
 * subsection, not inside it); list/quote containers end at section level —
 * the walk's depth axis never descends INTO a container for this choice.
 * Fold-state independent by construction: derived from walk order, never
 * from the kernel's folded-heading branch. Falls back to doc end (the same
 * `appendBlock`-on-root default as `append`).
 */
export function deriveMoveAnchor(
	destWalk: WalkedBlock[],
	toHeadingId: string | undefined,
):
	| { kind: "move"; previousID: string; anchor: string }
	| { kind: "appendRoot"; anchor: string } {
	if (toHeadingId === undefined) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const headingIndex = destWalk.findIndex(
		(b) => b.id === toHeadingId && b.type === "h",
	);
	if (headingIndex < 0) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const heading = destWalk[headingIndex];
	if (heading === undefined) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const headingDepth = heading.depth;
	const headingLevel = Number(String(heading.subType).slice(1)) || 1;
	// Section members after the heading until the same-or-shallower boundary.
	const members: WalkedBlock[] = [];
	for (let i = headingIndex + 1; i < destWalk.length; i++) {
		const block = destWalk[i];
		if (block === undefined) break;
		if (block.type === "h") {
			const level = Number(String(block.subType).slice(1)) || 1;
			if (level <= headingLevel) break;
		}
		members.push(block);
	}
	// Last member at the heading's own container depth — recursing through a
	// subheading's section (its content sits at the same walk depth), never
	// into a list/quote container (deeper blocks are skipped by the depth
	// test, so the anchor stays at section level, §4).
	let anchor: WalkedBlock | undefined;
	for (let i = members.length - 1; i >= 0; i--) {
		const member = members[i];
		if (member !== undefined && member.depth <= headingDepth) {
			anchor = member;
			break;
		}
	}
	if (anchor === undefined) {
		// Empty section: the heading itself is the last top-level node —
		// after-heading placement IS end-of-section there, and the fold
		// branch has nothing to jump past.
		return {
			kind: "move",
			previousID: heading.id,
			anchor: `previousID=${heading.id} (end of section)`,
		};
	}
	if (anchor.type === "h") {
		// Section ends in a subheading: step into it — its section's last
		// top-level node is the anchor (§4 heading-recursed rule).
		return deriveMoveAnchor(destWalk, anchor.id);
	}
	return {
		kind: "move",
		previousID: anchor.id,
		anchor: `previousID=${anchor.id} (end of section)`,
	};
}

// ---------------------------------------------------------------------------
// Delete-set display (§4) — confirmation shows what a delete-bearing write
// orphans: block count, the trailing blocks' current content, inbound refs
// ---------------------------------------------------------------------------

const DELETE_SET_PREVIEW_CHARS = 2000;

async function deleteSetDisplay(
	kernel: WriteKernelClient,
	sessionId: string,
	deleteSet: { id: string; content: string }[],
): Promise<{
	deleteSet: { count: number; contentPreview: string };
	backlinks: { count: number; hpaths: string[] };
}> {
	const content = deleteSet.map((b) => b.content).join("\n---\n");
	let contentPreview = content;
	if (content.length > DELETE_SET_PREVIEW_CHARS) {
		const path = spillFile(sessionId, "kb_write-delete-set", content, "md");
		let cut = content.lastIndexOf("\n", DELETE_SET_PREVIEW_CHARS);
		if (cut <= 0) cut = DELETE_SET_PREVIEW_CHARS;
		contentPreview = `${content.slice(0, cut)}\n… full delete-set content in ${path}`;
	}
	return {
		deleteSet: { count: deleteSet.length, contentPreview },
		backlinks: await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		),
	};
}

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
// Remaining write modes (§4) — edit / append / replace-section / delete /
// move. Shared scaffolding: mode-target shape → preflight (zero kernel
// calls when denied) → doc ownership → dialog (delete-set display where
// delete-bearing) → fresh-content precondition → kernel op → verified (not
// trusted) → write-result echo.
// ---------------------------------------------------------------------------

export interface WriteFlowInput {
	sessionId: string;
	kernel: WriteKernelClient;
	validation: SessionValidation;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	params: WriteParams;
	/** Captured content body ("" on body-less modes). */
	body: string;
	hasUI: boolean;
	confirm: WriteConfirmFn;
	confirmState: WriteConfirmState;
	baselines: ContentBaselines;
}

interface DocTarget {
	rootId: string;
	title: string;
	hpath: string;
}

/** §4: every non-create mode takes docId — an echoed target, ownership-
 * checked by the same scoping query (an id from another KB reads as
 * nothing). */
async function resolveDocTarget(
	kernel: WriteKernelClient,
	boxId: string,
	name: string,
	docId: string,
): Promise<DocTarget | Envelope> {
	const rows = await kernel.query(ownershipStmt(boxId, docId));
	const rootId = rows[0] === undefined ? undefined : String(rows[0].root_id);
	if (rootId === undefined) {
		return errorEnvelope(
			`no doc '${docId}' in KB '${name}' — docIds are echoed root_id values from kb_query/kb_search/kb_read/write results; an ID from another KB reads as nothing`,
		);
	}
	const root = await rootEcho(kernel, boxId, rootId);
	if (root === undefined) {
		return errorEnvelope(
			`doc '${docId}' has no type='d' root row in KB '${name}'`,
		);
	}
	return { rootId: root.docId, title: root.title, hpath: root.hpath };
}

/** Mode-specific target params (§4 schema table) — anything else the agent
 * sends is rejected before any kernel call. `confirmNew` is never declared
 * but always accepted at runtime (Sprint 4 decision record). */
const MODE_PARAMS: Record<string, string[]> = {
	create: ["topic", "parentId"],
	edit: ["docId", "blockId"],
	"replace-section": ["docId", "headingId"],
	append: ["docId", "headingId"],
	delete: ["docId", "blockId", "doc"],
	move: ["docId", "blockId", "doc", "toDocId", "toHeadingId"],
};

const WRITE_MODE_LIST = "create, edit, replace-section, append, delete, move";

/** §4 schema-table shape validation — mode-specific targets, zero kernel
 * calls. */
export function modeShapeProblem(p: WriteParams): string | undefined {
	const mode = p.mode;
	const allowed = MODE_PARAMS[mode];
	if (allowed === undefined) {
		return `mode '${String(mode)}' is not supported — supported modes: ${WRITE_MODE_LIST}`;
	}
	const base = new Set(["kb", "mode", "markdown", "markdownFile"]);
	const unexpected = Object.keys(p).filter(
		(k) =>
			!base.has(k) &&
			k !== "confirmNew" &&
			!allowed.includes(k) &&
			(p as Record<string, unknown>)[k] !== undefined,
	);
	if (unexpected.length > 0) {
		return `mode '${mode}' does not take: ${unexpected.join(", ")}`;
	}
	// §4 schema-table split: content-bearing modes take markdown XOR
	// markdownFile; delete/move carry neither (a sent body is a mistake,
	// never silently ignored).
	if (!CONTENT_BEARING_MODES.has(mode)) {
		const bodies = ["markdown", "markdownFile"].filter(
			(k) => (p as Record<string, unknown>)[k] !== undefined,
		);
		if (bodies.length > 0) {
			return `mode '${mode}' does not take: ${bodies.join(", ")}`;
		}
	}
	if (mode === "create") {
		return p.topic === undefined
			? 'mode "create" requires topic (a title)'
			: undefined;
	}
	if (p.docId === undefined) {
		return `mode '${mode}' requires docId — an echoed root_id target`;
	}
	switch (mode) {
		case "edit":
			return p.blockId === undefined
				? "mode 'edit' requires blockId — an echoed block ID"
				: undefined;
		case "replace-section":
			return p.headingId === undefined
				? "mode 'replace-section' requires headingId — a heading block ID from the outline"
				: undefined;
		case "append":
			return undefined; // headingId optional → doc end
		case "delete":
		case "move":
			if ((p.blockId !== undefined) === (p.doc === true)) {
				return `mode '${mode}' requires exactly one of blockId or doc: true`;
			}
			if (mode === "move" && p.doc === true && p.toHeadingId !== undefined) {
				return "toHeadingId is block-level only — doc-level moves take docId + doc: true + optional toDocId";
			}
			if (mode === "move" && p.doc !== true && p.toDocId === undefined) {
				return "block-level move requires toDocId — the destination doc (same-doc moves name the source docId)";
			}
			return undefined;
		default:
			return undefined;
	}
}

/** Preflight summary — params only; the detailed dialog text is built after
 * ownership resolution (preflight must stay zero-kernel-call). */
function writeModeSummary(p: WriteParams): string {
	const doc = p.docId ?? "-";
	switch (p.mode) {
		case "edit":
			return `Edit block ${p.blockId} in doc ${doc}`;
		case "append":
			return `Append to doc ${doc}${p.headingId === undefined ? " at doc end" : ` under heading ${p.headingId}`}`;
		case "replace-section":
			return `Replace the section under heading ${p.headingId} in doc ${doc}`;
		case "delete":
			return p.doc === true
				? `Delete doc ${doc}`
				: `Delete block ${p.blockId} in doc ${doc}`;
		case "move":
			return p.doc === true
				? `Move doc ${doc} to ${p.toDocId ?? "the notebook root"}`
				: `Move block ${p.blockId} to doc ${p.toDocId}`;
		default:
			return `${String(p.mode)} write in doc ${doc}`;
	}
}

/** Dispatch point for the non-create modes. */
export async function runWriteMode(input: WriteFlowInput): Promise<Envelope> {
	const problem = modeShapeProblem(input.params);
	if (problem !== undefined) return refusedEnvelope(problem);
	const mode = input.params.mode;
	const confirmKey = writeConfirmKey([
		input.name,
		mode,
		input.params.docId,
		input.params.blockId,
		input.params.headingId,
		input.params.doc === true ? "doc" : undefined,
		input.params.toDocId,
		input.params.toHeadingId,
	]);
	// Pre-dialog permission (§5) before ANY kernel call — a denied write
	// costs zero round-trips, same posture as create.
	const preflight = preflightWrite({
		hasUI: input.hasUI,
		allowUnattendedWrites: input.validation.settings?.allowUnattendedWrites,
		state: input.confirmState,
		key: confirmKey,
		summary: writeModeSummary(input.params),
	});
	if (!preflight.ok) return preflight.envelope;
	const target = await resolveDocTarget(
		input.kernel,
		input.boxId,
		input.name,
		input.params.docId as string,
	);
	if ("status" in target) return target;
	switch (mode) {
		case "edit":
			return runEditMode(input, target, preflight.dialog, confirmKey);
		case "append":
			return runAppendMode(input, target, preflight.dialog, confirmKey);
		case "replace-section":
			return runReplaceSectionMode(input, target, preflight.dialog, confirmKey);
		case "delete":
			return runDeleteMode(input, target, preflight.dialog, confirmKey);
		case "move":
			return runMoveMode(input, target, preflight.dialog, confirmKey);
		default:
			return errorEnvelope(`internal: unhandled write mode '${mode}'`);
	}
}

async function confirmGate(
	input: WriteFlowInput,
	confirmKey: string,
	summary: string,
): Promise<Envelope | null> {
	return confirmWrite({
		confirm: input.confirm,
		writeConfirmTimeout: input.validation.settings?.writeConfirmTimeout,
		state: input.confirmState,
		key: confirmKey,
		summary,
	});
}

function blockInDocStmt(docId: string, blockId: string): string {
	return (
		`SELECT id, content FROM blocks WHERE id = ${sqlString(blockId)}` +
		` AND root_id = ${sqlString(docId)}`
	);
}

// --- edit (§4: updateBlock on an agent-supplied blockId target) -----------

async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, baselines, params } = input;
	const blockId = params.blockId as string;
	const rows = await kernel.query(blockInDocStmt(doc.rootId, blockId));
	if (rows[0] === undefined) {
		return errorEnvelope(
			`no block '${blockId}' in doc '${doc.title}' (${doc.rootId}) — targets are echoed block IDs; re-fetch the outline (kb_read) or a kb_query row, then re-target`,
		);
	}
	// Fresh-content baseline (§4): served content where the session has seen
	// this block, else the block's CURRENT content — displayed in the
	// confirmation; approval establishes it.
	await loadBaselines(kernel, baselines, [blockId]);
	const summary =
		`Edit block ${blockId} in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
		`current content:\n${String(rows[0].content)}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	if (baselines.servedHash(blockId) === undefined) {
		baselines.remember(blockId, String(rows[0].content));
	}
	// Precondition: re-check after approval, before the kernel call (§4).
	const stale = await assertFreshContent(
		kernel,
		baselines,
		[{ blockId, baseline: baselines.servedHash(blockId) }],
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	try {
		await kernel.updateBlock({ id: blockId, data: input.body });
	} catch (err) {
		// §4 stale-target record: updateBlock errors synchronously — surface
		// verbatim with the fresh outline attached. Auth/rate-limit/network
		// classes rethrow for runKbCall's classification.
		if (!(err instanceof SiYuanApiError)) throw err;
		const tail = await writeEchoTail({
			kernel,
			sessionId,
			boxId,
			docId: doc.rootId,
			baselines,
		});
		return errorEnvelope(err.message, { kb: name, ...tail.envelope });
	}
	const tail = await writeEchoTail({
		kernel,
		sessionId,
		boxId,
		docId: doc.rootId,
		baselines,
	});
	return {
		status: "ok",
		message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
		kb: name,
		...tail.envelope,
	};
}

// --- append (§4: tool-derived nextID anchor; doc-end fallback) ------------

async function runAppendMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, params } = input;
	// The walk doubles as anchor data AND the pre-write set for verification
	// (§4 stale-target record: the same walk the anchor derivation fetches).
	const walk = await walkBlockTree(kernel, doc.rootId, 1);
	if (params.headingId !== undefined) {
		const heading = walk.find(
			(b) => b.id === params.headingId && b.type === "h",
		);
		if (heading === undefined) {
			return errorEnvelope(
				`headingId '${params.headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
			);
		}
	}
	const anchor = deriveAppendAnchor(walk, params.headingId);
	const summary = `Append ${input.body.length} chars to '${doc.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// §4 verified, not trusted: the returned id must appear among the
	// post-write walk set's newly-present ids — a tree-level miss rolls back
	// silently behind HTTP success. Multi-block: diff-based; single-block:
	// exactly one id (pinned live, §10).
	const newBlockId = newBlockIdFrom(tx);
	const preIds = idSet(walk);
	const postWalk = await walkIdSet(kernel, doc.rootId);
	const postIds = idSet(postWalk);
	const landed =
		newBlockId !== undefined &&
		!preIds.has(newBlockId) &&
		postIds.has(newBlockId);
	if (!landed) {
		const tail = await writeEchoTail({
			kernel,
			sessionId,
			boxId,
			docId: doc.rootId,
			baselines: input.baselines,
			walk: postWalk,
		});
		return errorEnvelope(
			`verified-append failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; nothing was inserted`,
			{ kb: name, anchor: anchor.anchor, ...tail.envelope },
		);
	}
	const tail = await writeEchoTail({
		kernel,
		sessionId,
		boxId,
		docId: doc.rootId,
		baselines: input.baselines,
		walk: postWalk,
	});
	return {
		status: "ok",
		message: `appended to '${doc.title}' (KB ${name}) — newBlockId ${newBlockId as string}`,
		kb: name,
		anchor: anchor.anchor,
		newBlockId,
		...tail.envelope,
	};
}

// --- replace-section (§4: enumerate → insert → delete, one call) ----------

async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, baselines, params } = input;
	const headingId = params.headingId as string;
	// Delete-set enumeration rides the §3 document-order walk, never SQL.
	const walk = await walkBlockTree(kernel, doc.rootId, 1);
	const heading = walk.find((b) => b.id === headingId && b.type === "h");
	if (heading === undefined) {
		return errorEnvelope(
			`headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
		);
	}
	const deleteSet = sectionDeleteSet(walk, headingId);
	// §4: the confirmation displays the enumerated delete set — block count,
	// the trailing blocks' current content (spill budget applies), and the
	// same backlink visibility `delete` carries.
	const display = await deleteSetDisplay(kernel, sessionId, deleteSet);
	const summary =
		`Replace the section under heading '${heading.content}' in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
		`delete set: ${display.deleteSet.count} block(s)\n\n` +
		`current content:\n${display.deleteSet.contentPreview}\n\n` +
		`inbound refs: ${display.backlinks.count}` +
		(display.backlinks.count > 0
			? ` from: ${display.backlinks.hpaths.join(", ")} — replacing orphans refs into the section's content blocks (the heading ID survives)`
			: "");
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	// Fresh-content precondition (§4): approval establishes the baseline for
	// never-served delete-set blocks; then re-check before any kernel call.
	for (const block of deleteSet) {
		if (baselines.servedHash(block.id) === undefined) {
			baselines.remember(block.id, block.content);
		}
	}
	const stale = await assertFreshContent(
		kernel,
		baselines,
		deleteSet.map((b) => ({
			blockId: b.id,
			baseline: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// insert-before-delete (§4): a mid-sequence failure must cost visible
	// duplication, never loss. Same anchor rule as `append`.
	const anchor = deriveAppendAnchor(walk, headingId);
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	const newBlockId = newBlockIdFrom(tx);
	// Verify the insert landed BEFORE any delete — a silent rollback must not
	// sweep the old section away (§4 stale-target record).
	const preIds = idSet(walk);
	const afterInsertWalk = await walkIdSet(kernel, doc.rootId);
	const landed =
		newBlockId !== undefined &&
		!preIds.has(newBlockId) &&
		idSet(afterInsertWalk).has(newBlockId);
	if (!landed) {
		return errorEnvelope(
			`verified-insert failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; the old section is untouched`,
			{ kb: name, anchor: anchor.anchor },
		);
	}
	// Deletes ride the pre-enumerated set — a post-insert re-enumeration
	// would sweep the replacement into the delete set (§4).
	for (const block of deleteSet) {
		await kernel.deleteBlock(block.id);
	}
	// invalidRefs (§4 write-result contract): post-write echo over the
	// enumerated delete set — what actually got orphaned, verified.
	const invalidRefs = await backlinkCheck(
		kernel,
		deleteSet.map((b) => b.id),
	);
	// The echo tail re-walks AFTER the deletes: the post-insert walk still
	// carries the swept blocks, and the outline-freshness contract requires
	// the post-write tree (§4 write-result contract).
	const tail = await writeEchoTail({
		kernel,
		sessionId,
		boxId,
		docId: doc.rootId,
		baselines,
	});
	return {
		status: "ok",
		message: `replaced the section under heading '${heading.content}' in '${doc.title}' (KB ${name}) — delete set ${deleteSet.length} block(s), ${invalidRefs.count} orphaned ref(s)`,
		kb: name,
		anchor: anchor.anchor,
		newBlockId,
		invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
		...tail.envelope,
	};
}

// --- delete (§4: block-level deleteBlock; doc-level removeDocByID) --------

async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, params } = input;
	if (params.doc === true) {
		// Whole-doc delete: the delete set is the §4 walk set; backlink
		// visibility rides the confirmation (§4 delete mode).
		const walk = await walkBlockTree(kernel, doc.rootId, 1);
		const display = await deleteSetDisplay(kernel, sessionId, walk);
		const summary =
			`Delete doc '${doc.title}' (${doc.rootId}) in KB ${name}\n\n` +
			`delete set: ${display.deleteSet.count} block(s)\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			`inbound refs: ${display.backlinks.count}` +
			(display.backlinks.count > 0
				? ` from: ${display.backlinks.hpaths.join(", ")}`
				: "");
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		await kernel.removeDocByID(doc.rootId);
		// invalidRefs rides the pre-delete walk set — the doc is gone (§4).
		const invalidRefs = await backlinkCheck(
			kernel,
			walk.map((b) => b.id),
		);
		// Pinned shape: only invalidRefs — no doc left to outline (§4).
		return {
			status: "ok",
			message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} orphaned ref(s)`,
			kb: name,
			invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
		};
	}
	const blockId = params.blockId as string;
	const rows = await kernel.query(blockInDocStmt(doc.rootId, blockId));
	if (rows[0] === undefined) {
		return errorEnvelope(
			`no block '${blockId}' in doc '${doc.title}' (${doc.rootId}) — targets are echoed block IDs; re-fetch the outline (kb_read) or a kb_query row, then re-target`,
		);
	}
	const display = await deleteSetDisplay(kernel, sessionId, [
		{ id: blockId, content: String(rows[0].content) },
	]);
	const summary =
		`Delete block ${blockId} in '${doc.title}' (KB ${name})\n\n` +
		`current content:\n${String(rows[0].content)}\n\n` +
		`inbound refs: ${display.backlinks.count}` +
		(display.backlinks.count > 0
			? ` from: ${display.backlinks.hpaths.join(", ")}`
			: "");
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	await kernel.deleteBlock(blockId);
	// Verified, not trusted (§4): a missing ID is a kernel success no-op —
	// the walk-set evidence (target gone) is the report, never assumed.
	const postWalk = await walkIdSet(kernel, doc.rootId);
	const targetGone = !idSet(postWalk).has(blockId);
	const invalidRefs = await backlinkCheck(kernel, [blockId]);
	const tail = await writeEchoTail({
		kernel,
		sessionId,
		boxId,
		docId: doc.rootId,
		baselines: input.baselines,
		walk: postWalk,
	});
	return {
		status: "ok",
		message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${targetGone ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} orphaned ref(s)`,
		kb: name,
		blockId,
		targetGone,
		invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
		...tail.envelope,
	};
}

// --- move (§4: block-level moveBlock with tool-derived anchors;
//        doc-level moveDocsByID) -------------------------------------------

/** §4 doc-level self-descendant pre-check: walk the destination's ancestor
 * chain over type='d' rows; the source appearing means the destination is
 * the source or one of its nested descendants — the kernel silently filters
 * exactly that move (success, zero moves). Rejected here, never forwarded.
 * ponytail: assumes nested docs chain via parent_id on 'd' rows; if a
 * kernel change breaks the chain only the direct self-move is caught —
 * upgrade if 5b's live pin ever goes red on a nested case. */
async function isOwnDescendant(
	kernel: WriteKernelClient,
	sourceRootId: string,
	destId: string,
): Promise<boolean> {
	let current: string | undefined = destId;
	for (
		let hops = 0;
		current !== undefined && current !== "" && hops < 16;
		hops++
	) {
		if (current === sourceRootId) return true;
		const rows = await kernel.query(parentDocStmt(current));
		const parent =
			rows[0] === undefined ? undefined : String(rows[0].parent_id ?? "");
		current = parent === "" || parent === current ? undefined : parent;
	}
	return false;
}

/** Cross-doc block move's `destOutline` (§4 write-result contract): fresh
 * destination outline fetched after the move lands. */
async function destOutlinePayload(
	sessionId: string,
	destWalk: WalkedBlock[],
): Promise<Record<string, unknown>> {
	const outline = renderOutlineFromWalk(sessionId, "kb_write-dest", destWalk);
	return outline.fullOutlinePath === undefined
		? { destOutline: outline.outline }
		: {
				destOutline: outline.outline,
				destFullOutlinePath: outline.fullOutlinePath,
			};
}

async function runMoveMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, params } = input;
	if (params.doc === true) {
		// Doc-level move (§4): moveDocsByID — destination doc or the notebook
		// id (un-nest). Intra-KB by construction (single-kb write contract).
		let destId = boxId;
		let destLabel = "the notebook root";
		if (params.toDocId !== undefined) {
			const dest = await resolveDocTarget(kernel, boxId, name, params.toDocId);
			if ("status" in dest) return dest;
			destId = dest.rootId;
			destLabel = `'${dest.title}' (${dest.rootId})`;
		}
		if (destId === doc.rootId) {
			return refusedEnvelope(
				`cannot move doc '${doc.title}' (${doc.rootId}) into itself — choose a destination outside the doc's own subtree`,
			);
		}
		if (await isOwnDescendant(kernel, doc.rootId, destId)) {
			return refusedEnvelope(
				`destination ${destLabel} is inside doc '${doc.title}''s own subtree — the kernel silently filters such moves; choose a destination outside the subtree`,
			);
		}
		const summary = `Move doc '${doc.title}' (${doc.rootId}) to ${destLabel} (KB ${name})`;
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		try {
			await kernel.moveDocsByID({ fromIDs: [doc.rootId], toID: destId });
		} catch (err) {
			// The 7-level depth cap and other kernel rejections surface
			// verbatim (§4 doc-level record).
			if (!(err instanceof SiYuanApiError)) throw err;
			return errorEnvelope(err.message, { kb: name, docId: doc.rootId });
		}
		const tail = await writeEchoTail({
			kernel,
			sessionId,
			boxId,
			docId: doc.rootId,
			baselines: input.baselines,
		});
		// Pinned shape: outline + title/hpath echo, no anchor/newBlockId/
		// destOutline (§4 doc-level record).
		return {
			status: "ok",
			message: `moved doc '${doc.title}' to ${destLabel} (KB ${name})`,
			kb: name,
			...tail.envelope,
		};
	}
	const blockId = params.blockId as string;
	const rows = await kernel.query(blockInDocStmt(doc.rootId, blockId));
	if (rows[0] === undefined) {
		return errorEnvelope(
			`no block '${blockId}' in doc '${doc.title}' (${doc.rootId}) — targets are echoed block IDs; re-fetch the outline (kb_read) or a kb_query row, then re-target`,
		);
	}
	const dest = await resolveDocTarget(
		kernel,
		boxId,
		name,
		params.toDocId as string,
	);
	if ("status" in dest) return dest;
	const sameDoc = dest.rootId === doc.rootId;
	// Destination outline (§4): cross-doc fetches the destination walk;
	// same-doc derives from the already-in-hand source walk — no extra call.
	const sourceWalk = await walkBlockTree(kernel, doc.rootId, 1);
	const destWalk = sameDoc
		? sourceWalk
		: await walkBlockTree(kernel, dest.rootId, 1);
	if (params.toHeadingId !== undefined) {
		const heading = destWalk.find(
			(b) => b.id === params.toHeadingId && b.type === "h",
		);
		if (heading === undefined) {
			return errorEnvelope(
				`toHeadingId '${params.toHeadingId}' is not a heading of destination doc '${dest.title}' (${dest.rootId}) — stale or foreign target; re-fetch the destination outline (kb_read) and re-target`,
			);
		}
	}
	// Anchor (§4): tool-derived, never agent-supplied.
	const anchor = deriveMoveAnchor(destWalk, params.toHeadingId);
	const summary = `Move block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	if (anchor.kind === "appendRoot") {
		await kernel.moveBlock({ id: blockId, parentID: dest.rootId });
	} else {
		await kernel.moveBlock({ id: blockId, previousID: anchor.previousID });
	}
	// Verified, not trusted (§4): a tree-level miss rolls back silently
	// behind HTTP success — movedBlockId must appear in the destination's
	// post-move walk set (and, cross-doc, be gone from the source's).
	const postSourceWalk = await walkIdSet(kernel, doc.rootId);
	const postDestWalk = sameDoc
		? postSourceWalk
		: await walkIdSet(kernel, dest.rootId);
	const movedInDest = idSet(postDestWalk).has(blockId);
	const movedGoneFromSource = sameDoc || !idSet(postSourceWalk).has(blockId);
	const destPayload = sameDoc
		? {}
		: await destOutlinePayload(sessionId, postDestWalk);
	if (!movedInDest || !movedGoneFromSource) {
		const srcTail = await writeEchoTail({
			kernel,
			sessionId,
			boxId,
			docId: doc.rootId,
			baselines: input.baselines,
			walk: postSourceWalk,
		});
		return errorEnvelope(
			`verified-move failed: block '${blockId}' is ${movedInDest ? "still present in the source tree" : "absent from the destination tree"} — the transaction rolled back silently behind HTTP success`,
			{
				kb: name,
				anchor: anchor.anchor,
				...srcTail.envelope,
				...destPayload,
			},
		);
	}
	const srcTail = await writeEchoTail({
		kernel,
		sessionId,
		boxId,
		docId: doc.rootId,
		baselines: input.baselines,
		walk: postSourceWalk,
	});
	return {
		status: "ok",
		message: `moved block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})`,
		kb: name,
		anchor: anchor.anchor,
		movedBlockId: blockId,
		...srcTail.envelope,
		...destPayload,
	};
}

// ---------------------------------------------------------------------------
// Write toolset (§5 tool-masking record) — Sprint 5
// ---------------------------------------------------------------------------

export const WRITE_TOOLSET_ID = "gnubrain.write";
export const WRITE_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.write";

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

const WRITE_DESCRIPTION = `Write to a GNUbrain knowledge base. Modes: create — mint a new doc by title (topic), optionally nested under an echoed parentId; edit — updateBlock on a blockId target (the outline carries heading IDs only; non-heading block IDs come from kb_query rows); replace-section — swap a section's body in one call (the enumerated delete set rides the confirmation; the heading ID survives); append — insert new content under a heading (omitted headingId → doc end; the anchor is always tool-derived); delete — a block, or a whole doc with doc: true; move — block-level (toDocId + optional toHeadingId) or doc-level (doc: true; omitted toDocId → notebook root).

Doctrine: mint by title (kernel-normalized); discover by query/search; consume by ID. Targets (docId/blockId/headingId) are agent-supplied echoed values from kb_query/kb_search/kb_read/write results — never invented; anchors are always tool-derived — never agent-supplied. Replace-first: prefer edit/replace-section over append — append is for genuinely new facts. The body travels via markdown (inline) XOR markdownFile (path to a prepared markdown file; read once at call start) on create/edit/replace-section/append; delete/move carry neither. The title guard stops exact/near matches on create and returns the existing docs (docId, outline, spilled markdown) — reconcile by docId, or mint a conscious duplicate with confirmNew: true (you learn this exit from the rejection; do not pass it preemptively). Every write is confirmed with the user unless the session is headless with allowUnattendedWrites: true. The discovery name 'kbs' is read-only; writes always target a real KB by name.`;

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
	docId: Type.Optional(
		Type.String({
			description:
				'echoed docId (root_id) — the doc every non-create mode targets; also the block-level move destination via toDocId-like reuse on mode "move"',
		}),
	),
	blockId: Type.Optional(
		Type.String({
			description:
				'echoed block ID — the target of mode "edit"; XOR doc: true on delete/move',
		}),
	),
	headingId: Type.Optional(
		Type.String({
			description:
				'heading block ID from the outline — mode "replace-section" (required); mode "append" (optional, omitted → doc end)',
		}),
	),
	doc: Type.Optional(
		Type.Boolean({
			description:
				'whole-doc targeting — mode "delete" (removeDocByID) or mode "move" (moveDocsByID); XOR blockId',
		}),
	),
	toDocId: Type.Optional(
		Type.String({
			description:
				'destination docId for mode "move" — block-level (required) or doc-level (optional, omitted → notebook root / un-nest)',
		}),
	),
	toHeadingId: Type.Optional(
		Type.String({
			description:
				'destination heading for block-level mode "move" — omitted → destination doc end; the anchor itself is always tool-derived',
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
					const flowBase = {
						sessionId: ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						name,
						boxId,
						body: body ?? "",
						confirm:
							hooks.confirm ??
							((title, message, opts) => ctx.ui.confirm(title, message, opts)),
						hasUI: hooks.hasUI ?? ctx.hasUI,
						confirmState: hooks.confirmState,
						baselines: hooks.baselines,
					};
					if (p.mode === "create") {
						return runCreateFlow({
							...flowBase,
							title: p.topic ?? "",
							parentId: p.parentId,
							bodyFromFile: fromFile,
							confirmNew: p.confirmNew === true,
						});
					}
					// Non-create modes: runWriteMode validates the mode-specific
					// target shape (§4 schema table) before any kernel call.
					return runWriteMode({
						...flowBase,
						params: p,
					});
				},
			);
			return textResult(envelope);
		},
	});
}
