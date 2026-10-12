// writeFresh tests — the fresh-content precondition wrapper's per-arm
// session doctrine over the primitives' checkFreshContent judgment,
// driven directly on the stubbed kernel.

import { describe, expect, it } from "vitest";
import { contentHash } from "siyuan-kb-primitives";
import { freshContentRefusal } from "../../writeFresh.js";
import { ContentBaselines } from "../../baselines.js";
import { walkBlock, writeKernelStub } from "./writeHarness.js";

describe("freshContentRefusal", () => {
	const ctx = { sessionId: "s1", docId: "d-doc" };

	it("unseen → adopt the live form and proceed (null)", async () => {
		// No baseline, no SQL row: the session never served the block, so
		// there is no stored value to launder — the live form becomes the
		// baseline and the caller proceeds.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "live body")] },
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("live body"));
	});

	it("seed-and-check fresh → remember (the baseline is seeded even when every arm is fresh)", async () => {
		// No baseline, but the SQL row matches the walk — the establish
		// side effect survives the promotion: the residual paths' later
		// checks compare like-for-like.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "index form")] },
			baselineRows: [{ id: "p1", content: "index form" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("index form"));
	});

	it("vanished → skipped (delete no-op class), no baseline remembered", async () => {
		// The classification (walk-absence before any SQL read, even with a
		// lingering blocks.content row inside the convergence window) is
		// falsified down-repo in the primitives' fresh.test.ts; this asserts
		// the wrapper's half — a `vanished` arm must not remember, so a
		// misclassification as `unseen` would fail the servedHash assertion.
		const stub = writeKernelStub({
			baselineRows: [{ id: "p1", content: "lingering index row" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBeUndefined();
	});

	it("empty target list → null with zero kernel calls", async () => {
		const stub = writeKernelStub({});
		const verdict = await freshContentRefusal(
			stub.client,
			ContentBaselines.create(),
			[],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(stub.calls).toHaveLength(0);
	});
});
