// Shared scaffolding for the write flows: the flow input shape, doc-target
// ownership resolution, and the shared target reads — everything the
// per-mode flow files
// (writeCreate/writeEdit/writeAppend/writeReplaceSection/writeDelete/writeMove)
// build on.

import {
	errorEnvelope,
	type Envelope,
	noSuchDocEnvelope,
	refusedEnvelope,
	STALE_TARGET_GUIDANCE,
} from "./envelope.js";
import {
	blockContents,
	resolveHeadingTarget,
	rootEcho,
	walkBlockTree,
	type KernelProbeResult,
	type WalkedBlock,
	type WalkedTree,
} from "siyuan-kb-primitives";
import type {
	MutationFailure,
	WriteKernelClient,
} from "siyuan-kb-primitives/write";
import { mutationFailureEnvelope } from "./writeVerdicts.js";
import { inlineOrSpill, jsonl } from "./spill.js";
import type { ContentBaselines } from "./baselines.js";
import { serveOutlineFromWalk } from "./outline.js";
import type { WriteParams } from "./writeSchema.js";

/** Flow input shared by every mode, create included — one declaration so
 * the fields (and their contracts) cannot drift between create and the
 * per-mode flows. */
export interface WriteFlowBase {
	sessionId: string;
	kernel: WriteKernelClient;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	/** Captured content body ("" on body-less modes). */
	body: string;
	baselines: ContentBaselines;
	/** The gate's probe verdict, stamped by prepareWrite's caller — the
	 * session-start value, or the fresh re-probe on the retry path. The
	 * verdict primitives require it; the gate refuses the
	 * unreachable/never-probed members before any flow runs, so only the
	 * narrow KernelProbeResult reaches here. */
	probe: KernelProbeResult;
}

export interface WriteFlowInput extends WriteFlowBase {
	params: WriteParams;
}

export interface DocTarget {
	rootId: string;
	title: string;
}

/** Every non-create mode takes docId — an echoed type-'d' root_id, read
 * through rootEcho: box-scoped (an id from another KB reads as nothing)
 * and type-discriminated (a block id is not a doc target). The judgment
 * lives in the primitives beside the block-row shape it encodes; this
 * side owns only the refusal. */
export async function resolveDocTarget(
	kernel: WriteKernelClient,
	boxId: string,
	name: string,
	docId: string,
): Promise<DocTarget | Envelope> {
	const root = await rootEcho(kernel, boxId, docId);
	if (root === undefined) {
		return noSuchDocEnvelope(name, docId);
	}
	return { rootId: root.docId, title: root.title };
}

/** The stale-heading refusal — shared by headingInWalk and replace-section's
 * section-membership fallback, which both reject the same target. */
export function staleHeadingMessage(headingId: string, doc: DocTarget): string {
	return `headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — ${STALE_TARGET_GUIDANCE}`;
}

/** The truncation refusal — the target read runs over an incomplete walk,
 * so an absent heading is unconfirmed (it may sit past the bound). The
 * flows word their truncation refusals per document shape (append, move,
 * replace-section); this is the target-judgment one. The flows' walks are
 * strict, so the only reachable incompleteness cause here is the depth
 * bound — the agent-facing string names it. */
export function walkTruncatedMessage(doc: DocTarget): string {
	return `the walk of doc '${doc.title}' (${doc.rootId}) hit the document's depth bound, so the target judgment would read incomplete evidence — refused before any kernel call; restructure the document (or edit in place) instead`;
}

/** The flows' own depth-bound refusals, each worded once and shared by the
 * flow's two truncation arms (projection refusal and the primitives'
 * walk-truncated verdict) — the sentences differ per operation shape, not
 * per arm. */
export const appendWalkTruncatedMessage =
	"the pre-write walk hit the document's depth bound, so the append anchor could not be derived from complete evidence — append refused before any kernel call; restructure the document (or edit in place) instead";

export const replaceSectionWalkTruncatedMessage =
	"the document nests past the walk depth bound, so the section enumeration and the insert anchor cannot be derived from complete evidence — replace-section refused before any kernel call; restructure the document (or edit the target block directly) instead";

/** The heading-target refusal map — wording only. The judgment (membership
 * + write-parent targetability, the kernel's CheckContainerParent set) is
 * the primitives' `resolveHeadingTarget`; a section target inside `tabs` or
 * an unnamed container (wire type "", e.g. a footnote definition) would
 * place the write in a container the kernel rejects, so the untargetable
 * arm refuses with the same re-target guidance every flow shares. Takes
 * the whole WalkedTree: absence on an incomplete walk is unconfirmed and
 * refuses as `walk-truncated` instead of a confident heading-absent refusal. */
