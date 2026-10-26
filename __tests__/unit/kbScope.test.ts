// kbScope tests — the KB-param contract: resolution, scope refusal
// wordings, and the rate-limit skip flag (all kernel-free; the gate's
// refusal arms ride these exact sentences).

import { describe, expect, it } from "vitest";
import { resolveKbParam } from "../../kbScope.js";
import { validation } from "./fixtures.js";

describe("kb param contract", () => {
	const v = validation();

	it("a rate-limit-skipped validation refuses with the skip named, not stale-or-encrypted", () => {
		// rateLimitedValidation shape: settings parsed, empty valid set, the
		// skip flag set — the refusal must not misreport the KB as stale.
		const skipped = validation({
			validKBs: [],
			scope: [],
		});
		skipped.skippedDueToRateLimit = true;
		const r = resolveKbParam("recipes", "single", skipped);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("validation was skipped");
			expect(r.message).not.toContain("stale or encrypted");
		}
		// Without the flag the same shape still refuses, with the stale branch.
		const plain = validation({ validKBs: [], scope: [] });
		const stale = resolveKbParam("recipes", "single", plain);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.message).toContain("stale or encrypted");
	});

	it("a failed session listing refuses with the failure named, not stale-or-encrypted", () => {
		// runSessionValidation's listing catch on a non-429 failure (bad token,
		// wrong baseUrl, transport drop): the KB is neither stale nor encrypted.
		const failed = validation({ validKBs: [], scope: [] });
		failed.lsNotebooksOk = false;
		const r = resolveKbParam("recipes", "single", failed);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("notebook listing failed");
			expect(r.message).not.toContain("stale or encrypted");
		}
	});

	it("requires the kb param", () => {
		const result = resolveKbParam(undefined, "single", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain(
			"'kb' parameter is required",
		);
	});

	it("rejects an empty array locally (the empty-scope message, no kernel call)", () => {
		const result = resolveKbParam([], "array", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"no KBs in scope — activate one with /kb <name> on, or set gnubrain.defaultKBs",
		);
	});

	it("rejects an unknown KB naming the active set", () => {
		const result = resolveKbParam(["recipies"], "array", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"unknown KB 'recipies'. Active: recipes",
		);
	});

	it("rejects a valid KB outside the active scope, naming the activation paths", () => {
		const result = resolveKbParam("projects", "single", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"'projects' exists but is not in the active scope — activate it with /kb, or change gnubrain.defaultKBs in settings",
		);
	});

	it("rejects a configured-but-invalid KB (stale/encrypted)", () => {
		const v2 = validation({ validKBs: [["recipes", "nb-r"]] });
		const result = resolveKbParam("projects", "single", v2);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain("stale or encrypted");
	});

	it("resolves multi-KB sweeps and single names", () => {
		const v2 = validation({ scope: ["recipes", "projects"] });
		expect(resolveKbParam(["recipes", "projects"], "array", v2)).toEqual({
			ok: true,
			names: ["recipes", "projects"],
		});
		expect(resolveKbParam("recipes", "single", v2)).toEqual({
			ok: true,
			names: ["recipes"],
		});
	});

	it("dedupes repeated names (the search fan-out runs one kernel call per name)", () => {
		const v2 = validation({ scope: ["recipes"] });
		expect(resolveKbParam(["recipes", "recipes"], "array", v2)).toEqual({
			ok: true,
			names: ["recipes"],
		});
	});

	it("rejects a non-string 'kb' on single-name calls (the schema is the contract; this guard is the backstop)", () => {
		const message = "'kb' must be exactly one KB name for this call";
		expect(resolveKbParam(["a", "b"], "single", v)).toEqual({
			ok: false,
			message,
		});
		expect(resolveKbParam(["a"], "single", v)).toEqual({
			ok: false,
			message,
		});
		expect(resolveKbParam(42, "single", v)).toEqual({
			ok: false,
			message,
		});
	});
});
