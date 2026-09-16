// The edit flow: updateBlock on an agent-supplied blockId target.

import { SiYuanApiError } from "siyuan-kernel-api";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	blockInDoc,
	confirmGate,
	echoTail,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { assertFreshContent, finishWrite } from "./writeResult.js";

export async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if ("refusal" in row) return refusedEnvelope(row.refusal);
	if (row.content !== null) {
		// Fresh-content baseline: served content where the session has seen
		// this block, else the block's CURRENT content — displayed in the
		// confirmation; approval establishes it.
		const summary =
			`Edit block ${blockId} in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
			`current content:\n${row.content}`;
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		if (baselines.servedHash(blockId) === undefined) {
			baselines.remember(blockId, row.content);
		}
		// Precondition: re-check after approval, before the kernel call.
		const stale = await assertFreshContent(
			kernel,
			baselines,
			[{ blockId, baseline: baselines.servedHash(blockId) }],
			{ sessionId, docId: doc.rootId },
		);
		if (stale !== null) return stale;
	}
	// An absent target is never refused here — updateBlock's synchronous
	// not-found error surfaces verbatim below (stale-target record).
	try {
		await kernel.updateBlock({ id: blockId, data: input.body });
	} catch (err) {
		// stale-target record: updateBlock errors synchronously — surface
		// verbatim with the fresh outline attached. Network classes rethrow
		// for runKbCall's unreachable classification — correct here, the
		// mutation itself did not land.
		if (!(err instanceof SiYuanApiError)) throw err;
		const tail = await echoTail(input, doc);
		return errorEnvelope(err.message, { kb: name, ...tail });
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc).
	return finishWrite(name, {}, async () => {
		const tail = await echoTail(input, doc, undefined, [blockId]);
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			...tail,
		};
	});
}