export function headingInWalk(
	tree: WalkedTree,
	doc: DocTarget,
	headingId: string,
): WalkedBlock | Envelope {
	const outcome = resolveHeadingTarget(tree, headingId);
	switch (outcome.kind) {
		case "heading":
			return outcome.heading;
		case "heading-absent":
			return refusedEnvelope(staleHeadingMessage(headingId, doc));
		case "walk-truncated":
			return refusedEnvelope(walkTruncatedMessage(doc));
		case "untargetable": {
			const container =
				outcome.containerType === ""
					? "an unnamed container"
					: `a '${outcome.containerType}' container`;
			return refusedEnvelope(
				`headingId '${headingId}' (${outcome.headingContent}) sits inside ${container}, which the kernel does not accept as a write-parent — not a targetable heading; re-fetch the outline (kb_read) and re-target a heading not marked (not targetable)`,
			);
		}
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled heading-target arm");
}

/** Error-path echo reads are garnish: the verdict (the transport message or
 * the kernel's own error) is already correct without the outline, so a
 * dropped re-read must not mask it — unwrapped, the echo's transport throw
 * would escape the flow's per-arm mapping and runKbCall would reclassify a
 * kernel-answered call as "SiYuan unreachable". Success-path echoes
 * (finishWrite) stay loud on purpose: a dropped verification read must read
 * as unverified, never as success. Exported for the write flows' per-arm
 * refusal envelopes — every mode now maps its primitive outcomes here and
 * applies the same garnish rule. */
export async function errorTail(
	input: WriteFlowBase,
	doc: DocTarget,
): Promise<Record<string, unknown>> {
	try {
		return await echoTail(input, doc);
	} catch {
		return {};
	}
}

/** The shared failure ladder's flow-side binding — every mode's
 * non-judged arms differ only in the verdict key (extra); the kb name and
 * the error-path echo tail are the same at every site. The one exception
 * is the doc move's failure legs (empty tail, the pinned no-doc-target
 * shape), which bind mutationFailureEnvelope directly. */
export function mutationFailure(
	outcome: MutationFailure,
	input: WriteFlowBase,
	doc: DocTarget,
	extra: { anchor: string } | { blockId: string } | { docId: string },
): Promise<Envelope> {
	return mutationFailureEnvelope(outcome, {
		kb: input.name,
		extra,
		tail: () => errorTail(input, doc),
	});
}

/** Fresh outline + root echo + baseline seeding — the shared tail every
 * doc-targeting result calls; call sites pass an optional pre-fetched
 * verification walk and, on the success paths only, the write's own block
 * IDs (a failed write passes none — nothing of a write that did not land
 * is remembered). One full unfiltered walk; a pre-fetched walk (the
 * verification evidence the flow already holds) is reused instead of
 * re-traversing. The block IDs are the blocks the write itself produced
 * (a newBlockId, a movedBlockId) — baselined from stored form so a
 * follow-up edit compares like-for-like. The edit's target is not among
 * them: its landed verdict carries the stored pair, and the flow
 * baselines from that instead of a read. */
export async function echoTail(
	input: WriteFlowBase,
	doc: DocTarget,
	walk?: WalkedTree | undefined,
	refreshBlockIds?: readonly string[],
): Promise<Record<string, unknown>> {
	const { kernel, sessionId, boxId, baselines } = input;
	const docId = doc.rootId;
	const fullWalk = walk ?? (await walkBlockTree(kernel, docId));
	// The serve seeds every walk heading's baseline, and nothing later
	// overwrites it: the baseline is exactly the snapshot the result
	// serves. A post-walk read would either repeat the same strings (the
	// walk ≡ SQL equivalence) or launder a concurrent change or a stale
	// index row into the baseline past the fresh-content precondition.
	const outline = serveOutlineFromWalk(
		sessionId,
		"kb_write",
		fullWalk,
		baselines,
	);
	const root = await rootEcho(kernel, boxId, docId);
	const envelope: Record<string, unknown> = { ...outline };
	if (root !== undefined) {
		envelope.docId = root.docId;
		envelope.title = root.title;
		envelope.hpath = root.hpath;
	}
	// The only SQL-form baseline seed here is the write's own blocks:
	// submitted markdown is re-parsed by the kernel, so the stored form is
	// knowable only by reading it back. Served rows keep their walk-seeded
	// baseline — a broad refresh would launder a concurrent change past
	// the fresh-content precondition (an intervening write would make the
	// next edit on it hash-match laundered content).
	if (refreshBlockIds?.length) {
		for (const row of await blockContents(kernel, [...refreshBlockIds])) {
			baselines.remember(row.id, row.content);
		}
	}
	return envelope;
}

/** The delete receipt: what a delete-bearing op removed — block ids and
 * their walk content, covering both the members the sweep deleted
 * explicitly and the descendants the kernel's cascade took with them
 * (the closure is exactly what left the doc). Built from the walk the
 * flow already holds — zero extra kernel calls. Inline within the shared
 * preview budget; overflow spills the full JSONL and the pointer rides as
 * a sibling field, the same contract as `outline`/`fullOutlinePath`. */
export function deletedBlocksTail(
	sessionId: string,
	blocks: { id: string; content: string | null }[],
): Record<string, unknown> {
	const rows = blocks.map((b) => ({ id: b.id, content: b.content }));
	const { inline, spillPath } = inlineOrSpill(
		sessionId,
		"kb_write-deleted-blocks",
		jsonl(rows),
		"jsonl",
	);
	if (spillPath === undefined) return { deletedBlocks: rows };
	return { deletedBlocksPreview: inline, deletedBlocksPath: spillPath };
}
