// The layering contract, pinned mechanically: gnubrain touches the
// primitives only through their entry points and never names the
// layer-1 client package — a deep import or a second kernel-api copy
// would break both the greppable invariant and error-class identity.
// The testing entry is additionally scoped to test files: it is the
// window-collapse seam, and production code has no reason to touch it.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const list = (dir: string, ext: string): string[] =>
	readdirSync(join(ROOT, dir), { recursive: true })
		.filter((f): f is string => typeof f === "string")
		.filter((f) => f.endsWith(ext))
		.map((f) => join(dir, f));

// Everything the repo ships or runs — root sources, tests, scripts — not
// just the root modules. The boundary test itself is excluded: its own
// name cites the layer-1 package.
const SOURCES = [
	...readdirSync(ROOT).filter((f) => f.endsWith(".ts")),
	...list("__tests__", ".ts"),
	...list("scripts", ".mjs"),
].filter((f) => !f.endsWith("layerBoundary.test.ts"));

function read(name: string): string {
	return readFileSync(join(ROOT, name), "utf8");
}

function importSpecifiers(name: string): string[] {
	return [...read(name).matchAll(/from "([^"]+)"/g)]
		.map((m) => m[1])
		.filter((s): s is string => s !== undefined);
}

describe("layering — primitives entry points only", () => {
	it("no shipped module names siyuan-kernel-api (one layer-1 copy)", () => {
		for (const name of SOURCES) {
			expect(read(name).includes("siyuan-kernel-api")).toBe(false);
		}
	});

	it("primitives imports use only the entry points (no deep imports)", () => {
		const matched: string[] = [];
		for (const name of SOURCES) {
			const testOnly = name.startsWith("__tests__");
			for (const spec of importSpecifiers(name)) {
				if (spec.startsWith("siyuan-kb-primitives")) {
					matched.push(`${name}: ${spec}`);
					expect(
						testOnly
							? [
									"siyuan-kb-primitives",
									"siyuan-kb-primitives/write",
									"siyuan-kb-primitives/testing",
								]
							: ["siyuan-kb-primitives", "siyuan-kb-primitives/write"],
						`${name}: ${spec}`,
					).toContain(spec);
				}
			}
		}
		// Guard against the assertion passing vacuously: with no
		// primitives imports at all, the loop above would check nothing.
		expect(matched.length).toBeGreaterThan(0);
	});

	it("package.json has no direct layer-1 dependency", () => {
		const pkg = JSON.parse(read("package.json")) as {
			dependencies?: Record<string, string>;
		};
		expect(
			Object.keys(pkg.dependencies ?? {}).filter((d) =>
				d.startsWith("siyuan-kernel-"),
			),
		).toEqual([]);
	});
});
