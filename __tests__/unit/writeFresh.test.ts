// writeFresh tests — the fresh-content precondition's session doctrine:
// the arm policy (`applyFreshArms`, the shared home every fresh-refused
// verdict's carried arms pass through) driven directly. The judgment
// lives inside the write primitives; the flows mint their verdict inputs
// straight from session state and compose the refusal envelope from the
// verdict's carried arms.

import { describe, expect, it } from "vitest";
import { contentHash } from "siyuan-kernel-primitives";
import { applyFreshArms } from "../../writeFresh.js";
import { ContentBaselines } from "../../baselines.js";
import type { FreshOutcome } from "siyuan-kernel-primitives/write";

describe("applyFreshArms", () => {
	// The arm policy is pure over the judged arms — the session doctrine
	// without the judgment (which lives in the primitives).

	it("unseen → adopt the live form (remembered), never stale", () => {
		// The session never served the block, so there is no stored value to
		// launder — the live form becomes the baseline and the caller
		// proceeds.
		const baselines = ContentBaselines.create();
		const arms: FreshOutcome[] = [
			{ kind: "unseen", blockId: "p1", currentContent: "live body" },
		];
		applyFreshArms(baselines, arms);
		expect(baselines.servedBaseline("p1")).toEqual({
			kind: "served",
			hash: contentHash("live body"),
		});
	});

	it("fresh → remember (a hash-equal arm still lands in the store)", () => {
		// A fresh arm's remember stores the judged content; since the hash
		// already matches the walk, this is the establish side effect the
		// residual paths' later checks rely on to compare like-for-like.
		const baselines = ContentBaselines.create();
		const arms: FreshOutcome[] = [
			{ kind: "fresh", blockId: "p1", currentContent: "index form" },
		];
		applyFreshArms(baselines, arms);
		expect(baselines.servedBaseline("p1")).toEqual({
			kind: "served",
			hash: contentHash("index form"),
		});
	});

	it("vanished → skipped (delete no-op class), no baseline remembered", () => {
		// A misclassification as `unseen` would fail the servedBaseline
		// assertion — the baseline is retained, so a return via undo
		// re-judges as `fresh` if unchanged, `stale` if not.
		const baselines = ContentBaselines.create();
		baselines.remember("p1", "older form");
		const arms: FreshOutcome[] = [{ kind: "vanished", blockId: "p1" }];
		applyFreshArms(baselines, arms);
		expect(baselines.servedBaseline("p1")).toEqual({
			kind: "served",
			hash: contentHash("older form"),
		});
	});

	it("absence-unconfirmed → skipped like vanished (the baseline is retained)", () => {
		// Absence from an incomplete walk is unconfirmed — the target may
		// sit past the depth bound or behind a swallowed branch.
		const baselines = ContentBaselines.create();
		baselines.remember("p1", "older form");
		const arms: FreshOutcome[] = [
			{ kind: "absence-unconfirmed", blockId: "p1" },
		];
		applyFreshArms(baselines, arms);
		expect(baselines.servedBaseline("p1")).toEqual({
			kind: "served",
			hash: contentHash("older form"),
		});
	});

	it("stale → re-baselined; the judged-order stale subset rides the verdict's own tuple", () => {
		// The content moves only because it is visible in the same envelope
		// (the anti-laundering invariant: baselines.ts), so the retry
		// proceeds against informed consent instead of refuse-looping. The
		// ordering claim lives with the tuple the judgment renders
		// (primitives fresh.ts); the flow-level staleTargets order is pinned
		// in writeReplaceSection.test.ts.
		const baselines = ContentBaselines.create();
		const arms: FreshOutcome[] = [
			{
				kind: "stale",
				blockId: "b1",
				currentContent: "now",
				compared: "baseline",
			},
			{ kind: "fresh", blockId: "b2", currentContent: "same" },
			{
				kind: "stale",
				blockId: "b3",
				currentContent: "also now",
				compared: "baseline",
			},
		];
		applyFreshArms(baselines, arms);
		expect(baselines.servedBaseline("b1")).toEqual({
			kind: "served",
			hash: contentHash("now"),
		});
		expect(baselines.servedBaseline("b2")).toEqual({
			kind: "served",
			hash: contentHash("same"),
		});
		expect(baselines.servedBaseline("b3")).toEqual({
			kind: "served",
			hash: contentHash("also now"),
		});
	});
});
