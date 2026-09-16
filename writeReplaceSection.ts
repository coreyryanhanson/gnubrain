// The replace-section flow: enumerate the section's delete set from the
// document-order walk → confirm (delete-set display) → insert-before-delete
// in one call — a mid-sequence failure must cost visible duplication, never
// loss.

import { SiYuanApiError } from "siyuan-kernel-api";
import { errorEnvelope, type Envelope } from "./envelope.js";
import { deriveAppendAnchor, sectionDeleteSet } from "./writeAnchors.js";
import { walkBlockTree } from "./walk.js";
import {
	backlinkSummary,
	confirmGate,
	deleteSetDisplay,
	echoTail,
	headingInWalk,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import {
	assertFreshContent,
	backlinkCheck,
	establishBaselines,
	finishWrite,
	idSet,
	newBlockIdFrom,
	walkDoc,
} from "./writeResult.js";

export async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Delete-set enumeration rides the document-order walk, never SQL.
	const walk = await walkBlockTree(kernel, doc.rootId, 1);
	const heading = headingInWalk(walk, doc, headingId);
	if ("status" in heading) return heading;
	const deleteSet = sectionDeleteSet(walk, headingId);
	// The confirmation displays the enumerated delete set — block count,
	// the trailing blocks' current content (spill budget applies), and the
	// same backlink visibility `delete` carries.
	const display = await deleteSetDisplay(kernel, sessionId, deleteSet);
	const summary =
		`Replace the section under heading '${heading.content}' in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
		`delete set: ${display.deleteSet.count} block(s)\n\n` +
		`current content:\n${display.deleteSet.contentPreview}\n\n` +
		backlinkSummary(display) +
		(display.backlinks.count > 0
			? " — replacing orphans refs into the section's content blocks (the heading ID survives)"
			: "");
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	// Fresh-content precondition: establish missing baselines from the same
	// blocks.content read the post-approval re-check uses (representation-
	// independent), then re-check before any kernel call.
	await establishBaselines(
		kernel,
		baselines,
		deleteSet.map((b) => b.id),
	);
	const stale = await assertFreshContent(
		kernel,
		baselines,
		deleteSet.map((b) => ({
			blockId: b.id,
			baseline: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// insert-before-delete: a mid-sequence failure must cost visible
	// duplication, never loss. Same anchor rule as `append`.
	const anchor = deriveAppendAnchor(walk, headingId);
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// Everything from here on is post-mutation — a drop anywhere in the
	// insert verification, the delete sweep, or the echo must never read
	// as "unreachable" while the insert has landed and the sweep may be
	// half-applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		const newBlockId = newBlockIdFrom(tx);
		// Verify the insert landed BEFORE any delete — a silent rollback
		// must not sweep the old section away (stale-target record).
		const preIds = idSet(walk);
		const afterInsertWalk = await walkDoc(kernel, doc.rootId);
		const landed =
			newBlockId !== undefined &&
			!preIds.has(newBlockId) &&
			idSet(afterInsertWalk).has(newBlockId);
		if (!landed) {
			return errorEnvelope(
				`verified-insert failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; the old section is untouched`,
				{ kb: name, anchor: anchor.anchor },
			);
		}
		// Deletes ride the pre-enumerated set — a post-insert re-enumeration
		// would sweep the replacement into the delete set.
		for (const [i, block] of deleteSet.entries()) {
			try {
				await kernel.deleteBlock(block.id);
			} catch (err) {
				if (!(err instanceof SiYuanApiError)) throw err;
				// The insert has landed and part of the old section may be
				// swept — a bare error here invites a re-run that duplicates
				// the replacement. Surface the partial state instead.
				return errorEnvelope(
					`replace partially applied: the new section is in place (block '${newBlockId}') but the delete of '${block.id}' failed (${err instanceof Error ? err.message : String(err)})` +
						(i > 0 ? `, and ${i} earlier block(s) were deleted` : "") +
						` — do NOT re-run; delete the remaining old-section block(s) to finish: ${deleteSet
							.slice(i)
							.map((b) => b.id)
							.join(", ")}`,
					{
						kb: name,
						anchor: anchor.anchor,
						newBlockId,
						partialReplace: true,
						deletedBlockIds: deleteSet.slice(0, i).map((b) => b.id),
						remainingBlockIds: deleteSet.slice(i).map((b) => b.id),
					},
				);
			}
		}
		// invalidRefs (write-result contract): post-write echo over the
		// enumerated delete set — what actually got orphaned, verified.
		const invalidRefs = await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		);
		// The echo tail re-walks AFTER the deletes: the post-insert walk still
		// carries the swept blocks, and the outline-freshness contract requires
		// the post-write tree (write-result contract).
		const tail = await echoTail(input, doc, undefined, [newBlockId]);
		return {
			status: "ok",
			message: `replaced the section under heading '${heading.content}' in '${doc.title}' (KB ${name}) — delete set ${deleteSet.length} block(s), ${invalidRefs.count} orphaned ref(s)`,
			kb: name,
			anchor: anchor.anchor,
			newBlockId,
			invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
			...tail,
		};
	});
}
