// The shared failure ladder — the frame and the flow-side bindings,
// including the batched routes' shared refusal and unverified ladders.
// The one async piece: the tail thunk is awaited inside; the echo reads
// behind those tails live in writeEcho. writeVerdicts stays the pure
// synchronous sentence factories both consume.

import {
	errorEnvelope,
	markPartialApply,
	refusedEnvelope,
	unreachable,
	type Envelope,
	type PartialApplyState,
} from "./envelope.js";
import { causeOf } from "siyuan-kernel-primitives";
import type {
	BatchedRefusal,
	BatchedUnverified,
	JudgedTransportFailure,
	MutationFailure,
} from "siyuan-kernel-primitives/write";
import {
	blockInDocRefusalKind,
	driftRefusal,
	transportUnverifiedMessage,
	verificationFailedEnvelope,
	type VerdictKey,
} from "./writeVerdicts.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import {
	anchorRefusal,
	type DocTarget,
	type WriteFlowBase,
} from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import { BATCHED_ROUTE_REFUSAL_NOTE } from "./writeBatchedVerdicts.js";
import { errorTail } from "./writeEcho.js";

/** The shared failure ladder for the verified mutation flows — the four
 * pre-judgment arms every mutation outcome union carries, worded once so
 * a new arm in a primitives release fails typecheck here instead of
 * diverging across every flow. The arms' kernel semantics — what each
 * kind asserts about the mutation's state — live on the primitives'
 * `failure.ts` union doc; this frame owns only the tool-side rendering
 * policy:
 * - drift: the gate refuses first; this is defense-in-depth. Zero kernel
 *   calls — the tail thunk is never awaited on this arm.
 * - transport-unverified / verification-failed: the never-retry-blindly
 *   contract — the write may already be applied, so neither arm may read
 *   as "unreachable" or invite a blind re-issue. The transport arm runs
 *   the error-path echo reads best-effort (tail); the verification arm
 *   takes no garnish tail — the echo reads just failed, so the message
 *   stands alone.
 * - kernel-refused: the rejection surfaces verbatim with the fresh
 *   outline attached (tail); the arms are never hand-built here.
 * Delete-section and the section move render their shared arms through
 * the batched binding (`batchedMutationFailure` below) — same ladder,
 * plus the route's refusal note and the whole-judged-set unconfirmed
 * payload; each flow's post-mutation arms stay flow-side.
 * The tail is a thunk, not a value: errorTail performs kernel reads and
 * must stay off the arms that refuse without them. */
export async function mutationFailureEnvelope(
	outcome: MutationFailure,
	opts: {
		kb: string;
		/** The flow's own verdict key — spread verbatim, never re-worded
		 * here. */
		extra?: VerdictKey;
		/** The unconfirmed-block payload for the transport-unverified arm —
		 * the set that may be gone when the mutation's outcome is unknown.
		 * The batched flows (delete-section, the section move) supply their
		 * whole judged set (the batch's post-issue pre-ack throw leaves the
		 * entire set unjudged); the other flows leave it unset. */
		unconfirmedBlockIds?: string[];
		/** A flow-supplied clause appended to the kernel's verbatim
		 * rejection on the kernel-refused arm — the route residual the
		 * shared frame cannot know. The batched flows share one note
		 * (BATCHED_ROUTE_REFUSAL_NOTE), rendered through
		 * `batchedMutationFailure`. */
		refusalNote?: string;
		tail: () => Promise<Record<string, unknown>>;
	},
): Promise<Envelope> {
	switch (outcome.kind) {
		case "drift":
			return driftRefusal(outcome.observed);
		case "transport-unverified":
			return errorEnvelope(transportUnverifiedMessage(outcome.detail), {
				kb: opts.kb,
				verificationFailed: true,
				...opts.extra,
				...(opts.unconfirmedBlockIds !== undefined && {
					unconfirmedBlockIds: opts.unconfirmedBlockIds,
				}),
				...(await opts.tail()),
			});
		case "kernel-refused":
			return errorEnvelope(
				opts.refusalNote
					? `${outcome.message} — ${opts.refusalNote}`
					: outcome.message,
				{
					kb: opts.kb,
					...opts.extra,
					...(await opts.tail()),
				},
			);
		case "verification-failed":
			return verificationFailedEnvelope(outcome.cause, outcome.detail, {
				kb: opts.kb,
				...opts.extra,
			});
	}
	return unreachable(outcome, "unhandled mutation failure");
}

/** The shared failure ladder's flow-side binding — every mode's
 * non-judged arms differ only in the verdict key (extra); the kb name and
 * the error-path echo tail are the same at every site. The exceptions
 * bind the envelope directly with an empty tail: the doc move's failure
 * legs (the pinned no-doc-target shape) and the create mint's shared
 * arms (no doc target exists to echo). The batched route has its own
 * binding below (`batchedMutationFailure`), which renders through the
 * envelope directly. */
export function mutationFailure(
	outcome: MutationFailure,
	input: WriteFlowBase,
	doc: DocTarget,
	extra: VerdictKey,
): Promise<Envelope> {
	return mutationFailureEnvelope(outcome, {
		kb: input.name,
		extra,
		tail: () => errorTail(input, doc),
	});
}

