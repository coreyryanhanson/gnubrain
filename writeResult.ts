// Shared write-result machinery: the fresh-content refusal wrapper and
// finishWrite, the post-mutation verification contract (a network drop in
// the verification reads must read as unverified, never as unreachable).
// The freshness judgment itself — both reads and the comparison — lives in
// the primitives' read barrel (checkFreshContent); only the session
// doctrine and the refusal wording stay here. The success-path echo tail
// lives in writeFlow.ts beside the errorTail/echoTail family.

import { type ContentBaselines } from "./baselines.js";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
	checkFreshContent,
	type FreshArm,
} from "siyuan-kb-primitives";
import {
	errorEnvelope,
	refusedEnvelope,
	takePartialReplace,
	type Envelope,
} from "./envelope.js";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import { serveOutlineFromWalk } from "./outline.js";
import { verificationReadsFailedMessage } from "./writeVerdicts.js";

/**
 * Fresh-content precondition, checked right before the kernel write: the
 * current content must still hash to the baseline the session last served.
 * One wrapper over the primitives' checkFreshContent judgment (both reads
 * and the comparison live down-repo; the walk ≡ SQL equivalence the pair
 * depends on is falsified there), applying the session doctrine over ALL
 * arms — there is no early stop, so a multi-stale refusal names every
 * stale target and the agent decides once:
 * - `fresh` → remember (a no-op: the hash already matches; preserves the
 *   seed side effect for the residual paths)
 * - `unseen` → adopt the live form (the no-baseline fallback, visible:
 *   nothing stored existed to launder)
 * - `stale` → re-baseline from the judged content AND name the target —
 *   the anti-laundering invariant: no stored baseline moves without its
 *   content being visible in the same envelope, so the retry proceeds
 *   against informed consent instead of refuse-looping
 * - `vanished` → skip (delete no-op class; the baseline is retained, so a
 *   return via undo re-judges as `fresh` if unchanged, `stale` if not)
 * Any stale arm → the `stale_content` refusal carrying every stale target
 * (`staleTargets`, beside the retained scalar first-arm fields) and the
 * outline served from the judged walk; otherwise `null` and the walk is
 * dropped. Read errors propagate raw — the flows' transport classification
 * applies (breaker counting, 429 cooldown).
 */
export async function freshContentRefusal(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	targets: { blockId: string; baselineHash: string | undefined }[],
	context: { sessionId: string; docId: string },
): Promise<Envelope | null> {
	if (targets.length === 0) return null;
	const { walk, arms } = await checkFreshContent(kernel, {
		docId: context.docId,
		targets,
	});
	const staleArms: Extract<FreshArm, { kind: "stale" }>[] = [];
	for (const arm of arms) {
		switch (arm.kind) {
			case "vanished":
				continue;
			case "walk-truncated":
				// Absence from a walk truncated at the depth bound is
				// unconfirmed — the target may sit past the bound. Not
				// fresh, not vanished: skip (the baseline is retained, so a
				// later edit re-judges like vanished does).
				continue;
			case "fresh":
			case "unseen":
				baselines.remember(arm.blockId, arm.currentContent);
				continue;
			case "stale":
				baselines.remember(arm.blockId, arm.currentContent);
				staleArms.push(arm);
				continue;
		}
		arm satisfies never;
	}
	const first = staleArms[0];
	if (first === undefined) return null;
	// The refusal's outline renders from the judged snapshot — its heading
	// content is seeded like every other serve site, or a follow-up edit on
	// a served heading takes the no-baseline fallback and launders a
	// concurrent change past the precondition. The walk is already in hand.
	const fresh = serveOutlineFromWalk(
		context.sessionId,
		"kb_write",
		walk.blocks,
		baselines,
	);
	return refusedEnvelope(
		`the content of block '${first.blockId}' changed since it was last seen in this session — re-read the current state with kb_read, then re-target (reason: stale_content)`,
		{
			reason: "stale_content",
			blockId: first.blockId,
			currentContent: first.currentContent,
			staleTargets: staleArms.map((arm) => ({
				blockId: arm.blockId,
				currentContent: arm.currentContent,
			})),
			...fresh,
		},
	);
}

// ---------------------------------------------------------------------------
// Write-result contract — echoes + verification evidence
// ---------------------------------------------------------------------------

/** Post-mutation wrapper for the verification + echo reads every write
 * runs AFTER the kernel mutation has been issued. A network drop there
 * must not surface as runKbCall's "SiYuan unreachable" envelope: the
 * mutation may already be applied, and that message invites the blind
 * retry that would duplicate or re-apply the write. Network/timeout
 * errors become a distinct `verificationFailed` error envelope; auth and
 * rate-limit errors still propagate so runKbCall keeps classifying them
 * (breaker counting, 429 cooldown). */
export async function finishWrite(
	kb: string,
	extra: Record<string, unknown>,
	build: () => Promise<Envelope>,
): Promise<Envelope> {
	try {
		return await build();
	} catch (err) {
		if (
			!(err instanceof SiYuanNetworkError) &&
			!(err instanceof SiYuanTimeoutError) &&
			// A kernel rejection mid-verification (unknown/locked id) leaves
			// the write's outcome unverified too — same envelope. Sibling of
			// auth/rate-limit, so breaker counting and 429 cooldown are not
			// affected.
			!(err instanceof SiYuanApiError)
		) {
			throw err;
		}
		const partial = takePartialReplace(err);
		// A mid-sequence failure (replace-section's delete sweep) attaches its
		// partial-apply state to the error before it lands here — the envelope
		// must carry it, or the re-run-invites-duplication hazard the sweep's
		// own catch guards against re-enters one error class over.
		return errorEnvelope(
			partial === undefined
				? verificationReadsFailedMessage(
						err instanceof Error ? err.message : String(err),
					)
				: `the write is partially applied — a mid-write step failed: ` +
						`${err instanceof Error ? err.message : String(err)} — the earlier ` +
						`steps have landed; do NOT re-run, re-fetch the outline (kb_read) ` +
						`and reconcile from the payload (deletedBlockIds/remainingBlockIds)`,
			{ ...extra, ...partial, kb, verificationFailed: true },
		);
	}
}
