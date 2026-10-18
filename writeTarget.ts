// Write-target resolution and the shared target reads: the flow input
// shape, doc-target ownership resolution, the heading-target judgment's
// wording map, and the truncation refusals — what the per-mode flow files
// (writeCreate/writeEdit/writeAppend/writeReplaceSection/writeDelete/
// writeDeleteSection/writeMove) build on before any mutation. The
// fresh-content pre-mutation precondition lives in writeFresh.ts.

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

/** The stale-heading refusal — the heading-target arms inside this module
 * (anchorRefusal) and the move target guard all reject the same target. */
export function staleHeadingMessage(headingId: string, doc: DocTarget): string {
	return `headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — ${STALE_TARGET_GUIDANCE}`;
}

/** The truncation refusal — the target read runs over an incomplete walk,
 * so an absent heading is unconfirmed (it may sit past the bound). This is
 * the target judgment's own arm; the flows' depth-bound refusals (per
 * operation shape) word in writeVerdicts. The walks are strict, so the
 * only reachable incompleteness cause here is the depth bound — the
 * agent-facing string names it. */
function walkTruncatedMessage(doc: DocTarget): string {
	return `the walk of doc '${doc.title}' (${doc.rootId}) hit the document's depth bound, so the target judgment would read incomplete evidence — refused before any mutation; restructure the document (or edit in place) instead`;
}

/** The shared anchor-narrowing refusal — the two fail-closed arms every
 * flow's anchor/section projection shares, worded once. For the
 * headingInWalk-first consumers (append, replace-section) heading-absent
 * is a caller/derivation mismatch, not a fresh fact about the doc;
 * delete-section resolves through sectionOf alone (see its docstring),
 * so there the arm is a fresh, reachable refusal. Walk-truncated takes
 * the flow's depth-bound sentence (writeVerdicts), heading-absent the
 * stale-heading refusal.
 * Passing the narrowed kind keeps the inline narrowing discipline: a new
 * primitives arm fails typecheck at the call site's landed path, not
 * through a cast. */
export function anchorRefusal(
	kind: "walk-truncated" | "heading-absent",
	doc: DocTarget,
	headingId: string,
	kb: string,
	truncatedMessage: string,
): Envelope {
	return kind === "walk-truncated"
		? refusedEnvelope(truncatedMessage, { kb })
		: refusedEnvelope(staleHeadingMessage(headingId, doc), { kb });
}

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
