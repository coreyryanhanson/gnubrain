// Shared scaffolding for the non-create write flows: the flow input shape,
// doc-target ownership resolution, the confirmation gate, the shared target
// reads, and the delete-set display — everything the per-mode flow files
// (writeEdit/writeAppend/writeReplaceSection/writeDelete/writeMove) build on.

import {
	errorEnvelope,
	type Envelope,
	noSuchDocEnvelope,
	refusedEnvelope,
} from "./envelope.js";
import { previewAtNewline, spillFile } from "./spill.js";
import { ownershipStmt, sqlString } from "./kernel.js";
import type { WalkedBlock } from "./walk.js";
import type { ContentBaselines } from "./baselines.js";
import type { SessionValidation } from "./validation.js";
import {
	confirmWrite,
	type WriteConfirmFn,
	type WriteConfirmState,
} from "./writeConfirm.js";
import {
	backlinkCheck,
	rootEcho,
	writeEchoTail,
	type WriteKernelClient,
} from "./writeResult.js";
import type { WriteParams } from "./writeSchema.js";

/** Flow input shared by every mode, create included — one declaration so
 * the fields (and their contracts) cannot drift between create and the
 * per-mode flows. */
export interface WriteFlowBase {
	sessionId: string;
	kernel: WriteKernelClient;
	validation: SessionValidation;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	/** Captured content body ("" on body-less modes). */
	body: string;
	/** Preflight verdict from the kb_write entry: run the interactive
	 * dialog (true) or skip it for an approved unattended write (false). */
	dialog: boolean;
	/** Confirm key + dialog summary — computed once at the kb_write entry. */
	confirmInputs: { key: string; summary: string };
	confirm: WriteConfirmFn;
	confirmState: WriteConfirmState;
	baselines: ContentBaselines;
	/** Fires at the flow's first kernel call — kernel-free refusals
	 * (preflight) must not reset the breaker's consecutive count. */
	contact: () => void;
}

export interface WriteFlowInput extends WriteFlowBase {
	params: WriteParams;
}

export interface DocTarget {
	rootId: string;
	title: string;
	hpath: string;
}

/** Every non-create mode takes docId — an echoed target, ownership-
 * checked by the same scoping query (an id from another KB reads as
 * nothing). */
export async function resolveDocTarget(
	kernel: WriteKernelClient,
	boxId: string,
	name: string,
	docId: string,
): Promise<DocTarget | Envelope> {
	const rows = await kernel.query(ownershipStmt(boxId, docId));
	const rootId = rows[0] === undefined ? undefined : String(rows[0].root_id);
	if (rootId === undefined) {
		return noSuchDocEnvelope(name, docId);
	}
	const root = await rootEcho(kernel, boxId, rootId);
	if (root === undefined) {
		return errorEnvelope(
			`doc '${docId}' has no type='d' root row in KB '${name}'`,
		);
	}
	return { rootId: root.docId, title: root.title, hpath: root.hpath };
}

export async function confirmGate(
	input: WriteFlowBase,
	summary: string,
): Promise<Envelope | null> {
	return confirmWrite({
		confirm: input.confirm,
		writeConfirmTimeout: input.validation.settings?.writeConfirmTimeout,
		state: input.confirmState,
		key: input.confirmInputs.key,
		summary,
	});
}

/** SELECT heads the kernel stubs route on — keep builders and heads in
 * sync by construction (each builder concatenates its head constant). */
export const BLOCK_IN_DOC_STMT_HEAD =
	"SELECT id, content, root_id FROM blocks WHERE id";
export const PARENT_DOC_STMT_HEAD = "SELECT parent_id FROM blocks";

/** The target read shared by the blockId-targeting modes — the block's
 * current content (confirmation display + fresh-content baseline), or
 * null when the id is absent from the kernel. Absence is never refused
 * here: the stale-target record pins each op's own kernel outcome
 * (edit/move surface the synchronous not-found error verbatim; delete
 * is a success no-op) and the live suite watches the kernel, not this
 * pre-read, for contract drift. A block that EXISTS but belongs to a
 * different doc (cross-doc or cross-KB — kb_query rows carry raw ids
 * across all active KBs) is refused here: the kernel mutates by raw id
 * with no doc scoping of its own, so forwarding it would write outside
 * the targeted doc, past the dialog and the fresh-content baseline
 * (the SQL cannot distinguish foreign from absent — the code compare
 * can). The TOCTOU window between this read and the kernel call is the
 * same one every precondition here accepts; post-write verification
 * walks are the backstop. */
export async function blockInDoc(
	kernel: WriteKernelClient,
	doc: DocTarget,
	blockId: string,
): Promise<{ content: string | null } | { refusal: string }> {
	const rows = await kernel.query(
		`${BLOCK_IN_DOC_STMT_HEAD} = ${sqlString(blockId)}`,
	);
	if (rows[0] === undefined) return { content: null };
	const rootId = String(rows[0].root_id ?? "");
	return rootId === doc.rootId
		? { content: String(rows[0].content) }
		: {
				refusal: `block '${blockId}' belongs to another doc (root ${rootId}), not '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
			};
}

/** The pinned rejection when a heading id is absent from the doc walk.
 * Same class as blockInDoc's foreign-block refusal: a target id that fails
 * the doc's own membership check is refused before any kernel call (doc-
 * level resolution is the `error` case — DESIGN §10's status table). */
export function headingInWalk(
	walk: WalkedBlock[],
	doc: DocTarget,
	headingId: string,
): WalkedBlock | Envelope {
	const heading = walk.find((b) => b.id === headingId && b.type === "h");
	return heading === undefined
		? refusedEnvelope(
				`headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
			)
		: heading;
}

/** writeEchoTail with the flow's fixed identity args bound — call sites
 * pass only an optional pre-fetched verification walk and the write's own
 * block IDs (only on the success paths — a write that did not land
 * refreshes nothing, or it would launder a concurrent change). */
export async function echoTail(
	input: WriteFlowInput,
	doc: DocTarget,
	walk?: WalkedBlock[] | undefined,
	refreshBlockIds?: readonly string[],
): Promise<Record<string, unknown>> {
	return writeEchoTail({
		kernel: input.kernel,
		sessionId: input.sessionId,
		boxId: input.boxId,
		docId: doc.rootId,
		baselines: input.baselines,
		walk,
		refreshBlockIds,
	});
}

// ---------------------------------------------------------------------------
// Delete-set display — confirmation shows what a delete-bearing write
// orphans: block count, the trailing blocks' current content, inbound refs
// ---------------------------------------------------------------------------

const DELETE_SET_PREVIEW_CHARS = 2000;

/** Confirmation summary line for a delete-bearing write's inbound refs —
 * one home so the wording cannot drift between delete and replace-section. */
export function backlinkSummary(display: {
	backlinks: { count: number; hpaths: string[] };
}): string {
	return (
		`inbound refs: ${display.backlinks.count}` +
		(display.backlinks.count > 0
			? ` from: ${display.backlinks.hpaths.join(", ")}`
			: "")
	);
}

export async function deleteSetDisplay(
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
		contentPreview = `${previewAtNewline(content, DELETE_SET_PREVIEW_CHARS)}\n… full delete-set content in ${path}`;
	}
	return {
		deleteSet: { count: deleteSet.length, contentPreview },
		backlinks: await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		),
	};
}
