// The delete flow: block-level deleteBlock or doc-level removeDocByID. An
// absent target is answered by the kernel per its generation — 3.8.3 a
// success no-op (the walk-set evidence reports the end state), 3.8.4 a
// synchronous "tree not found" error surfaced verbatim with the fresh
// outline attached, like edit/move.

import { refusedEnvelope, type Envelope } from "./envelope.js";
import { walkBlockTree } from "./walk.js";
import {
	blockInDoc,
	deletedBlocksTail,
	echoTail,
	runMutation,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { backlinkCheck, finishWrite, idSet } from "./writeResult.js";

export async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	if (params.doc === true) {
		// Whole-doc delete: the walk set feeds the post-delete invalidRefs
		// payload — the doc is gone, so this pre-delete walk is the evidence.
		const walk = await walkBlockTree(kernel, doc.rootId);
		const mutation = await runMutation(input, { docId: doc.rootId }, doc, () =>
			kernel.removeDocByID(doc.rootId),
		);
		if (mutation !== null && "status" in mutation) return mutation;
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the doc may already be gone (finishWrite doc).
		return finishWrite(name, {}, async () => {
			// invalidRefs rides the pre-delete walk set — the doc is gone.
			const invalidRefs = await backlinkCheck(
				kernel,
				walk.map((b) => b.id),
			);
			// The same walk set is the receipt: every block the doc lost,
			// itemized with its content — no outline or root row survives.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} orphaned ref(s)`,
				kb: name,
				invalidRefs: {
					count: invalidRefs.count,
					hpaths: invalidRefs.hpaths,
				},
				...deletedBlocksTail(input.sessionId, walk),
			};
		});
	}
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if ("refusal" in row) return refusedEnvelope(row.refusal);
	// 3.8.4 requires an external delete to hit an existing node — a
	// missing ID (deleted concurrently, or a stale target) is a
	// synchronous "tree not found" error where 3.8.3 answered a success
	// no-op. Same stale-target treatment as edit/move: the kernel error
	// surfaces verbatim, with the fresh outline attached so the agent
	// re-targets. Transport classes carry the unverified-outcome verdict.
	const removed = await runMutation(input, { blockId }, doc, () =>
		kernel.deleteBlock(blockId),
	);
	if ("status" in removed) return removed;
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the delete may already be applied (finishWrite doc).
	return finishWrite(name, { blockId }, async () => {
		// Verified, not trusted: on a kernel that no-ops a missing ID (3.8.3)
		// the walk-set evidence (target gone) is the report, never assumed;
		// 3.8.4 errors above instead.
		const postWalk = await walkBlockTree(kernel, doc.rootId);
		const targetGone = !idSet(postWalk).has(blockId);
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		const tail = await echoTail(input, doc, postWalk);
		// The removed block's pre-delete row is in hand — the receipt is
		// free. Gated on the walk-set evidence: a no-op kernel (3.8.3)
		// deleted nothing, so there is no receipt to give.
		const receipt = targetGone
			? deletedBlocksTail(input.sessionId, [
					{ id: blockId, content: row.content },
				])
			: undefined;
		return {
			status: "ok",
			message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${targetGone ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} orphaned ref(s)`,
			kb: name,
			blockId,
			targetGone,
			invalidRefs: {
				count: invalidRefs.count,
				hpaths: invalidRefs.hpaths,
			},
			...receipt,
			...tail,
		};
	});
}
