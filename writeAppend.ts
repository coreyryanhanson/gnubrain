// The append flow: tool-derived nextID anchor, doc-end fallback; the
// returned id is verified against the post-write walk set.

import { errorEnvelope, type Envelope } from "./envelope.js";
import { deriveAppendAnchor } from "./writeAnchors.js";
import { walkBlockTree } from "./walk.js";
import {
	confirmGate,
	echoTail,
	headingInWalk,
	insertRollbackReason,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, idSet, newBlockIdFrom } from "./writeResult.js";

export async function runAppendMode(
	input: WriteFlowInput,
	doc: DocTarget,
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
	if (input.dialog) {
		const gate = await confirmGate(input, summary);
		if (gate !== null) return gate;
	}
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the insert may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// Multi-block: diff-based; single-block: exactly one id (pinned
		// live). The landed predicate + rollback wording live in
		// insertRollbackReason (shared with replace-section).
		const newBlockId = newBlockIdFrom(tx);
		const postWalk = await walkBlockTree(kernel, doc.rootId);
		const rollback = insertRollbackReason(
			newBlockId,
			idSet(walk),
			idSet(postWalk),
		);
		if (rollback !== undefined) {
			const tail = await echoTail(input, doc, postWalk);
			return errorEnvelope(
				`verified-append failed: ${rollback} — the transaction rolled back silently behind HTTP success; nothing was inserted`,
				{ kb: name, anchor: anchor.anchor, ...tail },
			);
		}
		const tail = await echoTail(input, doc, postWalk, [newBlockId as string]);
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
