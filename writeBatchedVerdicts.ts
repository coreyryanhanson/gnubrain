// The batched route's shared verdict doctrine — the wording fragments
// every flow riding the batched kernel route (delete-section,
// replace-section's delete leg, the section move) composes from: the
// refusal note, the repair-first recovery lead, the index-damage and
// cause-free clauses, the two shared truncation tails, the survivor /
// nothing-deleted skeletons (message + envelope: the envelope owns the
// absence split, the payload key it selects, and the payload shape), and
// the post-walk-truncated receipt. Keyed on the route, not on a verdict
// union — writeVerdicts is the per-verdict-arm sentence layer. Purely
// synchronous, like writeVerdicts; the async failure ladder and its
// flow-side bindings stay in writeLadder.

import { partitionByAbsence, type WalkedTree } from "siyuan-kernel-primitives";
import {
	errorEnvelope,
	partialApplyMarker,
	type Envelope,
} from "./envelope.js";
import type { VerdictKey } from "./writeVerdicts.js";

/** The batched route's shared refusal note — the kernel-refused residual
 * both batched flows (delete-section, the section move) append: the kernel
 * can fail after the batch has committed (the post-commit echo re-marshal),
 * so on the batched route this refusal is refused-by-HTTP, not proof of
 * non-application. */
export const BATCHED_ROUTE_REFUSAL_NOTE =
	"on the batched route this refusal is not proof of non-application — the batch may have committed before the failure; the outline below is the current tree";

/** The batched route's repair-first recovery lead — the invariant every
 * recovery clause stands on: a committed write to the doc re-upserts the
 * tree's index rows, so repair before re-issue. Each site appends its
 * own instruction — the doctrine is shared, the sentence is not. */
export function repairFirstLead(docRef: string, reason: string): string {
	return `recovery: make any committed write to ${docRef} first (${reason}), then `;
}

/** The same-doc lead the same-doc recovery clauses share verbatim
 * (delete-section's two, replace-section's one); the cross-doc move
 * builds its own through repairFirstLead. */
export const sameDocRepairFirstLead = repairFirstLead(
	"this doc",
	"any other kb_write edit in it re-upserts the tree's index rows",
);

/** The batched route's by-id-delete warning — the clause every post-batch
 * recovery sentence stands on: a rolled-back batch can leave index damage
 * behind it, and a by-id delete against a damaged id silently no-ops
 * behind HTTP success. Composed into the survivor and nothing-deleted
 * sentences of both batched delete flows.
 */
const INDEX_DAMAGE_CLAUSE =
	"index damage (e.g. the residue of an earlier rolled-back batch) makes by-id deletes silently no-op behind success";

/** The batched route's cause-free lead — the parenthetical every
 * nothing-applied batch sentence shares: the kernel reports batch
 * failures only on the editor websocket, so the HTTP response carries no
 * failure reason. */
export const SILENT_BATCH_CAUSE_CLAUSE =
	"batch failures surface only on the editor websocket, which this response never carries";

/** The batched-delete flows' shared truncation tails — the two depth-bound
 * readings, kept as distinct fragments because they are distinct kernel
 * facts: on the survivor arm the walk's ABSENCE facts are unconfirmed
 * (survivors outrank truncation in the core, so a judged id is never
 * visible there); on the nothing-deleted arm the walk's PRESENCE facts
 * past the bound are inferred from the batch's rollback, not seen. Both
 * end with the reconcile-from-the-outline instruction — the outline tail
 * is the walk evidence. */
const ABSENCE_UNCONFIRMED_TAIL =
	"; the verification walk was depth-truncated, so absence past the bound is unconfirmed — see unconfirmedBlockIds and reconcile from the outline";
const PRESENCE_UNCONFIRMED_TAIL =
	"; the verification walk was depth-truncated, so deeper blocks' presence is inferred from the batch's rollback, not seen in the walk — reconcile from the outline";

