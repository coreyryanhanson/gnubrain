// The `kb_write` create flow: title guard (exact leg, then near-match
// scan) → write confirmation → submission path from ground truth →
// verified-create by-ID asserts → echo, with guard-stop draft staging.

import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { spillFile } from "./spill.js";
import {
	renderOutline,
	rowPayload,
	sqlString,
	walkBlockTree,
} from "./tools.js";
import type { SessionValidation } from "./validation.js";
import {
	confirmWrite,
	preflightWrite,
	writeConfirmKey,
	type WriteConfirmFn,
	type WriteConfirmState,
} from "./writeConfirm.js";
import {
	GUARD_NEAR_CAP,
	guardExactStmt,
	guardNearStmt,
	toGuardRows,
	validateMintTitle,
	type GuardRow,
} from "./writeGuard.js";
import type { WriteKernelClient } from "./writeResult.js";

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
	/** True when the body came from markdownFile — staging is skipped. */
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
	// `edit` by blockId (step 1).
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
		// First paragraph of each candidate: the first child block's
		// content — cheap and excerpt-only by design (near-match tier).
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

/** Verified-create re-reads: the kernel indexes a fresh doc asynchronously —
 * createDocWithMd resolves when the doc is in the tree, while its blocks
 * row lands via the async index queue (observed live even on an empty DB).
 * Exponential gaps cover the fast-index common case cheaply and tolerate a
 * busy-queue tail (~1s worst case; happy path pays nothing). */
// ponytail: fixed table, not a backoff policy knob — a live 5b run that
// still races past 1s is the signal to revisit the delays
const VERIFY_RETRY_DELAYS_MS = [150, 300, 600];

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

/**
 * The `create` flow: title guard (exact leg, then near-match scan) →
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

	// Pre-dialog permission: headless default-deny + terminal
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

	// Guard — exact leg first; only an empty exact leg runs the scan.
	if (!input.confirmNew) {
		const exact = toGuardRows(await kernel.query(guardExactStmt(boxId, title)));
		if (exact.length > 0) return duplicateStop(input, title, exact);
		const near = toGuardRows(await kernel.query(guardNearStmt(boxId, title)));
		if (near.length > 0) return nearMatchStop(input, title, near);
	}

	// Write confirmation — after the guard, so a stop costs no dialog.
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

	// Submission path from ground truth, never predicted (step 3).
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
