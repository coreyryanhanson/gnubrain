// The append flow: tool-derived nextID anchor, doc-end fallback; the
// mutation and the insert-landed judgment are one primitive call
// (insertVerified) — the post-write walk rides the verdict.

import { deriveAppendAnchor, walkBlockTree } from "siyuan-kernel-primitives";
import { insertVerified } from "siyuan-kernel-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { echoTail } from "./writeEcho.js";
import { mutationFailure } from "./writeLadder.js";
import {
	anchorRefusal,
	headingInWalk,
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import {
	appendAnchorEcho,
	appendWalkTruncatedMessage,
	insertLandedRefusal,
} from "./writeVerdicts.js";

export async function runAppendMode(
	input: WriteFlowInput<"append">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	// The walk doubles as anchor data AND the pre-write walk the verified
	// insert's landed judgment diffs against (the same walk the anchor
	// derivation fetches) — the primitive derives the id set internally and
	// refuses a truncated walk before any kernel call.
	const tree = await walkBlockTree(kernel, doc.rootId);
	if (params.headingId !== undefined) {
		const resolved = headingInWalk(tree, doc, params.headingId);
		if ("status" in resolved) return resolved;
	}
	const anchor = deriveAppendAnchor(tree, params.headingId, params.placement);
	// Inline narrowing: the fail-closed arms word in anchorRefusal
	// (writeTarget.ts).
	if (anchor.kind === "walk-truncated" || anchor.kind === "heading-absent") {
		return anchorRefusal(anchor, doc, name, appendWalkTruncatedMessage);
	}
	const echo = appendAnchorEcho(anchor);
	// The verified insert: one primitive call — the shared transport
	// contract lives in writeResult.ts's header.
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
		return refusedEnvelope(appendWalkTruncatedMessage, {
			kb: name,
			anchor: echo,
		});
	}
	if (outcome.kind !== "judged") {
		return mutationFailure(outcome, input, doc, { anchor: echo });
	}
	// Post-mutation reads (see finishWrite's contract — the insert may
	// already be applied). The verdict's postWalk IS the post-write tree —
	// the echo reuses it, never re-traverses.
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
