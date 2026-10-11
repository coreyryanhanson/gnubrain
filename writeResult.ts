// Write-result machinery: finishWrite, the post-mutation verification
// contract (a network drop in the verification reads must read as
// unverified, never as unreachable). The success-path echo tail lives in
// writeEcho.ts beside the errorTail/echoTail family; the pre-mutation
// fresh-content precondition lives in writeTarget.ts beside the other
// pre-mutation judgments.

import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kb-primitives";
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
 * rethrow. */
export async function finishWrite(
	kb: string,
	extra: Record<string, unknown>,
	build: () => Promise<Envelope>,
): Promise<Envelope> {
	try {
		return await build();
	} catch (err) {
		// Siblings of SiYuanApiError, never subclasses — the same class list
		// contract the primitives' classifiers pin.
		if (err instanceof SiYuanAuthError || err instanceof SiYuanRateLimitError) {
			throw err;
		}
		const partial = takePartialReplace(err);
		const detail = err instanceof Error ? err.message : String(err);
		// A kernel rejection mid-verification (unknown/locked id) leaves the
		// write's outcome unverified too — same envelope. No breaker effect:
		// breaker counting and 429 cooldown ride the rethrown auth/rate-limit
		// arm above; these three classes never classified there anyway.
		const kernelClass =
			err instanceof SiYuanNetworkError ||
			err instanceof SiYuanTimeoutError ||
			err instanceof SiYuanApiError;
		let message: string;
		if (partial !== undefined) {
			message =
				`the write is partially applied — a mid-write step failed: ` +
				`${detail} — the earlier steps have landed; ${PARTIAL_APPLY_GUIDANCE}`;
		} else if (kernelClass) {
			message = verificationReadsFailedMessage(detail);
		} else {
			message = postWriteAssemblyFailedMessage(detail);
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
