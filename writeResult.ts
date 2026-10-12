// Write-result machinery: finishWrite, the post-mutation verification
// contract (a network drop in the verification reads must read as
// unverified, never as unreachable). The rethrow policy lives on the
// finishWrite docstring below.

import { causeOf } from "siyuan-kb-primitives";
import {
	errorEnvelope,
	takePartialReplace,
	PARTIAL_APPLY_GUIDANCE,
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
 * by withPartialState) — the sweep's mid-sequence 429 rides exactly this
 * rethrow. The classification itself lives down-repo (`causeOf`); this
 * site keeps only the rethrow policy. */
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
		const partial = takePartialReplace(err);
		const detail = err instanceof Error ? err.message : String(err);
		let message: string;
		if (partial !== undefined) {
			message =
				`the write is partially applied — a mid-write step failed: ` +
				`${detail} — the earlier steps have landed; ${PARTIAL_APPLY_GUIDANCE}`;
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
		// A mid-sequence failure (replace-section's delete sweep) attaches
		// its partial-apply state to the error before it lands here — the
		// envelope must carry it, or the re-run-invites-duplication hazard
		// the sweep's own catch guards against re-enters one error class
		// over.
		return errorEnvelope(message, {
			...extra,
			...partial,
			kb,
			verificationFailed: true,
		});
	}
}
