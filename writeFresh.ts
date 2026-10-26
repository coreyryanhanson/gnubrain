// The fresh-content pre-mutation precondition's session doctrine, shared
// by every internally-judging flow: the arm policy and the one refusal
// construction live here; the judgment itself lives in the primitives.
// A concurrency guard, not a consent mechanism (the grant resolved at
// the kb_write entry).

import { type Envelope, refusedEnvelope } from "./envelope.js";
import {
	type FreshOutcome,
	type FreshRefusal,
	type StaleFreshArm,
} from "siyuan-kernel-primitives/write";
import type { ContentBaselines } from "./baselines.js";
import { serveOutlineFromWalk } from "./outline.js";

/** The stale sentence's two leads, split by the arm's own comparison
 * path: a baseline-compared arm means "changed since this session last
 * served it"; a seed-compared arm means walk-vs-index divergence — the
 * SQL row and the walk content disagree — where the session sentence
 * would be false. The judgment renders the path on the arm itself
 * (`compared`, primitives fresh.ts), so wording and judgment are
 * single-sourced with no consumer-side state. The guidance tail is
 * shared: the current state must be re-read either way. */
function staleLead(arm: StaleFreshArm): string {
	switch (arm.compared) {
		case "baseline":
			return `the content of block '${arm.blockId}' changed since this session last checked it`;
		case "seed":
			return `the live tree and the blocks index disagree about block '${arm.blockId}'`;
	}
	// Exhaustive over the arm's comparison paths; a new path in a
	// primitives release fails here.
	return arm.compared satisfies never;
}

/** The arm policy over a judged arm list — the session doctrine applied
 * to a fresh-refused verdict's carried arms. Every fresh-refused verdict
 * passes through this — every flow composes it through
 * `freshRefusalEnvelope` over its own verdict:
 * - `fresh` / `unseen` / `stale` → remember the walk content: a no-op
 *   re-seed for `fresh` (the hash already matches), the no-baseline
 *   fallback for `unseen`, and for `stale` the re-baseline that lets the
 *   retry proceed against informed consent instead of refuse-looping —
 *   the content moves only because it is named in the same envelope
 *   (the anti-laundering invariant: baselines.ts)
 * - `vanished` / `absence-unconfirmed` → skip (delete no-op class; the
 *   baseline is retained, so a return via undo re-judges as `fresh` if
 *   unchanged, `stale` if not)
 * Side-effect only: the judged-order stale subset rides the verdict's
 * own `stale` tuple (the judgment renders it), so nothing is returned. */
export function applyFreshArms(
	baselines: ContentBaselines,
	arms: FreshOutcome[],
): void {
	for (const arm of arms) {
		switch (arm.kind) {
			case "vanished":
			case "absence-unconfirmed":
				// `absence-unconfirmed` is absence from an incomplete walk —
				// the target may sit past the depth bound or behind a
				// swallowed branch — so it is neither fresh nor vanished.
				continue;
			case "fresh":
			case "unseen":
			case "stale":
				// `unseen` is the deliberate carve-out from baselines.ts's
				// invariant: on the refusal path the envelope names only the
				// stale arms, so adopted unseen content is stored but not
				// shown — a later divergence reads the session sentence even
				// though this session never served it. Stricter, never looser.
				baselines.remember(arm.blockId, arm.currentContent);
				continue;
		}
		arm satisfies never;
	}
}

/** The fresh-refused envelope builder — the module's single refusal
 * construction: the arm policy first, then the stale sentence with its
 * arm-derived lead, the retained scalar
 * first-arm fields beside the full staleTargets list, and the outline
 * served from the judged snapshot (seeded like every other serve site —
 * anti-laundering invariant: baselines.ts). The stale subset is the
 * verdict's own non-empty tuple, so no fallback for an empty one. */
export function freshRefusalEnvelope(
	baselines: ContentBaselines,
	sessionId: string,
	kb: string,
	refusal: FreshRefusal,
): Envelope {
	applyFreshArms(baselines, refusal.arms);
	const first = refusal.stale[0];
	return refusedEnvelope(
		`${staleLead(first)} — re-read the current state with kb_read, then re-target`,
		{
			kb,
			reason: "stale_content",
			blockId: first.blockId,
			currentContent: first.currentContent,
			staleTargets: refusal.stale.map((arm) => ({
				blockId: arm.blockId,
				currentContent: arm.currentContent,
			})),
			...serveOutlineFromWalk(sessionId, "kb_write", refusal.walk, baselines),
		},
	);
}
