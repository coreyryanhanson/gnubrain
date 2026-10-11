// The delete flow: block-level deleteBlock or doc-level removeDocByID.
// The mutation, its scoping precondition and its evidence are one
// primitive call (deleteBlockVerified / deleteDocVerified — see the
// primitives' delete.ts for the scoping and generation-coupled facts).
// The refusal arms word through writeVerdicts' shared blockInDoc
// sentences (the same pair the edit flow's pre-guard uses); the
// remaining non-judged arms ride the shared mutationFailureEnvelope.

import { backlinkCheck } from "siyuan-kb-primitives";
import {
	deleteBlockVerified,
	deleteDocVerified,
} from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { deletedBlocksTail, echoTail, mutationFailure } from "./writeEcho.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import { blockInDocRefusalKind } from "./writeVerdicts.js";

export async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	if (params.doc === true) {
		const outcome = await deleteDocVerified(kernel, input.probe, {
			docId: doc.rootId,
		});
		if (outcome.kind !== "mutated") {
			// The union has no verification-failed arm: the primitive's
			// evidence walk runs before the mutation (raw throws), and the
			// post-mutation reads live in this flow's finishWrite leg.
			return mutationFailure(outcome, input, doc, { docId: doc.rootId });
		}
		return finishWrite(name, {}, async () => {
			// The doc's pre-delete walk set is the invalidRefs evidence.
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
	const outcome = await deleteBlockVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
	});
	if (outcome.kind === "foreign" || outcome.kind === "doc-id") {
		return refusedEnvelope(blockInDocRefusalKind(outcome, blockId, doc));
	}
	if (outcome.kind !== "judged") {
		// The shared pre-judgment ladder, worded once in writeVerdicts.
		// The lazy tail supplier keeps the per-arm garnish rule — only the
		// arms that attach the echo reads fire them.
		return mutationFailure(outcome, input, doc, { blockId });
	}
	const verdict = outcome.verdict;
	return finishWrite(name, { blockId }, async () => {
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		const tail = await echoTail(input, doc, outcome.postWalk);
		if (verdict.kind === "absence-unconfirmed") {
			return errorEnvelope(
				`delete applied but unverified: block '${blockId}' acked deleted, but the verification walk hit the document's depth bound — whether the target is gone could not be confirmed (it may sit past the bound). Do NOT re-run blind; re-fetch the outline (kb_read) and check the block by id first`,
				{ kb: name, blockId, invalidRefs, ...tail },
			);
		}
		// The deleted block's stored content rides the judged arm (the
		// primitive's own membership read) — the receipt is free. Gated on
		// the walk-set evidence: a no-op kernel (3.8.3) deleted nothing, so
		// there is no receipt to give.
		const receipt =
			verdict.kind === "gone"
				? deletedBlocksTail(input.sessionId, [
						{ id: blockId, content: outcome.content },
					])
				: undefined;
		return {
			status: "ok",
			message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${verdict.kind === "gone" ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} doc(s) with orphaned refs`,
			kb: name,
			blockId,
			targetGone: verdict.kind === "gone",
			invalidRefs,
			...receipt,
			...tail,
		};
	});
}