/** The batched-delete flows' shared survivor sentence — one skeleton for
 * delete-section's and replace-section's `members-survived` arm: the
 * batch acked but issued members are still present (the sub-cliff silent
 * no-op behind HTTP success). Cause-free by design: the kernel reports no
 * batch failure reason over HTTP, so the sentence leads with what the
 * walk shows, never an execution-path claim. The mode name, the walked
 * subject, the flow's recovery clause, and the truncation tail are the
 * only per-flow parts; the by-id-delete guard and the index-damage cause
 * are shared verbatim between the flows. Rendered only
 * through `batchedSurvivorEnvelope`. */
function batchedSurvivorMessage(params: {
	mode: string;
	subject: string;
	survivedIds: string[];
	recovery: string;
	truncated: boolean;
}): string {
	return (
		`${params.mode} failed: the delete batch acked but ${params.survivedIds.length} ${params.subject} are still present ('${params.survivedIds.join("', '")}') — a silent no-op behind HTTP success; do NOT delete the surviving block(s) by id before a repair write — ${INDEX_DAMAGE_CLAUSE}; ${params.recovery}` +
		(params.truncated ? ABSENCE_UNCONFIRMED_TAIL : "")
	);
}

/** The batched-delete flows' shared nothing-deleted sentence — one
 * skeleton for delete-section's and replace-section's all-or-nothing arm:
 * the whole delete set is still present and the kernel reported no reason
 * (the ≥32 bulk path can silently void the whole batch behind an HTTP
 * success ack). The safest possible failure state, and the easiest to
 * misread as "nothing happened, try again" — the flow's guard and
 * recovery clauses carry the re-issue hazard (replace-section's negative
 * clause exists to prevent a duplicate section). The observation (what
 * the walk shows), the guard (what not to do), and the recovery clause
 * are the per-flow parts; the cause-free lead, the index-damage cause,
 * and the truncation tail are shared verbatim. Rendered only through
 * `batchedNothingDeletedEnvelope`. */
function batchedNothingDeletedMessage(params: {
	mode: string;
	observation: string;
	judgedCount: number;
	guard: string;
	recovery: string;
	truncated: boolean;
}): string {
	return (
		`${params.mode} did not apply: nothing was deleted — the post-write walk shows ${params.observation} (${params.judgedCount} judged) — and the kernel reported no reason over HTTP (${SILENT_BATCH_CAUSE_CLAUSE}); ${params.guard} — ${INDEX_DAMAGE_CLAUSE}; ${params.recovery}` +
		(params.truncated ? PRESENCE_UNCONFIRMED_TAIL : "")
	);
}

/** The batched-delete flows' shared survivor envelope — the envelope half
 * of the `members-survived` arm, composed around the shared sentence:
 * the absence split over the post-write walk (the shared primitives
 * projection), the payload key it selects
 * (`deletedBlockIds` on a complete walk — what the batch verifiably
 * deleted; `unconfirmedBlockIds` on a truncated one — absence is never
 * claimed past the bound), and the payload shape. The split rides the
 * caller's issued set, not the survivor list, and the two flows' sets
 * differ by verdict shape: delete-section splits its whole judged set,
 * while replace-section's leg splits the issued member set (its judged
 * set also counts cascade-covered descendants, which would error "tree
 * not found" on the by-id route the payload's ids address). No
 * partial-apply state rides this arm — survivors are acked-but-present
 * ids, not a not-yet-applied remainder. */
export function batchedSurvivorEnvelope(params: {
	mode: string;
	subject: string;
	survivedIds: string[];
	/** The id set the absence split runs over — the set the batch was
	 * issued against (delete-section: the whole judged closure including
	 * the heading; replace-section's leg: the members only). */
	splitSet: string[];
	/** The verdict's own post-write walk — the evidence the split and the
	 * truncation reading certify, never a re-fetch. */
	walk: WalkedTree;
	recovery: string;
	kb: string;
	/** The flow's own verdict key(s), spread verbatim. */
	extra: VerdictKey;
	/** The echo tail served from the verdict's own walk. */
	tail: Record<string, unknown>;
}): Envelope {
	const split = partitionByAbsence(params.splitSet, params.walk);
	return errorEnvelope(
		batchedSurvivorMessage({
			mode: params.mode,
			subject: params.subject,
			survivedIds: params.survivedIds,
			recovery: params.recovery,
			truncated: split.kind === "unconfirmed",
		}),
		{
			kb: params.kb,
			...params.extra,
			survivedIds: params.survivedIds,
			...(split.kind === "unconfirmed"
				? { unconfirmedBlockIds: split.unconfirmedAbsentIds }
				: { deletedBlockIds: split.absentIds }),
			...params.tail,
		},
	);
}

