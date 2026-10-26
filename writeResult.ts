// Write-result machinery: finishWrite, the post-mutation verification
// contract (a network drop in the verification reads must read as
// unverified, never as unreachable). The rethrow policy lives on the
// finishWrite docstring below.

import { causeOf } from "siyuan-kernel-primitives";
import {
	errorEnvelope,
	takePartialApply,
	partialApplyMarker,
	PARTIAL_APPLY_GUIDANCE,
	PARTIAL_APPLY_STATUS,
	PARTIAL_APPLY_TAIL,
	type Envelope,
} from "./envelope.js";
import {
	postWriteAssemblyFailedMessage,
	verificationReadsFailedMessage,
} from "./writeVerdicts.js";

// ---------------------------------------------------------------------------
// Write-result contract — echoes + verification evidence
// ---------------------------------------------------------------------------

/** Post-mutation wrapper for the verification + echo reads every write
 * runs AFTER the kernel mutation has been issued. A failure there must
 * not surface as runKbCall's "SiYuan unreachable" or bare-error envelope:
 * the mutation may already be applied, and either message invites the
 * blind retry that would duplicate or re-apply the write. Network/timeout
 * and kernel-rejection errors become a distinct `verificationFailed`
 * error envelope; so does any non-kernel builder failure — the builder is
 * post-mutation by contract, so a spilled-outline fs failure or a flow
 * bug leaves the outcome just as unverified. Auth and rate-limit errors
 * rethrow so runKbCall keeps classifying them (breaker counting, 429
 * cooldown, the partial-apply state merged into the classified envelope
 * by withPartialState) — replace-section's post-insert delete-batch 429
 * rides exactly this rethrow. The classification itself lives down-repo
 * (`causeOf`); this site keeps only the rethrow policy. */
export async function finishWrite(
	kb: string,
	extra: Record<string, unknown>,
	build: () => Promise<Envelope>,
): Promise<Envelope> {
	try {
		return await build();
	} catch (err) {
		const cause = causeOf(err);
		if (
			cause !== undefined &&
			(cause.kind === "auth" || cause.kind === "rate-limit")
		) {
			throw err;
		}
		const partial = takePartialApply(err);
		const detail = err instanceof Error ? err.message : String(err);
		let message: string;
		if (partial !== undefined) {
			message =
				`the write is ${PARTIAL_APPLY_STATUS} — a mid-write step failed: ` +
				`${detail} — ${PARTIAL_APPLY_TAIL}; ${PARTIAL_APPLY_GUIDANCE}`;
		} else if (cause === undefined) {
			message = postWriteAssemblyFailedMessage(detail);
		} else {
			switch (cause.kind) {
				case "transport":
				case "kernel":
					// A kernel rejection mid-verification (unknown/locked id)
					// leaves the write's outcome unverified too — same envelope.
					// No breaker effect: breaker counting and 429 cooldown ride
					// the rethrown auth/rate-limit arm above; those causes never
					// reach here.
					message = verificationReadsFailedMessage(detail);
					break;
				default:
					cause satisfies never;
					message = postWriteAssemblyFailedMessage(detail);
			}
		}
		return errorEnvelope(message, {
			...extra,
			...partial,
			// The marker rides only a real partial state — an unmarked error
			// would read as a plain failure.
			...(partial !== undefined && partialApplyMarker),
			kb,
			verificationFailed: true,
		});
	}
}
