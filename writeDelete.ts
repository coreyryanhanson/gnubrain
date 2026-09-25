// The delete flow: block-level deleteBlock or doc-level removeDocByID.
// The mutation and its evidence are one primitive call: deleteBlockVerified
// (mutation + walk-set judgment — the landing is never trusted from the
// HTTP success) and deleteDocVerified (pre-delete walk captured as the
// receipt/invalidRefs evidence). Tool-surface scoping stays here; the
// non-judged arms' envelope wording rides writeVerdicts' exhaustive
// mappers (deleteBlockVerdictEnvelope / deleteDocVerdictEnvelope). The
// generation-coupled fact (3.8.3 success no-op vs 3.8.4
// "tree not found") lives in the primitives' delete.ts and surfaces
// verbatim through the kernel-refused arm.

import { backlinkCheck, blockInDoc } from "siyuan-kb-primitives";
import {
	deleteBlockVerified,
	deleteDocVerified,
} from "siyuan-kb-primitives/write";
import { refusedEnvelope, type Envelope } from "./envelope.js";
import {
	deletedBlocksTail,
	echoTail,
	errorTail,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite } from "./writeResult.js";
import {
	blockInDocRefusal,
	deleteBlockVerdictEnvelope,
	deleteDocVerdictEnvelope,
} from "./writeVerdicts.js";

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
			// The exhaustive wording home (the createVerdictEnvelope pattern):
			// a new arm in a primitives release fails typecheck until its
			// envelope is written here. The lazy errorTail supplier keeps the
			// per-arm garnish rule — only the arms that attach the echo reads
			// fire them.
			return deleteDocVerdictEnvelope(outcome, {
				kb: name,
				docId: doc.rootId,
				errorTail: () => errorTail(input, doc),
			});
		}
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the doc may already be gone (finishWrite doc).
		return finishWrite(name, {}, async () => {
			// invalidRefs rides the pre-delete walk set — the doc is gone.
			const invalidRefs = await backlinkCheck(
				kernel,
				outcome.preWalk.map((b) => b.id),
			);
			// The same walk set is the receipt: every block the doc lost,
			// itemized with its content — no outline or root row survives.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} doc(s) with orphaned refs`,
				kb: name,
				invalidRefs: {
					count: invalidRefs.count,
					hpaths: invalidRefs.hpaths,
				},
				...deletedBlocksTail(input.sessionId, outcome.preWalk),
			};
		});
	}
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc.rootId, blockId);
	const refusal = blockInDocRefusal(row, blockId, doc);
	if (refusal !== undefined) return refusedEnvelope(refusal);
	// The verified block delete: the mutation and the walk-set judgment are
	// one primitive call. 3.8.4 requires an external delete to hit an
	// existing node — a missing ID (deleted concurrently, or a stale target)
	// is a synchronous "tree not found" error where 3.8.3 answered a success
	// no-op; the kernel-refused arm surfaces it verbatim, with the fresh
	// outline attached so the agent re-targets. Transport classes carry the
	// unverified-outcome verdict.
	const outcome = await deleteBlockVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
	});
	if (outcome.kind !== "judged") {
		// The exhaustive wording home (the createVerdictEnvelope pattern):
		// a new arm in a primitives release fails typecheck until its
		// envelope is written here. The lazy errorTail supplier keeps the
		// per-arm garnish rule — only the arms that attach the echo reads
		// fire them.
		return deleteBlockVerdictEnvelope(outcome, {
			kb: name,
			blockId,
			errorTail: () => errorTail(input, doc),
		});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the delete may already be applied (finishWrite doc).
	// The judged arm carries its evidence: the post-delete walk the judgment
	// ran on — the tail and receipt below consume this exact snapshot, never
	// re-fetching between "verified" and "served".
	return finishWrite(name, { blockId }, async () => {
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		const tail = await echoTail(input, doc, outcome.postWalk);
		// The removed block's pre-delete row is in hand — the receipt is
		// free. Gated on the walk-set evidence: a no-op kernel (3.8.3)
		// deleted nothing, so there is no receipt to give.
		const receipt = outcome.targetGone
			? deletedBlocksTail(input.sessionId, [
					{
						id: blockId,
						content: row.kind === "in-doc" ? row.content : null,
					},
				])
			: undefined;
		return {
			status: "ok",
			message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${outcome.targetGone ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} doc(s) with orphaned refs`,
			kb: name,
			blockId,
			targetGone: outcome.targetGone,
			invalidRefs: {
				count: invalidRefs.count,
				hpaths: invalidRefs.hpaths,
			},
			...receipt,
			...tail,
		};
	});
}
