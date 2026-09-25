// The integration suite shares one live kernel and carries cross-file
// execution order (search-shape first, gate/headless files later). Its files
// must never run in parallel with each other, and their order must not depend
// on vitest's cache-driven default sort (unknown files by size, then
// previous-run duration, longest first). Unit tests don't touch
// the kernel, so they keep default parallelism via a separate project.
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// Execution order for the live integration suite (endsWith match on the
// file name). The throttle schedule pin lives in the primitives live suite;
// the one lock-arming case here (breaker.live's 429 cooldown case, opt-in
// via SIYUAN_INTEGRATION_THROTTLE=1) arms a minimal ~2 min lock and must run
// last — while it is held, every other live case on this IP would 429.
// Without the flag nothing arms the lock and the ordering is convention.
const INTEGRATION_ORDER = [
	"smoke.live.test.ts", // search-shape first (cheapest falsifier)
	"harness.live.test.ts",
	"headlessKb.live.test.ts", // pi -p child process, needs the kernel
	"readPins.live.test.ts",
	"writeModes.live.test.ts",
	"writePins.live.test.ts",
	"gate.live.test.ts", // pi children (masking/scope), in-process
	"throttleLive.live.test.ts", // encrypted + raw-DML hardening (no lock arming)
	"breaker.live.test.ts", // 401 breaker + 429 cooldown (arms a lock under THROTTLE — last)
];

class OrderedSequencer extends BaseSequencer {
	async sort(specs: TestSpecification[]): Promise<TestSpecification[]> {
		const sorted = await super.sort(specs);
		return [...sorted].sort((a, b) => {
			const ra = INTEGRATION_ORDER.findIndex((n) => a.moduleId.endsWith(n));
			const rb = INTEGRATION_ORDER.findIndex((n) => b.moduleId.endsWith(n));
			if (ra === rb) return 0; // includes both unlisted → keep default order
			if (ra === -1) return 1;
			if (rb === -1) return -1;
			return ra - rb;
		});
	}
}

export default defineConfig({
	test: {
		// Verbose by default: runs tee to logs per policy, so per-case lines
		// make failures greppable without a re-run. CLI flags still win.
		reporters: ["verbose"],
		sequence: {
			sequencer: OrderedSequencer,
		},
		projects: [
			{
				test: {
					name: "unit",
					include: ["__tests__/**/*.test.ts"],
					exclude: ["__tests__/integration/**"],
				},
			},
			{
				test: {
					name: "integration",
					include: ["__tests__/integration/**/*.test.ts"],
					fileParallelism: false,
				},
			},
		],
	},
});
