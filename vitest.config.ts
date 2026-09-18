// The integration suite shares one live kernel and carries cross-file
// execution order (§10: search-shape first, throttle after all kernel cases,
// raw-DELETE last) — its files must never run in parallel with each other.
// Unit tests don't touch the kernel, so they keep default parallelism via a
// separate project.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
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
