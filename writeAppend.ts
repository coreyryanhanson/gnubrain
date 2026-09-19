// The append flow: tool-derived nextID anchor, doc-end fallback; the
// returned id is verified against the post-write walk set.

import { errorEnvelope, type Envelope } from "./envelope.js";
import { deriveAppendAnchor, type AppendPlacement } from "./writeAnchors.js";
import { walkBlockTree, type WalkedBlock } from "./walk.js";
import {
	confirmGate,
	echoTail,
	headingInWalk,
	insertRollbackReason,
	runMutation,
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
	// (the same walk the anchor derivation fetches).
	const walk = await walkBlockTree(kernel, doc.rootId);
	let resolvedHeading: WalkedBlock | undefined;
	if (params.headingId !== undefined) {
		const heading = headingInWalk(walk, doc, params.headingId);
		if ("status" in heading) return heading;
		resolvedHeading = heading;
	}
	const anchor = deriveAppendAnchor(
		walk,
		resolvedHeading,
		params.placement as AppendPlacement | undefined,
	);
	const summary = `Append ${input.body.length} chars to '${doc.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	const gate = await confirmGate(input, summary);
	if (gate !== null) return gate;
	const tx = await runMutation(input, { anchor: anchor.anchor }, doc, () =>
		anchor.kind === "append"
			? kernel.appendBlock({
					data: input.body,
					parentID: anchor.containerId ?? doc.rootId,
				})
			: kernel.insertBlock({ data: input.body, nextID: anchor.nextID }),
	);
	if ("status" in tx) return tx;
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the insert may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// A markdown insert lands as exactly one doOperations entry with
		// the whole body embedded in its data (pinned live: N-paragraph
		// body → one insert op), so doOperations[0].id covers the whole
		// payload. The landed predicate + rollback wording live in
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
