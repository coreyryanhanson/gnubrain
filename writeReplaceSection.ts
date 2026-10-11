// The replace-section flow: enumerate the section from the document-order
// walk → fresh-content precondition → one verified sequence call (the
// primitives own the insert-before-sweep ordering and the enumeration
// timing) → envelope wording. A mid-sequence failure must cost visible
// duplication, never loss — that invariant lives with the sequence now.

import {
	SiYuanKernelError,
	appendAnchorOf,
	backlinkCheck,
	sectionOf,
	walkBlockTree,
} from "siyuan-kb-primitives";
import {
	replaceSectionVerified,
	type SweepRefusal,
} from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	markPartialReplace,
	refusedEnvelope,
	type Envelope,
} from "./envelope.js";
import { deletedBlocksTail, echoTail, mutationFailure } from "./writeEcho.js";
import {
	headingInWalk,
	placementRefusal,
	replaceSectionWalkTruncatedMessage,
	staleHeadingMessage,
	type DocTarget,
	freshContentRefusal,
	type WriteFlowInput,
} from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import { appendAnchorEcho, insertLandedRefusal } from "./writeVerdicts.js";

/** The delete-sweep refusal frame — the sweep outcome arms the flow does
 * not handle itself: `swept` (the success path continues), `interrupted`
 * (the error instance must ride to the catch sites with its partial state
 * attached, so it cannot render here) and `walk-failed` (likewise rethrown
 * — the sweep is complete but unjudged, rendered by the finish-write
 * classifier, never here). The parameter is the primitives' own
 * `SweepRefusal` (owned by sweep.ts, discriminant-only exclusion in the
 * module that owns the union), so an arm-shape change upstream re-derives
 * this set here instead of a restated `Exclude` silently re-admitting a
 * terminal arm. `members-survived` is the fail-loud arm: a sweep whose
 * deletes all acked but left members in the tree renders this refusal
 * with the survivors itemized, never an ok receipt. */
function sweepRefusalEnvelope(
	outcome: SweepRefusal,
	ctx: {
		kb: string;
		anchor: string;
		newBlockId: string;
		memberIds: string[];
		/** The echo tail over the verdict's certified post-sweep walk, served
		 * on the two terminal arms — the recovery evidence inline, so the
		 * agent never re-fetches state the verdict already holds. `partial`
		 * carries no walk (the sweep stopped before the verification walk),
		 * so its tail stays undefined. */
		tail?: Record<string, unknown> | undefined;
	},
): Envelope {
	switch (outcome.kind) {
		case "partial": {
			const deleted = outcome.deletedBlockIds.length;
			return errorEnvelope(
				`replace partially applied: the new section is in place (block '${ctx.newBlockId}') but the delete of '${outcome.failedId}' failed (${outcome.message})` +
					(deleted > 0
						? `, and ${deleted} earlier block(s) were deleted`
						: "") +
					` — do NOT re-run; delete the remaining old-section block(s) to finish: ${outcome.remainingBlockIds.join(", ")}`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: outcome.deletedBlockIds,
					remainingBlockIds: outcome.remainingBlockIds,
				},
			);
		}
		case "cascade-consumed":
			return errorEnvelope(
				`verified-replace failed: the new section block '${ctx.newBlockId}' is absent from the post-write tree — the delete sweep's cascade consumed the replacement; do not retry`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: ctx.memberIds,
					remainingBlockIds: [],
					...ctx.tail,
				},
			);
		case "members-survived":
			return errorEnvelope(
				`verified-sweep failed: the delete of '${outcome.survivedIds.join("', '")}' reported success but the block(s) are still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the surviving block(s) by id`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: ctx.memberIds.filter(
						(id) => !outcome.survivedIds.includes(id),
					),
					remainingBlockIds: outcome.survivedIds,
					...ctx.tail,
				},
			);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled sweep verdict");
}

