// The fresh-content pre-mutation precondition: the wrapper over the
// primitives' checkFreshContent judgment that the flows with served
// baselines run right before any kernel write (edit, replace-section,
// block delete). A concurrency guard, not a consent mechanism (the grant
// resolved at the kb_write entry). Session-baseline doctrine lives here
// beside the baselines it reads; the judgment and both reads live in the
// primitives.

import { type Envelope, refusedEnvelope } from "./envelope.js";
import { checkFreshContent, type FreshOutcome } from "siyuan-kb-primitives";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import type { ContentBaselines } from "./baselines.js";
import { serveOutlineFromWalk } from "./outline.js";

/** Fresh-content precondition, checked right before the kernel write: the
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
 *   the content moves only because it is visible in the same envelope
 *   (the anti-laundering invariant: baselines.ts), so the retry proceeds
 *   against informed consent instead of refuse-looping
 * - `vanished` → skip (delete no-op class; the baseline is retained, so a
 *   return via undo re-judges as `fresh` if unchanged, `stale` if not)
 * Any stale arm → the `stale_content` refusal carrying every stale target
 * (`staleTargets`, beside the retained scalar first-arm fields) and the
 * outline served from the judged walk; otherwise `null` and the walk is
 * dropped. Read errors propagate raw — the flows' transport classification
 * applies (breaker counting, 429 cooldown). */
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
	const staleArms: Extract<FreshOutcome, { kind: "stale" }>[] = [];
	for (const arm of arms) {
		switch (arm.kind) {
			case "vanished":
				continue;
			case "absence-unconfirmed":
				// Absence from an incomplete walk is unconfirmed — the target
				// may sit past the depth bound or behind a swallowed branch.
				// Not fresh, not vanished: skip (the baseline is retained, so a
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
	// The refusal's outline renders from the judged snapshot — seeded like
	// every other serve site (anti-laundering invariant: baselines.ts). The
	// walk is already in hand.
	const fresh = serveOutlineFromWalk(
		context.sessionId,
		"kb_write",
		walk,
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
