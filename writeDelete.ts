// The delete flow: block-level deleteBlock (confirmation shows the block's
// current content + inbound refs) or doc-level removeDocByID (the delete
// set is the walk set). An absent target is the kernel's success no-op —
// the walk-set evidence reports the end state, never assumed.

import type { Envelope } from "./envelope.js";
import { walkBlockTree } from "./walk.js";
import {
	backlinkSummary,
	blockInDoc,
	confirmGate,
	deleteSetDisplay,
	echoTail,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { backlinkCheck, finishWrite, idSet } from "./writeResult.js";

export async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
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
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		await kernel.removeDocByID(doc.rootId);
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
	if (row.content !== null) {
		// Confirmation only when there is something to delete — an absent
		// target is the kernel's success no-op (stale-target record): no
		// dialog, the walk-set evidence below reports the end state.
		const display = await deleteSetDisplay(kernel, sessionId, [
			{ id: blockId, content: row.content },
		]);
		const summary =
			`Delete block ${blockId} in '${doc.title}' (KB ${name})\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			backlinkSummary(display);
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
	}
	await kernel.deleteBlock(blockId);
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the delete may already be applied (finishWrite doc).
	return finishWrite(name, { blockId }, async () => {
		// Verified, not trusted: a missing ID is a kernel success no-op —
		// the walk-set evidence (target gone) is the report, never assumed.
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
