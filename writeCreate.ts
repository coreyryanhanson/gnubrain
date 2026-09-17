// The `kb_write` create flow: title guard (exact leg, then near-match
// scan) → write confirmation → submission path from ground truth →
// verified-create by-ID asserts → echo, with guard-stop draft staging.

import { SiYuanApiError } from "siyuan-kernel-api";
import { errorEnvelope, type Envelope } from "./envelope.js";
import { spillFile } from "./spill.js";
import { rememberServedRows } from "./baselines.js";
import { rowPayload, sqlString } from "./kernel.js";
import {
	renderOutline,
	renderOutlineFromWalk,
	walkBlockTree,
	type WalkedBlock,
} from "./walk.js";
import { writeConfirmKey } from "./writeConfirm.js";
import { confirmGate, type WriteFlowBase } from "./writeFlow.js";
import {
	GUARD_NEAR_CAP,
	guardExactStmt,
	guardNearStmt,
	toGuardRows,
	type GuardRow,
} from "./writeGuard.js";
import { finishWrite } from "./writeResult.js";
import type { WriteKernelClient } from "./kernel.js";

export interface CreateFlowInput extends WriteFlowBase {
	/** Minted (normalized) title — the kb_write entry validated it. */
	title: string;
	parentId?: string | undefined;
	/** True when the body came from markdownFile — staging is skipped. */
	bodyFromFile: boolean;
	confirmNew: boolean;
}

