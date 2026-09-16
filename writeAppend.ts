// The append flow: tool-derived nextID anchor, doc-end fallback; the
// returned id is verified against the post-write walk set.

import { errorEnvelope, type Envelope } from "./envelope.js";
import { deriveAppendAnchor } from "./writeAnchors.js";
import { walkBlockTree } from "./walk.js";
import {
	confirmGate,
	echoTail,
	headingInWalk,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, idSet, newBlockIdFrom } from "./writeResult.js";

export async function runAppendMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	// The walk doubles as anchor data AND the pre-write set for verification
	// (stale-target record: the same walk the anchor derivation fetches).
	const walk = await walkBlockTree(kernel, doc.rootId);
	if (params.headingId !== undefined) {
		const heading = headingInWalk(walk, doc, params.headingId);
		if ("status" in heading) return heading;
	}
	const anchor = deriveAppendAnchor(walk, params.headingId);
	const summary = `Append ${input.body.length} chars to '${doc.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the insert may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// verified, not trusted: the returned id must appear among the
		// post-write walk set's newly-present ids — a tree-level miss rolls
		// back silently behind HTTP success. Multi-block: diff-based;
		// single-block: exactly one id (pinned live).
		const newBlockId = newBlockIdFrom(tx);
		const preIds = idSet(walk);
		const postWalk = await walkBlockTree(kernel, doc.rootId);
		const postIds = idSet(postWalk);
		const landed =
			newBlockId !== undefined &&
			!preIds.has(newBlockId) &&
			postIds.has(newBlockId);
		if (!landed) {
			const tail = await echoTail(input, doc, postWalk);
			return errorEnvelope(
				`verified-append failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; nothing was inserted`,
				{ kb: name, anchor: anchor.anchor, ...tail },
			);
		}
		const tail = await echoTail(input, doc, postWalk, [newBlockId]);
		return {
			status: "ok",
			message: `appended to '${doc.title}' (KB ${name}) — newBlockId ${newBlockId as string}`,
			kb: name,
			anchor: anchor.anchor,
			newBlockId,
			...tail,
		};
	});
}
