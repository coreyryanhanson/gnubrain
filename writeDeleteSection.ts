// The delete-section flow: the document-order walk → one verified
// batched call (the primitive owns the enumeration, the fresh-content
// guard over the derived judged set, the batched route's op derivation,
// and the walk partition) → envelope wording. The batch is whole: a
// rollback or a silent no-op is judged from the single post-write walk —
// never rendered as a partial-apply receipt, because there is no
// mid-sequence state to render.

import {
	backlinkCheck,
	partitionByAbsence,
	walkBlockTree,
} from "siyuan-kb-primitives";
import { deleteSectionVerified } from "siyuan-kb-primitives/write";
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
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	blockInDocRefusalKind,
	deleteSectionWalkTruncatedMessage,
} from "./writeVerdicts.js";

/** Delete-section's own batched-route sentences — the survivor arm and
 * the all-or-nothing arm, worded per the batched-route recovery doctrine
 * (canonical statement: the primitives' `deleteSection.ts` union doc —
 * rollback index damage is invisible to every read the tool surface
 * issues and makes a by-id delete of a damaged id neither land nor
 * heal): the sweep sentence's by-id instruction (correct for
 * replace-section's per-op sweep — writeReplaceSection.ts) is forbidden
 * here; the sequencing is repair write first, then whatever the branch
 * prescribes. Both arms carry the repair-first guidance; persistent
 * survivors stop and report — a re-issue must not loop. The survivor arm
 * has one branch: when the heading is NOT among the survivors the
 * re-issue would refuse `heading-absent` (the members are orphaned —
 * their ownership moved to the preceding heading), so after the repair
 * write the survivors are an ordinary by-id cleanup. `truncated` is the
 * verification walk's depth bound: absence (survivor arm) or presence
 * (all-or-nothing arm) past the bound is unconfirmed, never claimed from
 * the walk alone (see unconfirmedBlockIds). */
const batchRecoveryClause =
	"recovery: make any committed write to this doc first (any other kb_write edit in it re-upserts the tree's index rows), then re-issue this whole-section delete ONCE; if block(s) still survive that re-issue, stop and report — do not loop";
const batchOrphanedRecoveryClause =
	"recovery: make any committed write to this doc first (any other kb_write edit in it re-upserts the tree's index rows), then delete the surviving block(s) by id — the heading is gone, so a whole-section re-issue would refuse heading-absent and the survivors are ordinary orphans";

function deleteSectionSurvivedMessage(
	survivedIds: string[],
	truncated: boolean,
	headingId: string,
): string {
	const recovery = survivedIds.includes(headingId)
		? batchRecoveryClause
		: batchOrphanedRecoveryClause;
	return (
		`delete-section failed: the delete batch acked but ${survivedIds.length} section block(s) are still present ('${survivedIds.join("', '")}') — a silent no-op behind HTTP success; do NOT delete the surviving block(s) by id before a repair write — index damage (e.g. the residue of an earlier rolled-back batch) makes by-id deletes silently no-op behind success; ${recovery}` +
		(truncated
			? "; the verification walk was depth-truncated, so absence past the bound is unconfirmed — see unconfirmedBlockIds and reconcile from the outline"
			: "")
	);
}

function deleteSectionNothingDeletedMessage(
	judgedBlockIds: string[],
	truncated: boolean,
): string {
	return (
		`delete-section did not apply: nothing was deleted — the post-write walk shows every section block still present (${judgedBlockIds.length} judged) — and the kernel reported no reason over HTTP (batch failures surface only on the editor websocket, which this response never carries); do NOT re-issue before a repair write and do NOT delete the section's block(s) by id — a rolled-back batch can leave index damage behind it that makes by-id deletes silently no-op; ${batchRecoveryClause}` +
		(truncated
			? "; the verification walk was depth-truncated, so deeper section blocks' presence is inferred from the batch's rollback, not seen in the walk — reconcile from the outline"
			: "")
	);
}