async function duplicateStop(
	input: CreateFlowInput,
	title: string,
	rows: GuardRow[],
): Promise<Envelope> {
	const { kernel, sessionId, name } = input;
	const detailed: Record<string, unknown>[] = [];
	const walks: WalkedBlock[][] = [];
	for (const row of rows) {
		const docId = row.root_id;
		// Guard-stop evidence is presentation-only: the write never fires on
		// this path, so a candidate deleted between the guard query and these
		// reads degrades to an empty outline/excerpt (nearMatchStop's rule)
		// instead of discarding the whole duplicate stop. The strict posture
		// stays reserved for write-verification walks. One walk per row also
		// serves both the outline and (single-row) the block-ID payload —
		// never a second traversal of the same doc.
		const walk = await walkBlockTree(kernel, docId, {
			tolerateVanished: true,
		});
		walks.push(walk);
		// The stop serves heading content — seed the baselines so a follow-up
		// edit on a served heading verifies against what the agent saw here,
		// not against content read at edit time (which launders a concurrent
		// kernel-side change past the stale_content precondition).
		const outline = renderOutlineFromWalk(
			sessionId,
			"kb_write",
			walk,
			input.baselines,
		);
		let markdown = "";
		try {
			const md = await kernel.exportMarkdown(docId);
			markdown = md.content;
		} catch (err) {
			// Same vanished-candidate rule as the walk above.
			if (!(err instanceof SiYuanApiError)) throw err;
		}
		const markdownPath = spillFile(
			sessionId,
			"kb_write-candidate",
			markdown,
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
	// `edit` by blockId (step 1) — reuses the outline walk already in hand.
	if (rows.length === 1) {
		const blocks = walks[0]!.map((b) => ({
			id: b.id,
			type: b.type,
			content: b.content,
		}));
		// Same serve-time seeding as the outline above — blockIds is the
		// payload the agent is invited to edit by id (step 1).
		rememberServedRows(input.baselines, blocks);
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
		// First paragraph of each candidate: the first child block's
		// content — cheap and excerpt-only by design (near-match tier).
		let firstParagraph = "";
		try {
			const children = await kernel.getChildBlocks(row.root_id);
			firstParagraph = String(children[0]?.content ?? "");
		} catch (err) {
			// Vanished candidate mid-scan — empty excerpt, row still shown.
			// Auth/rate-limit/network rethrow for runKbCall's classification.
			if (!(err instanceof SiYuanApiError)) throw err;
			firstParagraph = "";
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

/** Guard-stop draft staging: an inline body is staged so the retry
 * travels by path (~25 tokens) instead of re-transmitting the full draft.
 * Creates that already used markdownFile stage nothing. */
function stagedEnvelope(envelope: Envelope, input: CreateFlowInput): Envelope {
	if (input.bodyFromFile) return envelope;
	const stagedPath = spillFile(input.sessionId, "draft", input.body, "md");
	envelope.stagedPath = stagedPath;
	envelope.message += ` — body staged at ${stagedPath}; retry with markdownFile: '${stagedPath}'`;
	return envelope;
}

/** SELECT heads the kernel stubs route on — keep builders and heads in sync
 * by construction (each builder concatenates its head constant). */
export const PARENT_LOOKUP_STMT_HEAD = "SELECT id, hpath, content FROM blocks";
export const VERIFIED_ROOT_STMT_HEAD =
	"SELECT id, root_id, content, hpath, updated FROM blocks";

function parentLookupStmt(boxId: string, parentId: string): string {
	return (
		`${PARENT_LOOKUP_STMT_HEAD} ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(parentId)} AND type = 'd'`
	);
}

function verifiedRootStmt(boxId: string, returnedId: string): string {
	return (
		`${VERIFIED_ROOT_STMT_HEAD} ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(returnedId)} AND type = 'd'`
	);
}

/** Verified-create re-reads: the kernel indexes a fresh doc asynchronously —
 * createDocWithMd resolves when the doc is in the tree, while its blocks
 * row lands via the async index queue (observed live even on an empty DB).
 * Exponential gaps cover the fast-index common case cheaply and tolerate a
 * busy-queue tail (~4s worst case; happy path pays nothing — only the
 * currently-false-failure case pays the extra tail). */
// ponytail: fixed table, not a backoff policy knob — a live run that
// still races past 4s is the signal to add the tree-fallback degradation
// path (getChildBlocks confirms existence for nested mints; hpath is SQL-only),
// not to extend the table again
const VERIFY_RETRY_DELAYS_MS = [150, 300, 600, 1200, 2000];

async function verifiedRoot(
	kernel: WriteKernelClient,
	boxId: string,
	returnedId: string,
): Promise<
	{ id: string; root_id: string; content: string; hpath: string } | undefined
> {
	for (let attempt = 0; ; attempt++) {
		const rows = (await kernel.query(verifiedRootStmt(boxId, returnedId))).map(
			(r) => ({
				id: String(r.id),
				root_id: String(r.root_id),
				content: String(r.content),
				hpath: String(r.hpath),
			}),
		);
		const root = rows[0];
		if (root !== undefined) return root;
		const delay = VERIFY_RETRY_DELAYS_MS[attempt];
		if (delay === undefined) return undefined;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
}

/** Confirm key + preflight summary for create — shared by the kb_write
 * entry (preflight precedes the probe gate) and the dialog so the terminal
 * confirm_timeout key can't drift. */
export function createConfirmInputs(
	name: string,
	title: string,
	bodyLen: number,
): { key: string; summary: string } {
	return {
		key: writeConfirmKey([name, "create", title]),
		summary: `Create '${title}' in KB '${name}' (${bodyLen} chars)`,
	};
}

/**
 * The `create` flow: title guard (exact leg, then near-match scan) →
 * write confirmation → submission path built from ground truth →
 * verified-create by-ID asserts → echo (root docId, stored title, real
 * hpath, fresh outline). `confirmNew: true` bypasses both guard legs; the
 * confirmation and verified-create still apply.
 */
export async function runCreateFlow(input: CreateFlowInput): Promise<Envelope> {
	const { kernel, sessionId, name, boxId } = input;
	const title = input.title;
	const { summary } = input.confirmInputs;

	// Pre-dialog permission (headless default-deny + terminal
	// confirm_timeout) already ran at the kb_write entry, before the
	// probe gate — a denied write costs zero kernel round-trips.

	// Guard — exact leg first; only an empty exact leg runs the scan.
	if (!input.confirmNew) {
		input.contact();
		const exact = toGuardRows(await kernel.query(guardExactStmt(boxId, title)));
		if (exact.length > 0) return duplicateStop(input, title, exact);
		const near = toGuardRows(await kernel.query(guardNearStmt(boxId, title)));
		if (near.length > 0) return nearMatchStop(input, title, near);
	}

	// Write confirmation — after the guard, so a stop costs no dialog.
	const gate = await confirmGate(input, summary);
	if (gate !== null) return gate;

	// Submission path from ground truth, never predicted (step 3).
	input.contact();
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

	// Post-mint reads: a network drop during verification must never read
	// as "unreachable" — the doc may already be minted (finishWrite doc).
	return finishWrite(input.name, { docId: returnedId }, async () => {
		// Verified-create (step 4): by-ID asserts on the kernel-returned root
		// ID — fail-loud on shape, never a by-title re-lookup. The bounded
		// re-read absorbs the kernel's async index lag (verifiedRoot doc).
		const root = await verifiedRoot(kernel, boxId, returnedId);
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
			input.baselines,
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
	});
}
