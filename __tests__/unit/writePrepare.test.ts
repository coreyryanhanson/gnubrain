// writePrepare tests — the ordered kernel-free ladder of the kb_write
// entry: shape/mint/drift refusals precede the grant dialog, and the
// grant precedes the probe gate — executed through the registered
// kb_write tool via the shared harness.

import { describe, expect, it } from "vitest";
import { base, setup, validation } from "./writeHarness.js";

describe("static drift refusal precedes the grant dialog", () => {
	it("a version-drifted session refuses kb_write with zero select calls and zero kernel calls", async () => {
		const { execute, grantCalls, calls } = setup({
			validation: validation({
				probe: { verdict: "drift", kernelVersion: "3.8.3" },
			}),
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("does not match the pinned version");
		expect(grantCalls).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});

describe("kernel-free shape legs precede the grant dialog", () => {
	it("a mint-title refusal opens no dialog and fires zero kernel calls", async () => {
		const { execute, grantCalls, calls } = setup();
		const r = await execute({ ...base, topic: "   " });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("title is empty after trim");
		expect(grantCalls).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	it("a mode-target shape refusal opens no dialog and fires zero kernel calls", async () => {
		const { execute, grantCalls, calls } = setup();
		const r = await execute({ ...base, topic: undefined, blockId: undefined });
		expect(r.status).toBe("refused");
		expect(r.message).toContain('mode "create" requires topic');
		expect(grantCalls).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});