/** The batched-delete flows' shared nothing-deleted envelope — the
 * envelope half of the all-or-nothing arm: the sentence (whose judged
 * count is derived here from the judged set it also carries) and the
 * payload shape. The outline tail is the walk evidence. */
export function batchedNothingDeletedEnvelope(params: {
	mode: string;
	observation: string;
	guard: string;
	recovery: string;
	/** The post-write walk — its completeness is the truncation reading.
	 * Presence past a depth bound is inferred from the batch's rollback,
	 * not seen. */
	walk: WalkedTree;
	kb: string;
	/** The flow's own verdict key(s), spread verbatim. */
	extra: VerdictKey;
	/** The judged set the walk showed still present. */
	judgedBlockIds: string[];
	/** The echo tail served from the verdict's own walk. */
	tail: Record<string, unknown>;
}): Envelope {
	return errorEnvelope(
		batchedNothingDeletedMessage({
			mode: params.mode,
			observation: params.observation,
			judgedCount: params.judgedBlockIds.length,
			guard: params.guard,
			recovery: params.recovery,
			truncated: params.walk.incomplete,
		}),
		{
			kb: params.kb,
			...params.extra,
			judgedBlockIds: params.judgedBlockIds,
			...params.tail,
		},
	);
}

/** The reconcile instruction the post-walk-truncated batch receipts
 * share verbatim — the agent checks the envelope's unconfirmedBlockIds
 * set against the attached outline(s). */
export const UNCONFIRMED_SET_RECONCILE =
	"check the delete set (unconfirmedBlockIds) against the attached outline";

/** The batched route's post-walk-truncated receipt — the mutation acked,
 * but the verification walk hit the document's depth bound, so the
 * judged set's absence facts are unconfirmed. The sentence that stops an
 * agent re-running a possibly-applied batch: the
 * status phrase, the depth-bound clause, the do-not-re-run clause and
 * the payload shape are fixed here; each site supplies its own
 * observation, question and reconcile instruction. Never ok, never a
 * rollback — the same "may be applied, judgment missing" posture the
 * walk-failed arm renders through finishWrite. The single-op delete's
 * own arm words separately in writeDelete (a per-route recovery
 * doctrine, not this frame). */
export function appliedButUnverifiedEnvelope(input: {
	mode: string;
	/** What the flow observed before the walk truncated — the ack posture
	 * or the landed fact the walk could not see through. */
	observation: string;
	/** The question the truncated walk could not answer. */
	question: string;
	/** The reconcile instruction — names the unconfirmedBlockIds payload
	 * where the agent checks the set against the attached outline(s). */
	reconcile: string;
	kb: string;
	/** The judged set whose absence no complete walk verified — the
	 * receipt's whole unconfirmed half. */
	unconfirmedBlockIds: string[];
	/** The flow's own verdict key(s), spread verbatim. */
	extra: VerdictKey;
	/** The echo tail served from the verdict's own walk(s) — the evidence
	 * it certifies, never a re-fetch. */
	tail: Record<string, unknown>;
}): Envelope {
	return errorEnvelope(
		`${input.mode} applied but unverified: ${input.observation}, but the verification walk hit the document's depth bound — whether ${input.question} could not be confirmed. Do NOT re-run; ${input.reconcile} before any cleanup`,
		{
			kb: input.kb,
			...input.extra,
			...partialApplyMarker,
			verificationFailed: true,
			unconfirmedBlockIds: input.unconfirmedBlockIds,
			...input.tail,
		},
	);
}
