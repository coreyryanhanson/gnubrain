// The replace-section flow: resolve the heading target from the
// document-order walk → one verified sequence call (the primitives own
// the section enumeration, the fresh-content guard over its derived
// judged set, the insert-before-delete ordering, the batched delete leg,
// and the enumeration timing) → envelope wording. The verdict's `anchor`
// arms are the flow's only anchor source — no flow-side re-derivation to
// keep in step.
// A mid-sequence failure must cost visible duplication, never loss — that
// invariant lives with the sequence.

import { partitionByAbsence, walkBlockTree } from "siyuan-kernel-primitives";
import { replaceSectionVerified } from "siyuan-kernel-primitives/write";
import { errorEnvelope, unreachable, type Envelope } from "./envelope.js";
import { deletedBlocksTail, echoTail, orphanedRefs } from "./writeEcho.js";
import {
	batchedRefusalEnvelope,
	mutationFailure,
	rethrowClassified,
} from "./writeLadder.js";
import {
	headingInWalk,
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import {
	appendAnchorEcho,
	insertLandedRefusal,
	replaceSectionWalkTruncatedMessage,
} from "./writeVerdicts.js";
import {
	appliedButUnverifiedEnvelope,
	batchedNothingDeletedEnvelope,
	batchedSurvivorEnvelope,
	sameDocRepairFirstLead,
	UNCONFIRMED_SET_RECONCILE,
} from "./writeBatchedVerdicts.js";

/** Replace-section's recovery clause — a per-flow composite over the
 * shared batched-route doctrine (canonical home: writeBatchedVerdicts.ts,
 * the repair-first lead and the index-damage clause): the by-id cleanup
 * once the repair write has landed, and the one thing delete-section can
 * say only in the negative: never re-run replace-section — the
 * replacement is already in place, so a re-issue would insert a second
 * copy. Both survivor-shaped outcomes (`members-survived` and
 * `nothing-deleted`) carry it: `nothing-deleted` read as "nothing
 * happened, try again" would duplicate the section — the exact hazard
 * the negative clause exists to prevent. The sentences themselves are
 * the shared batched skeletons — the doctrine is per-flow, the skeleton
 * is not. */
const replaceRecoveryClause =
	sameDocRepairFirstLead +
	"delete the surviving old-section block(s) by id — never re-run replace-section: the replacement is already in place, so a re-issue would insert a second copy";

export async function runReplaceSectionMode(
	input: WriteFlowInput<"replace-section">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId;
	// Target resolution rides the document-order walk, never SQL. The
	// section enumeration and the anchor are the sequence's own
	// derivations from this same walk — the verdict's `anchor` arms are
	// the flow's only anchor source (no flow-side re-derivation to keep
	// in step).
	const tree = await walkBlockTree(kernel, doc.rootId);
	const resolved = headingInWalk(tree, doc, headingId);
	if ("status" in resolved) return resolved;
	// The fresh precondition is the primitive's, over the session lookup
	// (writeFresh.ts; the judged set derives from the enumeration walk
	// above — no second walk; see replaceSectionVerified's `baselineFor`).
	// An empty closure legitimately judges nothing — the sequence skips
	// the judgment there.
	const outcome = await replaceSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
		headingId,
		body: input.body,
		baselineFor: baselines.servedBaseline,
	});
	// Refused: the shared batched-route ladder (writeLadder.ts) renders
	// every pre-mutation arm — provably nothing applied (the plan runs
	// BEFORE the insert, so the fresh refusal keeps its "nothing landed"
	// meaning). This flow's residual facts the shared frame cannot know:
	// the foreign arm is unreachable from this flow (rootId and the walk
	// derive from the same doc.rootId) and the enumeration pair is
	// unreachable (headingInWalk already refused both over the same walk)
	// — the arms keep the sequence's contract self-contained, mapped not
	// assumed away. Pre-mutation refusals carry the target heading, never
	// an anchor: the refusal means re-derive from a fresh walk, and the
	// stale walk's placement is not evidence.
	if (outcome.kind === "refused") {
		return batchedRefusalEnvelope(outcome.refusal, input, doc, {
			headingId,
			truncatedMessage: replaceSectionWalkTruncatedMessage,
		});
	}
	// Unverified: a mutation ran or may have run and its outcome is
	// unknown, or it acked and its judgment is missing. The insert leg's
	// ladder arms render through the shared ladder (the old section is
	// untouched either way); the delete leg's raw-error arms rethrow
	// classified from inside the finish-write wrapper with the
	// replacement's partial state attached.
	if (outcome.kind === "unverified") {
		const unverified = outcome.outcome;
		if (unverified.stage === "insert") {
			return mutationFailure(unverified.failure, input, doc, { headingId });
		}
		const anchor = appendAnchorEcho(unverified.anchor);
		return finishWrite(name, { anchor }, async () =>
			rethrowClassified(unverified.failure.error, {
				newBlockId: unverified.insertedId,
				unconfirmedBlockIds: unverified.failure.judgedBlockIds,
			}),
		);
	}
	// Judged: everything here is post-mutation — the insert has landed, so
	// a drop anywhere in the delete leg or the echo must never read as
	// "unreachable" while the replacement may sit beside an unremoved old
	// section (finishWrite doc).
	// The verdict's anchor, rendered once for every post-mutation echo —
	// the insert was issued against it and the judged walk shows it.
	const verdict = outcome.verdict;
	const anchor = appendAnchorEcho(verdict.anchor);
	return finishWrite(name, { anchor }, async () => {
		switch (verdict.kind) {
			case "insert-unlanded": {
				// No echo tail here, unlike append's unlanded refusal: the
				// refusal wording already carries the evidence that matters —
				// the old section is untouched — and the extra walk + root
				// echo would spend two kernel calls on a failure path without
				// changing the guidance.
				const unlanded = insertLandedRefusal(verdict.verdict);
				return errorEnvelope(
					`verified-insert failed: ${unlanded} — the old section is untouched`,
					{ kb: name, anchor },
				);
			}
			case "replaced": {
				// invalidRefs: post-write echo over the section's closure —
				// what actually got orphaned, verified.
				const refs = await orphanedRefs(
					kernel,
					verdict.closure.map((b) => b.blockId),
				);
				// The echo tail reflects the tree AFTER the delete batch: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, verdict.postWalk, [
					verdict.insertedId,
				]);
				return {
					status: "ok",
					// The closure is what left the doc — the members the batch
					// deleted explicitly plus the descendants their cascade
					// removed. The receipt itemizes it (ids + walk content) —
					// the post-write visibility the pre-write grant dialog
					// does not carry.
					message: `replaced the section under heading '${verdict.headingContent}' in '${doc.title}' (KB ${name}) — delete set ${verdict.closure.length} block(s), ${refs.clause}`,
					kb: name,
					anchor,
					newBlockId: verdict.insertedId,
					invalidRefs: refs.invalidRefs,
					...deletedBlocksTail(
						sessionId,
						verdict.closure.map((b) => ({
							id: b.blockId,
							content: b.content,
						})),
					),
					...tail,
				};
			}
			case "delete-leg": {
				// The delete leg did not end in a clean replace. Keyed FIRST
				// on the replacement-survival reading — its wording keys on
				// walk completeness, not on the arm that carried the walk:
				// on a complete walk an absent replacement is data loss (the
				// cascade explanation is live even when the same arm also
				// reports survivors); on a truncated walk absence is
				// unconfirmed. Presence is sound on any walk, so survivors
				// never outrank the survival reading. The raw-error arms
				// ride the unverified phase above, so every arm here carries
				// its post-write walk.
				const leg = verdict.outcome;
				const tail = await echoTail(input, doc, leg.postWalk);
				if (verdict.replacementSurvival === "cascade-consumed") {
					// The reading fires only on a complete walk, so the issued
					// set's split is the certified arm: absentIds are what
					// the batch verifiably deleted, presentIds the survivors
					// — the receipt claims only what the walk certifies.
					const split = partitionByAbsence(verdict.memberIds, leg.postWalk);
					return errorEnvelope(
						`verified-replace failed: the new section block '${verdict.insertedId}' is absent from the post-delete walk — the delete batch's cascade consumed the replacement; do not retry`,
						{
							kb: name,
							anchor,
							newBlockId: verdict.insertedId,
							// Terminal cascade-consumed marker, spread
							// directly: judged and lost — never rethrown,
							// so no shared render frame sees it.
							appliedConsumed: true,
							deletedBlockIds: split.kind === "complete" ? split.absentIds : [],
							survivedIds: split.presentIds,
							...tail,
						},
					);
				}
				if (verdict.replacementSurvival === "unconfirmed") {
					return appliedButUnverifiedEnvelope({
						mode: "replace-section",
						observation: `the replacement block '${verdict.insertedId}' is absent from the post-delete walk`,
						question: "the replacement survived",
						reconcile: "check the attached outline and the replacement's block",
						kb: name,
						unconfirmedBlockIds: leg.judgedBlockIds,
						extra: { anchor, newBlockId: verdict.insertedId },
						tail,
					});
				}
				switch (leg.kind) {
					case "members-survived": {
						// Presence-derived complement of the survivors,
						// split by the shared primitives projection over
						// the ISSUED member set — the survivor sentence
						// instructs by-id deletes, and the judged set's
						// cascade-covered descendants would error "tree
						// not found" on the by-id route. The batch acks
						// nothing per member, so no partial-apply state
						// rides this arm (the batched doctrine: survivors
						// are acked-but-present ids, not a not-yet-applied
						// remainder).
						return batchedSurvivorEnvelope({
							mode: "replace-section",
							subject: "old-section block(s)",
							survivedIds: leg.survivedIds,
							splitSet: verdict.memberIds,
							walk: leg.postWalk,
							recovery: replaceRecoveryClause,
							kb: name,
							extra: { anchor, newBlockId: verdict.insertedId },
							tail,
						});
					}
					case "nothing-deleted": {
						// All-or-nothing arm — cause-free by design; the
						// composite doctrine prevents the "nothing
						// happened, try again" misread that would
						// duplicate the section. The outline tail IS the
						// walk evidence.
						return batchedNothingDeletedEnvelope({
							mode: "replace-section",
							observation: `the whole old section still present beside the replacement (block '${verdict.insertedId}')`,
							guard:
								"do NOT delete the old-section block(s) by id before a repair write",
							recovery: replaceRecoveryClause,
							walk: leg.postWalk,
							kb: name,
							extra: { anchor, newBlockId: verdict.insertedId },
							judgedBlockIds: leg.judgedBlockIds,
							tail,
						});
					}
					case "post-walk-truncated": {
						// The batch acked but the post-write walk hit the
						// depth bound: the judgment's absence facts are
						// unconfirmed — the batch acks nothing per
						// member, so "the batch acked; whether the old
						// section is fully gone is unconfirmed" replaces
						// the per-op route's "every delete acked".
						return appliedButUnverifiedEnvelope({
							mode: "replace-section",
							observation: "the delete batch acked",
							question: "the old section is fully gone",
							reconcile: UNCONFIRMED_SET_RECONCILE,
							kb: name,
							unconfirmedBlockIds: leg.judgedBlockIds,
							extra: { anchor, newBlockId: verdict.insertedId },
							tail,
						});
					}
				}
				return unreachable(leg, "unhandled delete-leg verdict");
			}
		}
		return unreachable(verdict, "unhandled replace-section verdict");
	});
}
