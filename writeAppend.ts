// The append flow: tool-derived nextID anchor, doc-end fallback; the
// mutation and the insert-landed judgment are one primitive call
// (insertVerified) — the post-write walk rides the verdict.

import {
	deriveAppendAnchor,
	walkBlockTree,
	type AppendPlacement,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import { insertVerified } from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	echoTail,
	headingInWalk,
	mutationFailure,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite } from "./writeResult.js";
import { appendAnchorEcho, insertLandedRefusal } from "./writeVerdicts.js";

export async function runAppendMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	// The walk doubles as anchor data AND the pre-write walk the verified
	// insert's landed judgment diffs against (the same walk the anchor
	// derivation fetches) — the primitive derives the id set internally and
	// refuses a truncated walk before any kernel call.
	const tree = await walkBlockTree(kernel, doc.rootId);
	const walk = tree.blocks;
	let resolvedHeading: WalkedBlock | undefined;
	if (params.headingId !== undefined) {
		const heading = headingInWalk(walk, doc, params.headingId);
		if ("status" in heading) return heading;
		resolvedHeading = heading;
	}
	const anchor = deriveAppendAnchor(
		walk,
		resolvedHeading,
		params.placement as AppendPlacement | undefined,
	);
	const echo = appendAnchorEcho(anchor);
	// The verified insert: the mutation and the landed judgment are one
	// primitive call. Transport failures in the mutation phase are outcome-
	// UNKNOWN (the insert may already be applied); auth / rate-limit errors
	// rethrow for runKbCall's classification (breaker counting, 429
	// cooldown).
	const outcome = await insertVerified(kernel, input.probe, {
		anchor,
		body: input.body,
		rootId: doc.rootId,
		preWalk: tree,
	});
	if (outcome.kind === "walk-truncated") {
		// The primitive refuses a truncated pre-write walk before any kernel
		// call — the anchor and the landed judgment's pre-write evidence
		// would derive from an incomplete tree.
		return refusedEnvelope(
			`the pre-write walk hit the document's depth bound, so the append anchor could not be derived from complete evidence — append refused before any kernel call; restructure the document (or edit in place) instead`,
			{ kb: name, anchor: echo },
		);
	}
	if (outcome.kind !== "judged") {
		return mutationFailure(outcome, input, doc, { anchor: echo });
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the insert is already applied (finishWrite doc). The
	// landed judgment lives in the primitives' insertVerified (the
	// pin-owning repo); the refusal wording rides the shared map
	// (writeVerdicts). The verdict's postWalk IS the post-write tree — the
	// echo reuses it, never re-traverses.
	return finishWrite(name, { anchor: echo }, async () => {
		if (outcome.verdict.kind !== "landed") {
			const rollback = insertLandedRefusal(outcome.verdict);
			const tail = await echoTail(input, doc, outcome.postWalk);
			return errorEnvelope(`verified-append failed: ${rollback}`, {
				kb: name,
				anchor: echo,
				...tail,
			});
		}
		const newBlockId = outcome.verdict.blockId;
		const tail = await echoTail(input, doc, outcome.postWalk, [newBlockId]);
		return {
			status: "ok",
			message: `appended to '${doc.title}' (KB ${name}) — newBlockId ${newBlockId}`,
			kb: name,
			anchor: echo,
			newBlockId,
			...tail,
		};
	});
}
