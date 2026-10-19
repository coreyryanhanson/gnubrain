// The replace-section flow: enumerate the section from the document-order
// walk → one verified sequence call (the primitives own the fresh-content
// guard over the derived judged set, the insert-before-sweep ordering and
// the enumeration timing) → envelope wording. A mid-sequence failure must
// cost visible duplication, never loss — that invariant lives with the
// sequence.

import {
	appendAnchorOf,
	backlinkCheck,
	partitionByAbsence,
	sectionOf,
	walkBlockTree,
	type PartitionByAbsence,
} from "siyuan-kb-primitives";
import {
	replaceSectionVerified,
	type SweepRefusal,
} from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	partialApplyMarker,
	refusedEnvelope,
	type Envelope,
} from "./envelope.js";
import {
	deletedBlocksTail,
	echoTail,
	mutationFailure,
	rethrowClassified,
} from "./writeEcho.js";
import {
	anchorRefusal,
	headingInWalk,
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	appendAnchorEcho,
	blockInDocRefusalKind,
	insertLandedRefusal,
	replaceSectionWalkTruncatedMessage,
} from "./writeVerdicts.js";

/** The delete-sweep `members-survived` sentence and its payload fields —
 * replace-section's sweep-leg wording: a delete acked but the block is
 * still present in the post-write tree. The batched delete-section words
 * its own survivor arm (writeDeleteSection) — the batch's recovery
 * doctrine forbids this sentence's by-id instruction (a damaged index
 * makes by-id deletes silently no-op), so the two consumers must NOT
 * share it. `truncated` is true when the verification walk was
 * depth-truncated — the payload then carries unconfirmedBlockIds
 * (absence unconfirmed), and the sentence says so. The label names the
 * sweep, not the per-block delete: the block-delete flow's singular
 * variant (writeDelete.ts) is a different primitive arm and keeps its
 * own sentence. */
function sweepMembersSurvivedMessage(
	survivedIds: string[],
	truncated: boolean,
): string {
	return (
		`verified-sweep failed: the delete of '${survivedIds.join("', '")}' reported success but the block(s) are still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the surviving block(s) by id` +
		(truncated
			? "; the verification walk was depth-truncated, so ids absent from the walk are not claimed as deleted — see unconfirmedBlockIds and reconcile from the outline"
			: "")
	);
}

/** The payload fields derived from the acked-set split — the marker, the
 * certified/unconfirmed absence half, and the pending set. On a complete
 * walk the absence half is certified and rides deletedBlockIds; on a
 * truncated walk it is unconfirmed — but the acked ids still ride the
 * receipt (as unconfirmedBlockIds), never vanish from it. */