/** The batched route's pre-mutation ladder — the one binding both batched
 * flows (delete-section, the section move) render their shared arms
 * through, so the route's residual wording lives exactly once: `drift`
 * rides bare (nothing is known to have landed); `kernel-refused` carries
 * BATCHED_ROUTE_REFUSAL_NOTE — on the batched route a refused-by-HTTP is
 * not proof of non-application, because the kernel can fail after the
 * batch has committed (the post-commit echo re-marshal);
 * `transport-unverified` carries the WHOLE judged set — no ack means the
 * commit-wait guarantee does not apply, and the whole set is what may be
 * gone. The flows' post-mutation arms are their own and stay flow-side. */
function batchedMutationFailure(
	outcome:
		| Extract<MutationFailure, { kind: "drift" | "kernel-refused" }>
		| JudgedTransportFailure,
	input: WriteFlowBase,
	doc: DocTarget,
	extra: VerdictKey,
): Promise<Envelope> {
	if (outcome.kind === "kernel-refused") {
		return mutationFailureEnvelope(outcome, {
			kb: input.name,
			extra,
			refusalNote: BATCHED_ROUTE_REFUSAL_NOTE,
			tail: () => errorTail(input, doc),
		});
	}
	if (outcome.kind === "transport-unverified") {
		return mutationFailureEnvelope(outcome, {
			kb: input.name,
			extra,
			unconfirmedBlockIds: outcome.judgedBlockIds,
			tail: () => errorTail(input, doc),
		});
	}
	return mutationFailure(outcome, input, doc, extra);
}

/** The batched routes' shared unverified ladder — delete-section and the
 * section move render their pre-judgment arms through this one binding:
 * on each arm nothing IS KNOWN to have landed, and the unconfirmed payload
 * rides the WHOLE judged set (the batched route renders no per-op
 * remainder to name). The refused-by-HTTP / transport arms render through
 * `batchedMutationFailure` (the route's refusal note and whole-set payload
 * live there); the acked-walk-drop arm rethrows classified from inside the
 * finish-write wrapper — the classifier renders verificationFailed over
 * the merged state, and the error stays raw (unknown in, unknown out).
 * replace-section keeps its own ladder: its delete leg carries the
 * replacement's identity beside the judged set. */
export function batchedUnverifiedEnvelope(
	failure: BatchedUnverified,
	input: WriteFlowBase,
	doc: DocTarget,
	extra: VerdictKey,
): Promise<Envelope> {
	if (
		failure.kind === "kernel-refused" ||
		failure.kind === "transport-unverified"
	) {
		return batchedMutationFailure(failure, input, doc, extra);
	}
	return finishWrite(input.name, extra, async () =>
		rethrowClassified(failure.error, {
			unconfirmedBlockIds: failure.judgedBlockIds,
		}),
	);
}

/** The batched routes' shared refusal ladder — the four pre-mutation arms
 * delete-section and replace-section render identically apart from the
 * truncation sentence (each flow's own, via `truncatedMessage`):
 * `drift` rides the shared MutationFailure ladder bare — both flows'
 * bindings delegate the drift arm there, and nothing is known to have
 * landed; `foreign` words through the shared membership wording
 * (`blockInDocRefusalKind`); `fresh-refused` renders through the
 * session's fresh envelope; the enumeration pair (`walk-truncated` /
 * `heading-absent`) rides `anchorRefusal`. The section move's refusal
 * family is a different union and stays flow-side. A new arm in a
 * primitives release fails typecheck here instead of diverging across
 * the two flows. */
export async function batchedRefusalEnvelope(
	refusal: BatchedRefusal,
	input: WriteFlowBase,
	doc: DocTarget,
	opts: { headingId: string; truncatedMessage: string },
): Promise<Envelope> {
	const { headingId } = opts;
	if (refusal.kind === "drift") {
		return mutationFailure(refusal, input, doc, { headingId });
	}
	if (refusal.kind === "foreign") {
		return refusedEnvelope(blockInDocRefusalKind(refusal, headingId, doc));
	}
	if (refusal.kind === "fresh-refused") {
		return freshRefusalEnvelope(
			input.baselines,
			input.sessionId,
			input.name,
			refusal,
		);
	}
	if (refusal.kind === "walk-truncated" || refusal.kind === "heading-absent") {
		return anchorRefusal(refusal, doc, input.name, opts.truncatedMessage);
	}
	return unreachable(refusal, "unhandled batched-route refusal");
}

/** Rethrow a post-mutation failure inside the finish-write wrapper with
 * the partial-apply state attached when the error is kernel-classified —
 * the catch sites merge it into whatever envelope the classifier
 * produces. Non-kernel error classes rethrow unmarked: the state would
 * claim mutation evidence an unclassified error cannot vouch for. One
 * home for the guarded pair so the next write mode inherits the guard
 * instead of copying it. */
export function rethrowClassified(
	error: unknown,
	state: PartialApplyState,
): never {
	if (causeOf(error) !== undefined) markPartialApply(error, state);
	throw error;
}
