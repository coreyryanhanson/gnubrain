// The delete flow: block-level deleteBlock (confirmation shows the block's
// current content + inbound refs) or doc-level removeDocByID (the delete
// set is the walk set). An absent target is answered by the kernel per its
// generation — 3.8.3 a success no-op (the walk-set evidence reports the end
// state), 3.8.4 a synchronous "tree not found" error surfaced verbatim with
// the fresh outline attached, like edit/move.

import { refusedEnvelope, type Envelope } from "./envelope.js";
import { walkBlockTree } from "./walk.js";
import {
	backlinkSummary,
	blockInDoc,
	confirmGate,
	deleteSetDisplay,
	echoTail,
	mutationFailed,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { backlinkCheck, finishWrite, idSet } from "./writeResult.js";

export async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, params } = input;
	if (params.doc === true) {
		// Whole-doc delete: the delete set is the walk set; backlink
		// visibility rides the confirmation (delete mode).
		const walk = await walkBlockTree(kernel, doc.rootId);
		const display = await deleteSetDisplay(kernel, sessionId, walk);
		const summary =
			`Delete doc '${doc.title}' (${doc.rootId}) in KB ${name}\n\n` +
			`delete set: ${display.deleteSet.count} block(s)\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			backlinkSummary(display);
		const gate = await confirmGate(input, summary);
		if (gate !== null) return gate;
		try {
			await kernel.removeDocByID(doc.rootId);
		} catch (err) {
			const failed = await mutationFailed(
				input,
				err,
				{ docId: doc.rootId },
				doc,
			);
			if (failed !== undefined) return failed;
			throw err;
		}
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the doc may already be gone (finishWrite doc).
		return finishWrite(name, {}, async () => {
			// invalidRefs rides the pre-delete walk set — the doc is gone.
			const invalidRefs = await backlinkCheck(
				kernel,
				walk.map((b) => b.id),
			);
			// Pinned shape: only invalidRefs — no doc left to outline.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} orphaned ref(s)`,
				kb: name,
				invalidRefs: {
					count: invalidRefs.count,
					hpaths: invalidRefs.hpaths,
				},
			};
		});
	}
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if ("refusal" in row) return refusedEnvelope(row.refusal);
	if (row.content !== null) {
		// Confirmation only when there is something to delete — an absent
		// target never dialogs: 3.8.3 answers a
		// success no-op the walk-set evidence below reports; 3.8.4 answers
		// a synchronous error surfaced verbatim below.
		const display = await deleteSetDisplay(kernel, sessionId, [
			{ id: blockId, content: row.content },
		]);
		const summary =
			`Delete block ${blockId} in '${doc.title}' (KB ${name})\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			backlinkSummary(display);
		const gate = await confirmGate(input, summary);
		if (gate !== null) return gate;
	}
	try {
		await kernel.deleteBlock(blockId);
	} catch (err) {
		// 3.8.4 requires an external delete to hit an existing node — a
		// missing ID (deleted concurrently, or a stale target) is a
		// synchronous "tree not found" error where 3.8.3 answered a success
		// no-op. Same stale-target treatment as edit/move: the kernel error
		// surfaces verbatim, with the fresh outline attached so the agent
		// re-targets. Transport classes carry the unverified-outcome verdict.
		const failed = await mutationFailed(input, err, { blockId }, doc);
		if (failed !== undefined) return failed;
		throw err;
	}
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
			...tail,
		};
	});
}
