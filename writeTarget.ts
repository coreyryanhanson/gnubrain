// Write-target resolution and the shared target reads: the flow input
// shape, doc-target ownership resolution, the heading-target judgment's
// wording map, and the truncation refusals — what the per-mode flow files
// (writeCreate/writeEdit/writeAppend/writeReplaceSection/writeDelete/
// writeMove) build on before any mutation.

import {
	errorEnvelope,
	type Envelope,
	noSuchDocEnvelope,
	refusedEnvelope,
	STALE_TARGET_GUIDANCE,
} from "./envelope.js";
import {
	resolveHeadingTarget,
	rootEcho,
	type KernelProbeResult,
	type WalkedBlock,
	type WalkedTree,
	type WalkTruncated,
} from "siyuan-kb-primitives";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import type { ContentBaselines } from "./baselines.js";
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

/** The projection-refusal ladder shared by the append, move, and
 * replace-section flows: a placement projection over the same walk the
 * primitives' pre-mutation gate re-checks refuses an incomplete tree
 * before any kernel call, and its heading-absent arm is unreachable —
 * headingInWalk already refused an absent id on that same walk — kept as
 * a fail-closed tripwire, never a silent doc-end fallback. The truncation
 * refusal wording differs per operation shape; the caller supplies it. */
export function placementRefusal<T extends { kind: string }>(
	derived: T,
	headingId: string | undefined,
	doc: DocTarget,
	kb: string,
	truncated: () => Envelope,
): Exclude<T, WalkTruncated | { kind: "heading-absent" }> | Envelope {
	if (derived.kind === "walk-truncated") return truncated();
	if (derived.kind === "heading-absent") {
		return refusedEnvelope(staleHeadingMessage(headingId as string, doc), {
			kb,
		});
	}
	// Every placement projection union ends in exactly these two refusal
	// arms, so what remains is the success type; the cast states that
	// contract (generic narrowing cannot decompose T itself).
	return derived as Exclude<T, WalkTruncated | { kind: "heading-absent" }>;
}
