// The delete flow: block-level deleteBlock or doc-level removeDocByID.
// The mutation, its scoping precondition and its evidence are one
// primitive call: deleteBlockVerified (pre-mutation membership refusal —
// foreign / doc-id refuse before any kernel call, an absent target falls
// through to the kernel's per-generation answer — plus mutation and
// walk-set judgment, the landing never trusted from the HTTP success) and
// deleteDocVerified (pre-delete walk captured as the receipt/invalidRefs
// evidence). The refusal arms word through writeVerdicts' shared
// blockInDoc sentences (the same pair the edit flow's pre-guard uses); the
// remaining non-judged arms ride the shared mutationFailureEnvelope (the
// block-delete failure half IS MutationFailure by type). The
// generation-coupled fact (3.8.3 success no-op vs 3.8.4
// "tree not found") lives in the primitives' delete.ts and surfaces
// verbatim through the kernel-refused arm.

import { backlinkCheck } from "siyuan-kb-primitives";
import {
	deleteBlockVerified,
	deleteDocVerified,
} from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	deletedBlocksTail,
	echoTail,
	mutationFailure,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite } from "./writeResult.js";
import { blockInDocRefusalKind } from "./writeVerdicts.js";

export async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	if (params.doc === true) {
		// The verified doc delete: the pre-delete walk (the doc's full block
		// set — the receipt and invalidRefs evidence, captured before the doc
		// and its block set vanish) and the mutation are one primitive call.
		// No landing judgment: no pinned evidence read proves a doc's
		// deletion (see deleteDocVerified's doc comment). The pre-mutation
		// walk failure propagates raw — nothing is in flight, so runKbCall's
		// classification is correct.
		const outcome = await deleteDocVerified(kernel, input.probe, {
			docId: doc.rootId,
		});
		if (outcome.kind !== "mutated") {
			// Rides the shared ladder (the exhaustive wording home — a new
			// arm in a primitives release fails typecheck there, not per
			// flow). The union has no verification-failed arm: the
			// primitive's evidence walk runs before the mutation (raw
			// throws), and the post-mutation reads live in this flow's
			// finishWrite leg.
			return mutationFailure(outcome, input, doc, { docId: doc.rootId });
		}
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the doc may already be gone (finishWrite doc).
		return finishWrite(name, {}, async () => {
			// invalidRefs rides the pre-delete walk set — the doc is gone.
			const invalidRefs = await backlinkCheck(
				kernel,
				outcome.preWalk.blocks.map((b) => b.id),
			);
			// The same walk set is the receipt: every block the doc lost,
			// itemized with its content — no outline or root row survives.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} doc(s) with orphaned refs`,
				kb: name,
				invalidRefs,
				...deletedBlocksTail(input.sessionId, outcome.preWalk.blocks),
			};
		});
	}
	const blockId = params.blockId as string;
	// The verified block delete, whole — the primitive owns the scoping
	// precondition: foreign / doc-id refuse before any kernel call (worded
	// by the same sentences the edit flow's pre-guard uses), and an absent
	// target falls through the membership read so the kernel answers it
	// per generation — 3.8.4 a synchronous "tree not found" error where
	// 3.8.3 answered a success no-op; the kernel-refused arm surfaces it
	// verbatim, with the fresh outline attached so the agent re-targets.
	// Transport classes carry the unverified-outcome verdict.
	const outcome = await deleteBlockVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
	});
	if (outcome.kind === "foreign" || outcome.kind === "doc-id") {
		// The producer's scoping refusal, worded by the shared sentence
		// pair — the foreign arm carries the block's actual root.
		return refusedEnvelope(blockInDocRefusalKind(outcome, blockId, doc));
	}
	if (outcome.kind === "walk-truncated") {
		// The delete acked but the post-delete walk hit the depth bound:
		// the target's absence is unconfirmed. Applied-but-unverified —
		// never renderable as ok, never as "unreachable".
		return finishWrite(name, { blockId }, async () => {
			const invalidRefs = await backlinkCheck(kernel, [blockId]);
			const tail = await echoTail(input, doc, outcome.postWalk);
			return errorEnvelope(
				`delete applied but unverified: block '${blockId}' acked deleted, but the verification walk hit the document's depth bound — whether the target is gone could not be confirmed (it may sit past the bound). Do NOT re-run blind; re-fetch the outline (kb_read) and check the block by id first`,
				{ kb: name, blockId, invalidRefs, ...tail },
			);
		});
	}
	if (outcome.kind !== "judged") {
		// The exhaustive wording home (the createVerdictEnvelope pattern):
		// a new arm in a primitives release fails typecheck until its
		// envelope is written in writeVerdicts. The block-delete failure half
		// IS MutationFailure by type, so it rides the shared ladder with its
		// blockId as the flow's verdict key. The lazy tail supplier keeps the
		// per-arm garnish rule — only the arms that attach the echo reads
		// fire them.
		return mutationFailure(outcome, input, doc, { blockId });
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the delete may already be applied (finishWrite doc).
	// The judged arm carries its evidence: the post-delete walk the judgment
	// ran on — the tail and receipt below consume this exact snapshot, never
	// re-fetching between "verified" and "served".
	return finishWrite(name, { blockId }, async () => {
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		const tail = await echoTail(input, doc, outcome.postWalk);
		// The deleted block's stored content rides the judged arm (the
		// primitive's own membership read) — the receipt is free. Gated on
		// the walk-set evidence: a no-op kernel (3.8.3) deleted nothing, so
		// there is no receipt to give.
		const receipt = outcome.targetGone
			? deletedBlocksTail(input.sessionId, [
					{ id: blockId, content: outcome.content },
				])
			: undefined;
		return {
			status: "ok",
			message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${outcome.targetGone ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} doc(s) with orphaned refs`,
			kb: name,
			blockId,
			targetGone: outcome.targetGone,
			invalidRefs,
			...receipt,
			...tail,
		};
	});
}