export async function runDeleteSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// The enumeration walk the whole sequence rides: the primitive derives
	// the judged set from it, judges the fresh precondition over it, and
	// refuses truncation, absent heading, and foreign provenance from it —
	// one path per refusal, read off the verdict (never a flow-side
	// re-derivation through `sectionOf`).
	const tree = await walkBlockTree(kernel, doc.rootId);
	// The fresh precondition is the primitive's, over the session lookup
	// (writeFresh.ts; see deleteSectionVerified's `baselineFor`). Guarded
	// like the block-delete path, deliberately: the agent's intent is the
	// section's content, and the members are enumerated by the walk,
	// never named by the agent. Baselines seed from heading rows only, so
	// a member refuses only within the SQL-index divergence window or
	// when the session explicitly holds a member baseline.
	const outcome = await deleteSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
		headingId,
		baselineFor: baselines.servedBaseline,
	});
	// The pre-mutation failure ladder. `drift` and `kernel-refused` mean
	// nothing IS KNOWN to have landed — with one batched-route residual:
	// the kernel can fail after the batch has committed (the post-commit
	// echo re-marshal), so `kernel-refused` here is refused-by-HTTP, not
	// proof of non-application; the echo tail the envelope attaches is the
	// verification. `transport-unverified` is the batch's post-issue pre-ack
	// throw: no ack means the commit-wait guarantee does not apply — the
	// batch may still be committing or already committed — so its frame
	// carries the WHOLE judged set as the unconfirmed payload, read off the
	// verdict (the whole set is what may be gone; the per-op sweep's
	// not-yet-attempted remainder has no analogue).
	if (outcome.kind === "drift") {
		return mutationFailure(outcome, input, doc, { headingId });
	}
	if (outcome.kind === "kernel-refused") {
		return mutationFailure(
			outcome,
			input,
			doc,
			{ headingId },
			{
				refusalNote:
					"on the batched route this refusal is not proof of non-application — the batch may have committed before the failure; the outline below is the current tree",
			},
		);
	}
	if (outcome.kind === "transport-unverified") {
		return mutationFailure(
			outcome,
			input,
			doc,
			{ headingId },
			{
				unconfirmedBlockIds: outcome.judgedBlockIds,
			},
		);
	}
	if (outcome.kind === "foreign") {
		// Pre-mutation scoping refusal — the shared wording home for the
		// membership class both delete flows refuse on (writeVerdicts doc).
		// The section flow's foreign arm comes from the walk-rootId check:
		// the enumeration walk's root is not the claimed doc. (`doc-id` is
		// unreachable here — sectionOf requires a heading row.)
		return refusedEnvelope(blockInDocRefusalKind(outcome, headingId, doc));
	}
	if (outcome.kind === "fresh-refused") {
		// The internal guard's refusal — nothing landed.
		return freshRefusalEnvelope(baselines, sessionId, name, outcome);
	}
	if (outcome.kind === "walk-truncated" || outcome.kind === "heading-absent") {
		// The enumeration's refusal pair — one path per refusal, read off
		// the verdict.
		return anchorRefusal(
			outcome.kind,
			doc,
			headingId,
			name,
			deleteSectionWalkTruncatedMessage,
		);
	}
	// Everything from here on is post-mutation — deletes may have landed,
	// so a drop anywhere must never read as "unreachable" or bare-error
	// while the section may be half-removed (finishWrite doc). The
	// walk-failed arm throws from in here with the unconfirmed state
	// attached, so the wrapper's classifier renders verificationFailed
	// over the merged state.
	return finishWrite(name, { headingId }, async () => {
		switch (outcome.kind) {
			case "judged": {
				// The verdict carries the judged set it certified — the receipt
				// itemizes the whole removal (the members the batch deletes
				// explicitly, the descendants their cascade takes, and the
				// heading itself) in the verdict's judged order, never a
				// re-derivation.
				const judgedIds = outcome.judgedBlocks.map((b) => b.blockId);
				const invalidRefs = await backlinkCheck(kernel, judgedIds);
				// The echo tail reflects the tree AFTER the deletes: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, outcome.postWalk);
				return {
					status: "ok",
					message: `deleted the section under heading '${outcome.heading.content}' in '${doc.title}' (KB ${name}) — delete set ${judgedIds.length} block(s), ${invalidRefs.count} doc(s) with orphaned refs`,
					kb: name,
					headingId,
					invalidRefs,
					...deletedBlocksTail(
						sessionId,
						outcome.judgedBlocks.map((b) => ({
							id: b.blockId,
							content: b.content,
						})),
					),
					...tail,
				};
			}
			case "members-survived": {
				const tail = await echoTail(input, doc, outcome.postWalk);
				// Presence is sound on any walk; absence only on a complete
				// one — the shared primitives projection, never re-encoded here.
				// The batch's recovery doctrine forbids the pending-set shape:
				// the survivors are acked-but-present ids, not a not-yet-applied
				// remainder, so no partialApply marker and no remainingBlockIds
				// ride this arm.
				const split = partitionByAbsence(
					outcome.judgedBlockIds,
					outcome.postWalk,
				);
				return errorEnvelope(
					deleteSectionSurvivedMessage(
						outcome.survivedIds,
						split.kind === "unconfirmed",
						headingId,
					),
					{
						kb: name,
						headingId,
						survivedIds: outcome.survivedIds,
						...(split.kind === "unconfirmed"
							? { unconfirmedBlockIds: split.unconfirmedAbsentIds }
							: { deletedBlockIds: split.absentIds }),
						...tail,
					},
				);
			}
			case "nothing-deleted": {
				// All-or-nothing arm — cause-free by design: the kernel reports
				// no batch failure reason over HTTP, and the walk cannot
				// distinguish a clean rollback from damaged-index residue, so
				// the wording leads with what the walk observed, never an
				// execution-path claim. The outline tail IS the walk evidence.
				const tail = await echoTail(input, doc, outcome.postWalk);
				return errorEnvelope(
					deleteSectionNothingDeletedMessage(
						outcome.judgedBlockIds,
						outcome.postWalk.incomplete,
					),
					{
						kb: name,
						headingId,
						judgedBlockIds: outcome.judgedBlockIds,
						...tail,
					},
				);
			}
			case "walk-failed":
				// The batch acked (committed or rolled back — the commit-wait
				// fact leaves no third state) but the post-write walk itself
				// failed — the judgment is missing while the whole section may
				// be gone, so it must never surface as a raw transport error.
				// The whole judged set rides unconfirmedBlockIds (under the
				// batch it is all of what may be gone); nothing remains pending;
				// the classifier renders verificationFailed.
				return rethrowClassified(outcome.error, {
					remainingBlockIds: [],
					unconfirmedBlockIds: outcome.judgedBlockIds,
				});
			case "post-walk-truncated":
				// The batch acked but the post-write walk hit the depth
				// bound: the judgment's absence facts are unconfirmed — and
				// survivors outrank truncation in the core, so no judged id is
				// visible either. The receipt carries the judged set (heading +
				// closure — the closure rides the cascade, so it is part of
				// what may be gone, not just the issued ids).
				// Applied-but-unverified — never ok, never a rollback.
				return errorEnvelope(
					`delete-section applied but unverified: every section delete acked, but the verification walk hit the document's depth bound — whether the section is fully gone could not be confirmed. Do NOT re-run; re-fetch the outline (kb_read) and check the delete set (unconfirmedBlockIds) before any cleanup`,
					{
						kb: name,
						headingId,
						...partialApplyMarker(),
						unconfirmedBlockIds: outcome.judgedBlockIds,
					},
				);
		}
		outcome satisfies never;
		return errorEnvelope("internal: unhandled delete-section verdict");
	});
}
