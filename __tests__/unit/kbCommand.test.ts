import { describe, expect, it } from "vitest";
import { dispatchKbCommand } from "../../kbCommand.js";
import type { SessionValidation } from "../../validation.js";

function validation(overrides?: {
	scope?: string[];
	validKBs?: [string, string][];
}): SessionValidation {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [
				{ name: "recipes", notebook: "nb-r" },
				{ name: "projects", notebook: "nb-p" },
				{ name: "archive", notebook: "nb-a" },
			],
		},
		shapeErrors: [],
		probe: "ok",
		kernelVersion: "3.8.3",
		validKBs: new Map(
			overrides?.validKBs ?? [
				["recipes", "nb-r"],
				["projects", "nb-p"],
			],
		),
		scope: overrides?.scope ?? ["recipes"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	};
}

describe("dispatchKbCommand", () => {
	it("bare /kb prints the scope and the available-but-off set", () => {
		const result = dispatchKbCommand("", validation());
		expect(result.message).toBe("scope: recipes\navailable but off: projects");
		expect(result.newScope).toBeUndefined();
	});

	it("bare /kb on an empty scope says (none)", () => {
		const result = dispatchKbCommand("", validation({ scope: [] }));
		expect(result.message).toContain("scope: (none)");
	});

	it("verbless /kb <name> prints usage", () => {
		const result = dispatchKbCommand("recipes", validation());
		expect(result.severity).toBe("error");
		expect(result.message).toContain("usage: /kb");
		expect(result.newScope).toBeUndefined();
	});

	it("/kb <name> on activates an inactive KB (full snapshot)", () => {
		const result = dispatchKbCommand("projects on", validation());
		expect(result.newScope).toEqual(["recipes", "projects"]);
	});

	it("/kb <name> off deactivates an active KB", () => {
		const result = dispatchKbCommand("recipes off", validation());
		expect(result.newScope).toEqual([]);
	});

	it("an idempotent re-toggle reports the no-op without rewriting the snapshot", () => {
		const on = dispatchKbCommand("recipes on", validation());
		expect(on.message).toContain("scope unchanged");
		expect(on.newScope).toBeUndefined();
		const off = dispatchKbCommand(
			"projects off",
			validation({ scope: ["recipes"] }),
		);
		expect(off.message).toContain("scope unchanged");
		expect(off.newScope).toBeUndefined();
	});

	it("/kb all on activates the full valid set in config order, skipping invalid KBs", () => {
		const v = validation({
			validKBs: [
				["recipes", "nb-r"],
				["projects", "nb-p"],
			],
		});
		const result = dispatchKbCommand("all on", v);
		expect(result.newScope).toEqual(["recipes", "projects"]);
	});

	it("/kb all off writes an empty scope", () => {
		const result = dispatchKbCommand("all off", validation());
		expect(result.newScope).toEqual([]);
	});

	it("/kb all on with zero valid KBs is a reported no-op", () => {
		const result = dispatchKbCommand("all on", validation({ validKBs: [] }));
		expect(result.message).toContain("no valid KBs to activate");
		expect(result.newScope).toBeUndefined();
	});

	it("an unknown name is rejected with the same message as the tool kb param", () => {
		const result = dispatchKbCommand("nope on", validation());
		expect(result.severity).toBe("error");
		expect(result.message).toBe("unknown KB 'nope'. Active: recipes");
	});

	it("a configured-but-invalid name gets the stale/encrypted rejection", () => {
		const result = dispatchKbCommand("archive on", validation());
		expect(result.message).toContain(
			"KB 'archive' is not available (stale or encrypted notebook",
		);
	});

	it("bare /kb tools prints the toolset-state lines", () => {
		const result = dispatchKbCommand(
			"tools",
			validation(),
			["read toolset (kb_query, kb_search, kb_read): on"],
			true,
		);
		expect(result.severity).toBe("info");
		expect(result.message).toBe(
			"read toolset (kb_query, kb_search, kb_read): on",
		);
		expect(result.newScope).toBeUndefined();
		expect(result.newReadsEnabled).toBeUndefined();
	});

	// /kb tools verbs are state setters over BOTH toolsets. The
	// writesEnabled arg defaults to false (tests below pass it explicitly).
	it("/kb tools read sets the read-only state; re-issuing it is a reported no-op", () => {
		const on = dispatchKbCommand("tools read", validation(), [], true, false);
		expect(on.message).toContain("already read-only");
		expect(on.newReadsEnabled).toBeUndefined();
		expect(on.newWritesEnabled).toBeUndefined();
		// From read+write, `read` explicitly disables writes (portal /web on).
		const fromWrite = dispatchKbCommand(
			"tools read",
			validation(),
			[],
			true,
			true,
		);
		expect(fromWrite.message).toContain("read-only");
		expect(fromWrite.newReadsEnabled).toBe(true);
		expect(fromWrite.newWritesEnabled).toBe(false);
		const off = dispatchKbCommand("tools read", validation(), [], false, false);
		expect(off.message).toContain("read-only");
		expect(off.newReadsEnabled).toBe(true);
		expect(off.newWritesEnabled).toBe(false);
	});

	it("/kb tools write targets read+write; enabling cascades reads on", () => {
		const fromRead = dispatchKbCommand(
			"tools write",
			validation(),
			[],
			true,
			false,
		);
		expect(fromRead.message).toContain("read+write");
		expect(fromRead.newReadsEnabled).toBe(true);
		expect(fromRead.newWritesEnabled).toBe(true);
		const fromOff = dispatchKbCommand(
			"tools write",
			validation(),
			[],
			false,
			false,
		);
		expect(fromOff.newReadsEnabled).toBe(true);
		expect(fromOff.newWritesEnabled).toBe(true);
		const noop = dispatchKbCommand("tools write", validation(), [], true, true);
		expect(noop.message).toContain("already read+write");
		expect(noop.newReadsEnabled).toBeUndefined();
		expect(noop.newWritesEnabled).toBeUndefined();
	});

	it("/kb tools off masks both toolsets; re-issuing it is a reported no-op", () => {
		const on = dispatchKbCommand("tools off", validation(), [], true, true);
		expect(on.message).toContain("all kb toolsets masked");
		expect(on.newReadsEnabled).toBe(false);
		expect(on.newWritesEnabled).toBe(false);
		const partial = dispatchKbCommand(
			"tools off",
			validation(),
			[],
			true,
			false,
		);
		expect(partial.newReadsEnabled).toBe(false);
		expect(partial.newWritesEnabled).toBe(false);
		const off = dispatchKbCommand("tools off", validation(), [], false, false);
		expect(off.message).toContain("already off");
		expect(off.newReadsEnabled).toBeUndefined();
		expect(off.newWritesEnabled).toBeUndefined();
	});

	it("/kb tools with an unknown verb prints tool usage", () => {
		const junk = dispatchKbCommand("tools junk", validation(), [], true, false);
		expect(junk.severity).toBe("error");
		expect(junk.message).toContain("usage: /kb tools");
		const extra = dispatchKbCommand(
			"tools read extra",
			validation(),
			[],
			true,
			false,
		);
		expect(extra.severity).toBe("error");
		expect(extra.message).toContain("usage: /kb tools");
	});

	it("a KB named 'writes' is no longer reserved and resolves as a KB name", () => {
		const result = dispatchKbCommand(
			"writes on",
			validation({ validKBs: [["writes", "nb-w"]] }),
		);
		expect(result.newScope).toEqual(["recipes", "writes"]);
	});
});
