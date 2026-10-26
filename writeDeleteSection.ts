// The delete-section flow: the document-order walk → one verified
// batched call (the primitive owns the enumeration, the fresh-content
// guard over the derived judged set, the batched route's op derivation,
// and the walk partition) → envelope wording. The batch is whole: a
// rollback or a silent no-op is judged from the single post-write walk —
// never rendered as a partial-apply receipt, because there is no
// mid-sequence state to render.

import { walkBlockTree } from "siyuan-kernel-primitives";
import { deleteSectionVerified } from "siyuan-kernel-primitives/write";
import { unreachable, type Envelope } from "./envelope.js";
import { deletedBlocksTail, echoTail, orphanedRefs } from "./writeEcho.js";
import {
	batchedRefusalEnvelope,
	batchedUnverifiedEnvelope,
} from "./writeLadder.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import { deleteSectionWalkTruncatedMessage } from "./writeVerdicts.js";
import {
	appliedButUnverifiedEnvelope,
	batchedNothingDeletedEnvelope,
	batchedSurvivorEnvelope,
	sameDocRepairFirstLead,
	UNCONFIRMED_SET_RECONCILE,
} from "./writeBatchedVerdicts.js";

/** Delete-section's own recovery clauses — per-flow composites over the
 * shared batched-route doctrine (canonical home: writeBatchedVerdicts.ts,
 * the repair-first lead and the index-damage clause; replace-section's
 * recovery adds the never-re-run clause its sequence demands): the
 * sequencing is repair write first, then the recovery branch's
 * prescription. Both arms carry the repair-first guidance;
 * persistent survivors stop and report — a re-issue must not loop. The
 * survivor arm has one branch: when the heading is NOT among the
 * survivors the re-issue would refuse `heading-absent` (the members are
 * orphaned — their ownership moved to the preceding heading), so after
 * the repair write the survivors are an ordinary by-id cleanup. The
 * sentences themselves are the shared batched skeletons — the doctrine
 * is per-flow, the skeleton is not. */
const batchRecoveryClause =
	sameDocRepairFirstLead +
	"re-issue this whole-section delete ONCE; if block(s) still survive that re-issue, stop and report — do not loop";
const batchOrphanedRecoveryClause =
	sameDocRepairFirstLead +
	"delete the surviving block(s) by id — the heading is gone, so a whole-section re-issue would refuse heading-absent and the survivors are ordinary orphans";

export async function runDeleteSectionMode(
	input: WriteFlowInput<"delete-section">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId;
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
	// Refused and unverified: the shared batched-route ladders
	// (writeLadder.ts) render every pre-mutation arm — refused (provably
	// nothing applied) and the outcome-unknown arms alike. This flow's
	// residual facts the shared frame cannot know: the foreign arm comes
	// from the walk-rootId check (the enumeration walk's root is not the
	// claimed doc; `doc-id` is unreachable — sectionOf requires a heading
	// row), and the acked-walk-drop arm rides the whole-judged-set payload.
	if (outcome.kind === "refused") {
		return batchedRefusalEnvelope(outcome.refusal, input, doc, {
			headingId,
			truncatedMessage: deleteSectionWalkTruncatedMessage,
		});
	}
	if (outcome.kind === "unverified") {
		return batchedUnverifiedEnvelope(outcome.outcome, input, doc, {
			headingId,
		});
	}
	// Judged: everything here is post-mutation — deletes may have landed,
	// so a drop anywhere must never read as "unreachable" or bare-error
	// while the section may be half-removed (finishWrite doc).
	const verdict = outcome.verdict;
	return finishWrite(name, { headingId }, async () => {
		switch (verdict.kind) {
			case "judged": {
				// The verdict carries the judged set it certified — the receipt
				// itemizes the whole removal (the members the batch deletes
				// explicitly, the descendants their cascade takes, and the
				// heading itself) in the verdict's judged order, never a
				// re-derivation.
				const judgedIds = verdict.judgedBlocks.map((b) => b.blockId);
				const refs = await orphanedRefs(kernel, judgedIds);
				// The echo tail reflects the tree AFTER the deletes: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, verdict.postWalk);
				return {
					status: "ok",
					message: `deleted the section under heading '${verdict.heading.content}' in '${doc.title}' (KB ${name}) — delete set ${judgedIds.length} block(s), ${refs.clause}`,
					kb: name,
					headingId,
					invalidRefs: refs.invalidRefs,
					...deletedBlocksTail(
						sessionId,
						verdict.judgedBlocks.map((b) => ({
							id: b.blockId,
							content: b.content,
						})),
					),
					...tail,
				};
			}
			case "members-survived": {
				const tail = await echoTail(input, doc, verdict.postWalk);
				// Presence is sound on any walk; absence only on a complete
				// one — the shared primitives projection, never re-encoded here.
				// The batch's recovery doctrine: the survivors are
				// acked-but-present ids, not a not-yet-applied remainder, so
				// no partial-apply state rides this arm.
				return batchedSurvivorEnvelope({
					mode: "delete-section",
					subject: "section block(s)",
					survivedIds: verdict.survivedIds,
					splitSet: verdict.judgedBlockIds,
					walk: verdict.postWalk,
					recovery: verdict.survivedIds.includes(headingId)
						? batchRecoveryClause
						: batchOrphanedRecoveryClause,
					kb: name,
					extra: { headingId },
					tail,
				});
			}
			case "nothing-deleted": {
				// All-or-nothing arm — cause-free by design: the kernel reports
				// no batch failure reason over HTTP, and the walk cannot
				// distinguish a clean rollback from damaged-index residue, so
				// the wording leads with what the walk observed, never an
				// execution-path claim. The outline tail IS the walk evidence.
				const tail = await echoTail(input, doc, verdict.postWalk);
				return batchedNothingDeletedEnvelope({
					mode: "delete-section",
					observation: "every section block still present",
					guard:
						"do NOT re-issue before a repair write and do NOT delete the section's block(s) by id",
					recovery: batchRecoveryClause,
					walk: verdict.postWalk,
					kb: name,
					extra: { headingId },
					judgedBlockIds: verdict.judgedBlockIds,
					tail,
				});
			}
			case "post-walk-truncated": {
				// The batch acked but the post-write walk hit the depth
				// bound: the judgment's absence facts are unconfirmed — and
				// survivors outrank truncation in the core, so no judged id is
				// visible either. The receipt carries the judged set (heading +
				// closure — the closure rides the cascade, so it is part of
				// what may be gone, not just the issued ids) and the outline
				// tail served from the verdict's own walk — the evidence it
				// certifies (the seen prefix only), never a re-fetch.
				const tail = await echoTail(input, doc, verdict.postWalk);
				return appliedButUnverifiedEnvelope({
					mode: "delete-section",
					observation: "every section delete acked",
					question: "the section is fully gone",
					reconcile: UNCONFIRMED_SET_RECONCILE,
					kb: name,
					unconfirmedBlockIds: verdict.judgedBlockIds,
					extra: { headingId },
					tail,
				});
			}
		}
		return unreachable(verdict, "unhandled delete-section verdict");
	});
}
