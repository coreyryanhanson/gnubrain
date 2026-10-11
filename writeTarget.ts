// Write-target resolution and the shared target reads: the flow input
// shape, doc-target ownership resolution, the heading-target judgment's
// wording map, the truncation refusals, and the fresh-content pre-mutation
// precondition — what the per-mode flow files (writeCreate/writeEdit/
// writeAppend/writeReplaceSection/writeDelete/writeMove) build on before
// any mutation.

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
	checkFreshContent,
	type FreshOutcome,
	type KernelProbeResult,
	type WalkedBlock,
	type WalkedTree,
} from "siyuan-kb-primitives";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
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
 * so an absent heading is unconfirmed (it may sit past the bound). This is
 * the target judgment's own arm; the flows' depth-bound refusals (per
 * operation shape) word in writeVerdicts. The walks are strict, so the
 * only reachable incompleteness cause here is the depth bound — the
 * agent-facing string names it. */
function walkTruncatedMessage(doc: DocTarget): string {
	return `the walk of doc '${doc.title}' (${doc.rootId}) hit the document's depth bound, so the target judgment would read incomplete evidence — refused before any kernel call; restructure the document (or edit in place) instead`;
}

/** The shared anchor-narrowing refusal — the two fail-closed arms every
 * flow's anchor/section projection shares, worded once: walk-truncated
 * takes the flow's depth-bound sentence (writeVerdicts), heading-absent
 * the stale-heading refusal — headingInWalk already refused an absent id
 * on this same walk, so absence here is a caller/derivation mismatch, not
 * a fresh fact about the doc. Passing the narrowed kind keeps the inline
 * narrowing discipline: a new primitives arm fails typecheck at the call
 * site's landed path, not through a cast. */
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

/** Fresh-content precondition, checked right before the kernel write: the
 * current content must still hash to the baseline the session last served.
 * One wrapper over the primitives' checkFreshContent judgment (both reads
 * and the comparison live down-repo; the walk ≡ SQL equivalence the pair
 * depends on is falsified there), applying the session doctrine over ALL
 * arms — there is no early stop, so a multi-stale refusal names every
 * stale target and the agent decides once:
 * - `fresh` → remember (a no-op: the hash already matches; preserves the
 *   seed side effect for the residual paths)
 * - `unseen` → adopt the live form (the no-baseline fallback, visible:
 *   nothing stored existed to launder)
 * - `stale` → re-baseline from the judged content AND name the target —
 *   the anti-laundering invariant: no stored baseline moves without its
 *   content being visible in the same envelope, so the retry proceeds
 *   against informed consent instead of refuse-looping
 * - `vanished` → skip (delete no-op class; the baseline is retained, so a
 *   return via undo re-judges as `fresh` if unchanged, `stale` if not)
 * Any stale arm → the `stale_content` refusal carrying every stale target
 * (`staleTargets`, beside the retained scalar first-arm fields) and the
 * outline served from the judged walk; otherwise `null` and the walk is
 * dropped. Read errors propagate raw — the flows' transport classification
 * applies (breaker counting, 429 cooldown). */
export async function freshContentRefusal(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	targets: { blockId: string; baselineHash: string | undefined }[],
	context: { sessionId: string; docId: string },
): Promise<Envelope | null> {
	if (targets.length === 0) return null;
	const { walk, arms } = await checkFreshContent(kernel, {
		docId: context.docId,
		targets,
	});
	const staleArms: Extract<FreshOutcome, { kind: "stale" }>[] = [];
	for (const arm of arms) {
		switch (arm.kind) {
			case "vanished":
				continue;
			case "absence-unconfirmed":
				// Absence from an incomplete walk is unconfirmed — the target
				// may sit past the depth bound or behind a swallowed branch.
				// Not fresh, not vanished: skip (the baseline is retained, so a
				// later edit re-judges like vanished does).
				continue;
			case "fresh":
			case "unseen":
				baselines.remember(arm.blockId, arm.currentContent);
				continue;
			case "stale":
				baselines.remember(arm.blockId, arm.currentContent);
				staleArms.push(arm);
				continue;
		}
		arm satisfies never;
	}
	const first = staleArms[0];
	if (first === undefined) return null;
	// The refusal's outline renders from the judged snapshot — its heading
	// content is seeded like every other serve site, or a follow-up edit on
	// a served heading takes the no-baseline fallback and launders a
	// concurrent change past the precondition. The walk is already in hand.
	const fresh = serveOutlineFromWalk(
		context.sessionId,
		"kb_write",
		walk,
		baselines,
	);
	return refusedEnvelope(
		`the content of block '${first.blockId}' changed since it was last seen in this session — re-read the current state with kb_read, then re-target (reason: stale_content)`,
		{
			reason: "stale_content",
			blockId: first.blockId,
			currentContent: first.currentContent,
			staleTargets: staleArms.map((arm) => ({
				blockId: arm.blockId,
				currentContent: arm.currentContent,
			})),
			...fresh,
		},
	);
}
