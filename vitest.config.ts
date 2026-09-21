// The integration suite shares one live kernel and carries cross-file
// execution order (search-shape first, throttle after all kernel cases,
// the raw-DML hardening pin last) — its files must never run in parallel with
// each other, and their order must not depend on vitest's cache-driven
// default sort (unknown files by size, then previous-run duration, longest
// first — the ~8-minute throttle file would otherwise drift to the front of
// the queue and arm the lock over the whole suite). Unit tests don't touch
// the kernel, so they keep default parallelism via a separate project.
import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import type { TestSpecification } from "vitest/node";

// Execution order for the live integration suite (endsWith match on the
// file name). The throttle file must stay last: its throttle case arms the
// kernel's per-IP lock (the raw-DML hardening pin runs after the lock's
// expiry, inside the same file).
const INTEGRATION_ORDER = [
	"smoke.live.test.ts", // search-shape first (cheapest falsifier)
	"harness.live.test.ts",
	"headlessKb.live.test.ts", // pi -p child process, needs the kernel
	"readPins.live.test.ts",
	"writeModes.live.test.ts",
	"writePins.live.test.ts",
	"gate.live.test.ts", // pi children (masking/scope) + in-process auth breaker
	"throttleLive.live.test.ts", // encrypted → throttle (arms the lock) → raw-DML hardening
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