export async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Target resolution rides the document-order walk, never SQL. The
	// sectionOf call is the closure the fresh-content precondition reads —
	// session baselines cannot cross into the primitives, so the flow
	// derives it too; the sequence re-derives the identical section
	// internally from this same walk.
	const tree = await walkBlockTree(kernel, doc.rootId);
	const resolved = headingInWalk(tree, doc, headingId);
	if ("status" in resolved) return resolved;
	const deleteSet = placementRefusal(
		sectionOf(tree, headingId),
		headingId,
		doc,
		name,
		() => refusedEnvelope(replaceSectionWalkTruncatedMessage, { kb: name }),
	);
	if ("status" in deleteSet) return deleteSet;
	const section = deleteSet.section;
	// Fresh-content precondition: a concurrency guard, not a consent
	// mechanism (the grant resolved at the kb_write entry). One wrapper step
	// right before the kernel call — the judgment seeds missing baselines
	// from the SQL index and checks against the live tree in one pass (a
	// change landing since the walk is caught as stale_content, not
	// laundered into the baseline).
	const stale = await freshContentRefusal(
		kernel,
		baselines,
		section.closure.map((b) => ({
			blockId: b.id,
			baselineHash: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// The anchor echo is wording garnish for the failure arms — projected
	// from the section this flow already enumerated, the same projection
	// the sequence derives internally for the mutation.
	const echo = appendAnchorEcho(appendAnchorOf(section));
	const outcome = await replaceSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
		headingId,
		body: input.body,
	});
	// The insert leg's pre-judgment failure ladder — no mutation has landed,
	// so these map outside the finish-write wrapper.
	if (
		outcome.kind === "drift" ||
		outcome.kind === "transport-unverified" ||
		outcome.kind === "kernel-refused" ||
		outcome.kind === "verification-failed"
	) {
		return mutationFailure(outcome, input, doc, { anchor: echo });
	}
	if (outcome.kind === "walk-truncated") {
		// The sequence refuses a truncated pre-mutation walk before any
		// kernel call — the enumeration, anchor, and pre-write id set would
		// derive from incomplete evidence.
		return refusedEnvelope(replaceSectionWalkTruncatedMessage, {
			kb: name,
			anchor: echo,
		});
	}
	if (outcome.kind === "no-section") {
		// Unreachable — the sequence re-derives the same section from the
		// same walk this flow just resolved. Fail-closed tripwire.
		return refusedEnvelope(staleHeadingMessage(headingId, doc));
	}
	// Everything from here on is post-mutation — a drop anywhere in the
	// delete sweep or the echo must never read as "unreachable" while the
	// insert has landed and the sweep may be half-applied (finishWrite
	// doc). The interrupted sweep arm throws its error from in here so the
	// wrapper's classifier renders verificationFailed with the partial
	// state merged.
	return finishWrite(name, { anchor: echo }, async () => {
		switch (outcome.kind) {
			case "insert-unlanded": {
				// No echo tail here, unlike append's unlanded refusal: the
				// refusal wording already carries the evidence that matters —
				// the old section is untouched — and the extra walk + root
				// echo would spend two kernel calls on a failure path without
				// changing the guidance.
				const unlanded = insertLandedRefusal(outcome.verdict);
				return errorEnvelope(
					`verified-insert failed: ${unlanded} — the old section is untouched`,
					{ kb: name, anchor: appendAnchorEcho(outcome.anchor) },
				);
			}
			case "sweep-interrupted":
				// Transport-class failures (429, auth, network, timeout) have
				// their own classification paths — 429/auth flow to runKbCall
				// (cooldown/breaker), network/timeout land in finishWrite
				// (verificationFailed). The insert has landed and part of the
				// old section may be swept, so the partial state rides the
				// error for the catch sites to merge into whatever envelope the
				// classifier produces. Non-kernel error classes rethrow
				// unmarked.
				if (outcome.error instanceof SiYuanKernelError) {
					markPartialReplace(outcome.error, {
						partialReplace: true,
						newBlockId: outcome.insertedId,
						deletedBlockIds: outcome.deletedBlockIds,
						remainingBlockIds: outcome.remainingBlockIds,
					});
				}
				throw outcome.error;
			case "sweep-walk-failed":
				// Every member delete acked but the verification walk itself
				// failed — the sweep is complete but unjudged, so this must
				// never surface as a raw transport error ("SiYuan unreachable")
				// while the whole write is applied. Rethrow inside the
				// finish-write wrapper with the partial state attached: the
				// fully-swept delete set rides as the receipt, nothing remains
				// pending, and the classifier renders verificationFailed.
				if (outcome.error instanceof SiYuanKernelError) {
					markPartialReplace(outcome.error, {
						partialReplace: true,
						newBlockId: outcome.insertedId,
						deletedBlockIds: outcome.deletedBlockIds,
						remainingBlockIds: [],
					});
				}
				throw outcome.error;
			case "sweep-refused": {
				// Any refusal arm carrying a certified post-sweep walk serves
				// it as the inline outline — the recovery evidence — and seeds
				// the baselines from that walk (the snapshot the judgment was
				// rendered from); echoTail with no refresh IDs does exactly
				// that. `partial` declares none and stops before its
				// verification walk — no certified snapshot to serve.
				const certifiedWalk =
					"postWalk" in outcome.outcome ? outcome.outcome.postWalk : undefined;
				const refusalCtx = {
					kb: name,
					anchor: appendAnchorEcho(outcome.anchor),
					newBlockId: outcome.insertedId,
					memberIds: outcome.memberIds,
				};
				if (certifiedWalk === undefined) {
					return sweepRefusalEnvelope(outcome.outcome, refusalCtx);
				}
				return sweepRefusalEnvelope(outcome.outcome, {
					...refusalCtx,
					tail: await echoTail(input, doc, certifiedWalk),
				});
			}
			case "sweep-truncated":
				// The deletes acked but the post-sweep walk hit the depth
				// bound: the swept judgment's absence facts are unconfirmed.
				// Applied-but-unverified — never ok, never a rollback.
				return errorEnvelope(
					`replace applied but unverified: the replacement (block '${outcome.insertedId}') is in place and every member delete acked, but the verification walk hit the document's depth bound — whether the old section is fully gone could not be confirmed. Do NOT re-run; re-fetch the outline (kb_read) and check the old section's blocks by id before any cleanup`,
					{
						kb: name,
						anchor: appendAnchorEcho(outcome.anchor),
						newBlockId: outcome.insertedId,
					},
				);
			case "swept": {
				// invalidRefs: post-write echo over the section's closure —
				// what actually got orphaned, verified.
				const invalidRefs = await backlinkCheck(
					kernel,
					outcome.closure.map((b) => b.id),
				);
				// The echo tail reflects the tree AFTER the deletes: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, outcome.postWalk, [
					outcome.insertedId,
				]);
				return {
					status: "ok",
					// The closure is what left the doc — the members the sweep
					// deleted explicitly plus the descendants their cascade
					// removed. The receipt itemizes it (ids + walk content) —
					// the post-write visibility the pre-write grant dialog
					// does not carry.
					message: `replaced the section under heading '${outcome.headingContent}' in '${doc.title}' (KB ${name}) — delete set ${outcome.closure.length} block(s), ${invalidRefs.count} doc(s) with orphaned refs`,
					kb: name,
					anchor: appendAnchorEcho(outcome.anchor),
					newBlockId: outcome.insertedId,
					invalidRefs,
					...deletedBlocksTail(sessionId, outcome.closure),
					...tail,
				};
			}
		}
		outcome satisfies never;
		return errorEnvelope("internal: unhandled replace-section verdict");
	});
}
