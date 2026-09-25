// The layering contract, pinned mechanically: gnubrain touches the
// primitives only through their two entry points and never names the
// layer-1 client package — a deep import or a second kernel-api copy
// would break both the greppable invariant and error-class identity.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCES = readdirSync(ROOT).filter((f) => f.endsWith(".ts"));

function read(name: string): string {
	return readFileSync(join(ROOT, name), "utf8");
}

function importSpecifiers(name: string): string[] {
	return [...read(name).matchAll(/from "([^"]+)"/g)]
		.map((m) => m[1])
		.filter((s): s is string => s !== undefined);
}

describe("layering — primitives entry points only", () => {
	it("no root module names siyuan-kernel-api (one layer-1 copy)", () => {
		for (const name of SOURCES) {
			expect(read(name).includes("siyuan-kernel-api")).toBe(false);
		}
	});

	it("primitives imports use only the two entry points (no deep imports)", () => {
		for (const name of SOURCES) {
			for (const spec of importSpecifiers(name)) {
				if (spec.startsWith("siyuan-kb-primitives")) {
					expect(
						["siyuan-kb-primitives", "siyuan-kb-primitives/write"],
						`${name}: ${spec}`,
					).toContain(spec);
				}
			}
		}
	});
});
