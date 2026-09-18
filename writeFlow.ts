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
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import { previewAtNewline, spillFile } from "./spill.js";
import { ownershipStmt, sqlString } from "./kernel.js";
import { TARGETABLE_CONTAINER_TYPES } from "./writeAnchors.js";
import type { WalkedBlock } from "./walk.js";
import type { ContentBaselines } from "./baselines.js";
import type { SessionValidation } from "./validation.js";
import {
	confirmWrite,
	type WriteConfirmFn,
	type WriteConfirmState,
} from "./writeConfirm.js";
import { backlinkCheck, rootEcho, writeEchoTail } from "./writeResult.js";
import type { WriteKernelClient } from "./kernel.js";
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
	// Approved-unattended writes (dialog: false, headless allowUnattendedWrites)
	// skip the dialog; interactive sessions always gate here.
	if (!input.dialog) return null;
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
	"SELECT id, content, root_id, type FROM blocks WHERE id";

/** The target read shared by the blockId-targeting modes — the block's
 * current content (confirmation display + fresh-content baseline), or
 * null when the id is absent from the kernel. Absence is never refused
 * here: each op's own kernel outcome governs the observable behavior
 * (edit/move surface the synchronous not-found error verbatim; delete
 * is a success no-op on 3.8.3 and a synchronous "tree not found" error
 * on 3.8.4, surfaced the same way) and the live suite watches the
 * kernel, not this pre-read, for contract drift. A block that EXISTS but belongs to a
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
): Promise<
	{ content: string | null; type: string | null } | { refusal: string }
> {
	const rows = await kernel.query(
		`${BLOCK_IN_DOC_STMT_HEAD} = ${sqlString(blockId)}`,
	);
	if (rows[0] === undefined) return { content: null, type: null };
	const rootId = String(rows[0].root_id ?? "");
	return rootId === doc.rootId
		? {
				content: String(rows[0].content),
				type: String(rows[0].type ?? ""),
			}
		: {
				refusal: `block '${blockId}' belongs to another doc (root ${rootId}), not '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
			};
}

/** The pinned rejection when a heading id is absent from the doc walk.
 * Same class as blockInDoc's foreign-block refusal: a target id that fails
 * the doc's own membership check is refused before any kernel call (doc-
 * level resolution is the `error` case, matching the status table).
 *
 * A heading whose container the kernel does not accept as a write-parent
 * (appendBlock/moveBlock accept d/b/l/i/s/callout/tab) is refused here too:
 * a section target inside `tabs` or an unnamed container (wire type "",
 * e.g. a footnote definition) would place the write in a container the
 * kernel rejects. */
export function headingInWalk(
	walk: WalkedBlock[],
	doc: DocTarget,
	headingId: string,
): WalkedBlock | Envelope {
	const heading = walk.find((b) => b.id === headingId && b.type === "h");
	if (heading === undefined) {
		return refusedEnvelope(
			`headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
		);
	}
	if (!TARGETABLE_CONTAINER_TYPES.has(heading.parentType ?? "")) {
		const container =
			heading.parentType === "" || heading.parentType === null
				? "an unnamed container"
				: `a '${heading.parentType}' container`;
		return refusedEnvelope(
			`headingId '${headingId}' (${heading.content}) sits inside ${container}, which the kernel does not accept as a write-parent — not a targetable heading; re-target a heading in the doc, a quote, a list, a superblock, a callout or a tab`,
		);
	}
	return heading;
}

/** Verified, not trusted: a kernel-returned insert id counts as landed
 * only when it is genuinely new — present in the post-write walk set and
 * absent from the pre-write set. A miss means the transaction rolled back
 * silently behind HTTP success. One home so the predicate and its error
 * wording cannot drift between the insert-bearing modes. */
export function insertRollbackReason(
	newBlockId: string | undefined,
	preIds: ReadonlySet<string>,
	postIds: ReadonlySet<string>,
): string | undefined {
	if (newBlockId === undefined) return "the kernel returned no block id";
	if (!postIds.has(newBlockId) || preIds.has(newBlockId))
		return `the kernel returned '${newBlockId}' but it is absent from the post-write tree`;
	return undefined;
}

/** One catch-site for every kernel mutation call. A transport-class throw
 * (network drop, per-attempt timeout) leaves the mutation's outcome UNKNOWN:
 * fetch can reject after the request was sent, and a timed-out request was
 * delivered — so the write may already be applied and the envelope must
 * never read as runKbCall's "SiYuan unreachable", whose retry invitation
 * would duplicate an applied write (the same contract finishWrite enforces
 * for the post-write reads, which this sits upstream of). A synchronous
 * kernel rejection (SiYuanApiError) is not in-flight: it surfaces verbatim
 * with the fresh outline attached (no tail when the caller passes no doc —
 * the pinned doc-level record shape). Auth and rate-limit errors return
 * undefined — the call site rethrows them for runKbCall's classification
 * (breaker counting, 429 cooldown). The echo reads run best-effort on the
 * transport legs: the kernel may still be down, and the unverified verdict
 * must not depend on them landing. */
export async function mutationFailed(
	input: WriteFlowBase,
	err: unknown,
	extra: Record<string, unknown> = {},
	doc?: DocTarget | undefined,
): Promise<Envelope | undefined> {
	if (err instanceof SiYuanNetworkError || err instanceof SiYuanTimeoutError) {
		let tail: Record<string, unknown> = {};
		if (doc !== undefined) {
			try {
				tail = await echoTail(input, doc);
			} catch {
				// The kernel may still be down — the verdict rides the message.
			}
		}
		return errorEnvelope(
			`the write's outcome is unverified: the kernel call failed at the ` +
				`transport layer (${err instanceof Error ? err.message : String(err)}) — ` +
				`the request may have been delivered and the write may already be ` +
				`applied; do NOT retry blindly — re-fetch the outline (kb_read) and ` +
				`confirm whether it landed before repeating it`,
			{ kb: input.name, verificationFailed: true, ...extra, ...tail },
		);
	}
	if (err instanceof SiYuanApiError) {
		const tail = doc === undefined ? {} : await echoTail(input, doc);
		return errorEnvelope(err.message, {
			kb: input.name,
			...extra,
			...tail,
		});
	}
	return undefined;
}

/** writeEchoTail with the flow's fixed identity args bound — call sites
 * pass only an optional pre-fetched verification walk and the write's own
 * block IDs (only on the success paths — a write that did not land
 * refreshes nothing, or it would launder a concurrent change). */
export async function echoTail(
	input: WriteFlowBase,
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