function sweepMembersSurvivedFields(
	split: PartitionByAbsence,
): Record<string, unknown> {
	return {
		...partialApplyMarker(split.presentIds),
		...(split.kind === "unconfirmed"
			? { unconfirmedBlockIds: split.unconfirmedAbsentIds }
			: { deletedBlockIds: split.absentIds }),
		remainingBlockIds: split.presentIds,
	};
}

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
						? `, and the deletes of ${deleted} earlier block(s) acked unverified (no verification walk ran)`
						: "") +
					` — do NOT re-run; delete the remaining old-section block(s) to finish: ${outcome.remainingBlockIds.join(", ")}`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					...partialApplyMarker(outcome.remainingBlockIds),
					unconfirmedBlockIds: outcome.deletedBlockIds,
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
					// Terminal cascade-consumed marker, spread directly:
					// fully applied, judged, and lost — never rethrown, so
					// no shared render frame sees it.
					appliedConsumed: true,
					deletedBlockIds: ctx.memberIds,
					remainingBlockIds: [],
					...ctx.tail,
				},
			);
		case "members-survived": {
			// Presence-derived complement of the survivors, split by the
			// shared primitives projection. The sentence and payload fields
			// live in this file: replace-section's sweep-leg wording — the
			// batched delete-section words its own survivor arm, whose
			// recovery doctrine forbids this sentence's by-id instruction.
			const split = partitionByAbsence(ctx.memberIds, outcome.postWalk);
			return errorEnvelope(
				sweepMembersSurvivedMessage(
					outcome.survivedIds,
					split.kind === "unconfirmed",
				),
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					...sweepMembersSurvivedFields(split),
					...ctx.tail,
				},
			);
		}
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
	// sectionOf call is the flow's own echo material (the anchor echo
	// below); the sequence re-derives the identical section internally
	// from this same walk.
	const tree = await walkBlockTree(kernel, doc.rootId);
	const resolved = headingInWalk(tree, doc, headingId);
	if ("status" in resolved) return resolved;
	const deleteSet = sectionOf(tree, headingId);
	// Inline narrowing: the fail-closed arms word in anchorRefusal
	// (writeTarget.ts).
	if (
		deleteSet.kind === "walk-truncated" ||
		deleteSet.kind === "heading-absent"
	) {
		return anchorRefusal(
			deleteSet.kind,
			doc,
			headingId,
			name,
			replaceSectionWalkTruncatedMessage,
		);
	}
	const section = deleteSet.section;
	// The fresh precondition is the primitive's, over the session lookup
	// (writeFresh.ts; the judged set derives from the enumeration walk
	// above — no second walk; see replaceSectionVerified's `baselineFor`).
	// An empty closure legitimately judges nothing — the sequence skips
	// the judgment there.
	// The anchor echo — projected from the section this flow already
	// enumerated, the same projection the sequence derives internally for
	// the mutation (the heading-absent tripwire below pins that
	// re-derivation).
	// Reused for both the pre-mutation failure arms and the verdict arms —
	// one source, never a second projection.
	const echo = appendAnchorEcho(appendAnchorOf(section));
	const outcome = await replaceSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
		headingId,
		body: input.body,
		baselineFor: baselines.servedBaseline,
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
	if (outcome.kind === "foreign") {
		// Pre-mutation provenance refusal — the same arm and the same
		// shared wording home as delete-section's (writeVerdicts doc): the
		// enumeration walk's root is not the claimed doc. Unreachable from
		// this flow (rootId and the walk derive from the same doc.rootId);
		// the arm keeps the sequence's contract self-contained — the
		// kernel's raw-id mutations could not detect the mismatch post-hoc.
		return refusedEnvelope(blockInDocRefusalKind(outcome, headingId, doc));
	}
	if (outcome.kind === "fresh-refused") {
		// The internal guard's refusal — nothing landed (the judgment runs
		// before the insert leg).
		return freshRefusalEnvelope(baselines, sessionId, name, outcome);
	}
	if (outcome.kind === "walk-truncated" || outcome.kind === "heading-absent") {
		// Unreachable — the sequence refuses a truncated pre-mutation walk
		// before any kernel call, and re-derives the same section from the
		// same walk this flow just resolved. Fail-closed tripwire.
		return anchorRefusal(
			outcome.kind,
			doc,
			headingId,
			name,
			replaceSectionWalkTruncatedMessage,
		);
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
					{ kb: name, anchor: echo },
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
				// unmarked. The acked deletes ride unconfirmedBlockIds — no
				// walk verified them.
				return rethrowClassified(outcome.error, {
					newBlockId: outcome.insertedId,
					remainingBlockIds: outcome.remainingBlockIds,
					unconfirmedBlockIds: outcome.deletedBlockIds,
				});
			case "sweep-walk-failed":
				// Every member delete acked but the verification walk itself
				// failed — the sweep is complete but unjudged, so this must
				// never surface as a raw transport error ("SiYuan unreachable")
				// while the whole write is applied. Rethrow inside the
				// finish-write wrapper with the partial state attached: the
				// acked set rides unconfirmedBlockIds (no walk verified it),
				// nothing remains pending, and the classifier renders
				// verificationFailed.
				return rethrowClassified(outcome.error, {
					newBlockId: outcome.insertedId,
					remainingBlockIds: [],
					unconfirmedBlockIds: outcome.deletedBlockIds,
				});
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
					anchor: echo,
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
			case "sweep-truncated": {
				// The deletes acked but the post-sweep walk hit the depth
				// bound: the swept judgment's absence facts are unconfirmed, so
				// the acked set cannot read as deleted — it rides
				// unconfirmedBlockIds from the sweep's own record (the members
				// the core acked, single-sourced). Applied-but-unverified —
				// never ok, never a rollback.
				return errorEnvelope(
					`replace applied but unverified: the replacement (block '${outcome.insertedId}') is in place and every member delete acked, but the verification walk hit the document's depth bound — whether the old section is fully gone could not be confirmed. Do NOT re-run; re-fetch the outline (kb_read) and check the acked ids (unconfirmedBlockIds) before any cleanup`,
					{
						kb: name,
						anchor: echo,
						newBlockId: outcome.insertedId,
						...partialApplyMarker(),
						unconfirmedBlockIds: outcome.deletedBlockIds,
					},
				);
			}
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
					anchor: echo,
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
