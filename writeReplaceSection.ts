// The replace-section flow: enumerate the section's delete set from the
// document-order walk → refuse an anchor nested inside the delete set →
// confirm (delete-set display) → insert-before-delete in one call, verified
// against the post-write tree — a mid-sequence failure must cost visible
// duplication, never loss.

import { SiYuanApiError, SiYuanKernelError } from "siyuan-kernel-api";
import {
	errorEnvelope,
	markPartialReplace,
	refusedEnvelope,
	type Envelope,
	type PartialReplaceState,
} from "./envelope.js";
import {
	deriveAppendAnchor,
	enclosingMember,
	sectionDeleteSet,
	sweepTargets,
} from "./writeAnchors.js";
import { walkBlockTree } from "./walk.js";
import {
	backlinkSummary,
	confirmGate,
	deleteSetDisplay,
	echoTail,
	headingInWalk,
	insertRollbackReason,
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
} from "./writeResult.js";

export async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Delete-set enumeration rides the document-order walk, never SQL.
	const walk = await walkBlockTree(kernel, doc.rootId);
	const heading = headingInWalk(walk, doc, headingId);
	if ("status" in heading) return heading;
	const deleteSet = sectionDeleteSet(walk, headingId);
	// The anchor heading must not nest inside a block the sweep deletes: the
	// kernel inserts before it INSIDE that container, so the container's
	// delete cascade would consume the replacement and the heading itself.
	// Refused before the dialog, while the agent can re-target instead.
	const anchor = deriveAppendAnchor(walk, heading);
	if (anchor.kind === "insert") {
		const enclosing = enclosingMember(
			walk,
			anchor.nextID,
			new Set(deleteSet.map((b) => b.id)),
		);
		if (enclosing !== undefined) {
			return refusedEnvelope(
				`cannot replace the section under heading '${heading.content}': the next heading ('${anchor.nextID}') sits inside block '${enclosing}', which the replace deletes — the sweep's cascade would delete that heading and the new body with it; replace the container's blocks individually instead`,
				{ kb: name },
			);
		}
	}
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
	// Fresh-content precondition: establish missing baselines BEFORE the
	// dialog, from the same blocks.content read the post-approval re-check
	// uses (representation-independent). Approval then establishes exactly
	// the content in view — a change landing between display and approval is
	// caught by the re-check below as stale_content, not laundered into the
	// baseline by a post-approval read.
	await establishBaselines(
		kernel,
		baselines,
		deleteSet.map((b) => b.id),
	);
	const gate = await confirmGate(input, summary);
	if (gate !== null) return gate;
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
		// must not sweep the old section away.
		const afterInsertWalk = await walkBlockTree(kernel, doc.rootId);
		const rollback = insertRollbackReason(
			newBlockId,
			idSet(walk),
			idSet(afterInsertWalk),
		);
		if (rollback !== undefined) {
			return errorEnvelope(
				`verified-insert failed: ${rollback} — the transaction rolled back silently behind HTTP success; the old section is untouched`,
				{ kb: name, anchor: anchor.anchor },
			);
		}
		// Rollback verified — the kernel-returned id is present in the
		// post-write tree, so the partial-apply evidence can name it.
		const landedId: string = newBlockId as string;
		// Deletes ride the pre-enumerated set's forest roots — a post-insert
		// re-enumeration would sweep the replacement into the delete set, and
		// the descendants the kernel cascade already removed are never swept
		// (a delete of a cascaded descendant is a synchronous tree-not-found
		// error that would false-report a partial replace).
		const sweep = sweepTargets(deleteSet);
		for (const [i, block] of sweep.entries()) {
			try {
				await kernel.deleteBlock(block.id);
			} catch (err) {
				const partialIds = (): Pick<
					PartialReplaceState,
					"deletedBlockIds" | "remainingBlockIds"
				> => ({
					deletedBlockIds: sweep.slice(0, i).map((b) => b.id),
					remainingBlockIds: sweep.slice(i).map((b) => b.id),
				});
				if (!(err instanceof SiYuanApiError)) {
					// Transport-class failures (429, auth, network, timeout) have
					// their own classification paths — 429/auth flow to runKbCall
					// (cooldown/breaker), network/timeout land in finishWrite
					// (verificationFailed). The insert has landed and part of
					// the old section may be swept, so the partial state rides
					// the error for the catch sites to merge into whatever
					// envelope the classifier produces.
					if (err instanceof SiYuanKernelError) {
						markPartialReplace(err, {
							partialReplace: true,
							newBlockId: landedId,
							...partialIds(),
						});
					}
					throw err;
				}
				// The insert has landed and part of the old section may be
				// swept — a bare error here invites a re-run that duplicates
				// the replacement. Surface the partial state instead.
				return errorEnvelope(
					`replace partially applied: the new section is in place (block '${landedId}') but the delete of '${block.id}' failed (${err instanceof Error ? err.message : String(err)})` +
						(i > 0 ? `, and ${i} earlier block(s) were deleted` : "") +
						` — do NOT re-run; delete the remaining old-section block(s) to finish: ${sweep
							.slice(i)
							.map((b) => b.id)
							.join(", ")}`,
					{
						kb: name,
						anchor: anchor.anchor,
						newBlockId: landedId,
						partialReplace: true,
						...partialIds(),
					},
				);
			}
		}
		// invalidRefs: post-write echo over the
		// enumerated delete set — what actually got orphaned, verified.
		const invalidRefs = await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		);
		// Verified, not trusted: the sweep's cascade must never have consumed
		// the replacement (an anchor nested inside a swept container is
		// refused before the dialog, so this only fires on kernel
		// misbehavior) — a silent loss here must not read as ok.
		const postSweepWalk = await walkBlockTree(kernel, doc.rootId);
		if (!idSet(postSweepWalk).has(landedId)) {
			return errorEnvelope(
				`verified-replace failed: the new section block '${landedId}' is absent from the post-write tree — the delete sweep's cascade consumed the replacement; do not retry`,
				{
					kb: name,
					anchor: anchor.anchor,
					newBlockId: landedId,
					partialReplace: true,
					deletedBlockIds: sweep.map((b) => b.id),
					remainingBlockIds: [],
				},
			);
		}
		// The echo tail must reflect the tree AFTER the deletes: the walk
		// above IS that tree — reused, not re-traversed.
		const tail = await echoTail(input, doc, postSweepWalk, [
			newBlockId as string,
		]);
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
