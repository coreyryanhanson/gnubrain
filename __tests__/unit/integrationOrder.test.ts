// Guard for the integration suite's fixed order (vitest.config.ts): every
// integration file must end with an entry in INTEGRATION_ORDER, and every
// entry must name an existing file — an unlisted live file sorts after
// every listed one, silently reordering the kernel-mutating suite.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTEGRATION_ORDER } from "../../vitest.config.js";

const liveFiles = readdirSync(new URL("../integration/", import.meta.url))
	.filter((f) => f.endsWith(".test.ts"))
	.sort();

describe("integration suite ordering", () => {
	it("every integration test file appears in INTEGRATION_ORDER", () => {
		const missing = liveFiles.filter(
			(f) => !INTEGRATION_ORDER.some((n) => f.endsWith(n)),
		);
		expect(missing, `add to INTEGRATION_ORDER: ${missing.join(", ")}`).toEqual(
			[],
		);
	});

	it("every INTEGRATION_ORDER entry names an existing integration file", () => {
		const stale = INTEGRATION_ORDER.filter(
			(n) => !liveFiles.some((f) => f.endsWith(n)),
		);
		expect(stale, `stale entries: ${stale.join(", ")}`).toEqual([]);
	});
});
