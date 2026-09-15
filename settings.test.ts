import { describe, expect, it } from "vitest";
import {
	loadGnubrainSettings,
	validateGnubrainSettings,
	validateProjectSettings,
	type ValidationResult,
} from "./settings.js";

function expectErrors(result: ValidationResult): string[] {
	if (result.ok) throw new Error("expected validation to fail");
	return result.errors;
}

function validConfig(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		gnubrain: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "dev", notebook: "20240101120000-abc1234" }],
			...overrides,
		},
	};
}

describe("validateGnubrainSettings", () => {
	it("accepts a valid config", () => {
		const result = validateGnubrainSettings(validConfig());
		expect(result.ok).toBe(true);
	});

	it("accepts absent optional keys, including defaultKBs", () => {
		const result = validateGnubrainSettings(validConfig());
		expect(result.ok && result.settings.defaultKBs).toBeUndefined();
		expect(result.ok && result.settings.allowUnattendedWrites).toBeUndefined();
		expect(result.ok && result.settings.writeConfirmTimeout).toBeUndefined();
	});

	it("rejects a missing gnubrain object", () => {
		expect(expectErrors(validateGnubrainSettings({}))).toContain(
			"settings.json must contain a 'gnubrain' object",
		);
	});

	it.each([null, [], "gnubrain", 42, { gnubrain: 42 }])(
		"rejects non-object raw config: %j",
		(raw) => {
			expect(expectErrors(validateGnubrainSettings(raw))).toContain(
				"settings.json must contain a 'gnubrain' object",
			);
		},
	);

	it.each([
		["baseUrl", "baseUrl is required and must be a non-empty string"],
		["apiToken", "apiToken is required and must be a non-empty string"],
		["kbs", "kbs is required and must be an array"],
	])("rejects missing %s", (key, expected) => {
		const config = validConfig();
		delete (config["gnubrain"] as Record<string, unknown>)[key];
		expect(expectErrors(validateGnubrainSettings(config))).toContain(expected);
	});

	it.each([
		[{ baseUrl: 42 }, "baseUrl is required and must be a non-empty string"],
		[{ apiToken: "" }, "apiToken is required and must be a non-empty string"],
		[{ kbs: "dev" }, "kbs is required and must be an array"],
		[{ defaultKBs: "dev" }, "defaultKBs must be an array of KB name strings"],
		[
			{ defaultKBs: ["a", 1] },
			"defaultKBs must be an array of KB name strings",
		],
		[
			{ allowUnattendedWrites: "yes" },
			"allowUnattendedWrites must be a boolean",
		],
		[
			{ writeConfirmTimeout: -1 },
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		],
		[
			{ writeConfirmTimeout: 1.5 },
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		],
	])("rejects bad type: %j", (overrides, expected) => {
		expect(
			expectErrors(validateGnubrainSettings(validConfig(overrides))),
		).toContain(expected);
	});

	it.each([
		[
			"baseUrl",
			" http://192.168.100.1:6806 ",
			"baseUrl is required and must be a non-empty string",
		],
		[
			"apiToken",
			" token ",
			"apiToken is required and must be a non-empty string",
		],
	])("rejects surrounding whitespace on %s", (key, value, expected) => {
		const config = validConfig();
		(config["gnubrain"] as Record<string, unknown>)[key] = value;
		expect(expectErrors(validateGnubrainSettings(config))).toContain(expected);
	});

	it.each([
		[
			"duplicate KB name 'dev'",
			[
				{ name: "dev", notebook: "a" },
				{ name: "dev", notebook: "b" },
			],
		],
		["kbs[0].name must be a non-empty string", [{ name: "", notebook: "a" }]],
		["kbs[0].name must be a non-empty string", [{ name: "  ", notebook: "a" }]],
		[
			"kbs[0].name must be a non-empty string",
			[{ name: " dev ", notebook: "a" }],
		],
		["kbs[0] must be an object with 'name' and 'notebook'", [42]],
		[
			"kbs[0].notebook must be a non-empty string",
			[{ name: "dev", notebook: "" }],
		],
		["kbs[0].notebook must be a non-empty string", [{ name: "dev" }]],
		[
			"KB name 'dev kb' must not contain whitespace or /",
			[{ name: "dev kb", notebook: "a" }],
		],
		[
			"KB name 'dev/kb' must not contain whitespace or /",
			[{ name: "dev/kb", notebook: "a" }],
		],
		[
			"KB name 'all' is reserved for the /kb command",
			[{ name: "all", notebook: "a" }],
		],
		[
			"KB name 'tools' is reserved for the /kb command",
			[{ name: "tools", notebook: "a" }],
		],
	])("rejects %s", (expected, kbs) => {
		expect(
			expectErrors(validateGnubrainSettings(validConfig({ kbs }))),
		).toContain(expected);
	});

	it("accepts the §5 special values: writeConfirmTimeout 0 and allowUnattendedWrites true", () => {
		const result = validateGnubrainSettings(
			validConfig({ writeConfirmTimeout: 0, allowUnattendedWrites: true }),
		);
		expect(result.ok).toBe(true);
		expect(result.ok && result.settings.writeConfirmTimeout).toBe(0);
		expect(result.ok && result.settings.allowUnattendedWrites).toBe(true);
	});

	it("rejects a defaultKBs entry naming an unknown KB", () => {
		expect(
			expectErrors(
				validateGnubrainSettings(validConfig({ defaultKBs: ["missing"] })),
			),
		).toContain("defaultKBs entry 'missing' does not match any configured KB");
	});

	it("accepts defaultKBs naming a configured KB and preserves it", () => {
		const result = validateGnubrainSettings(
			validConfig({ defaultKBs: ["dev"] }),
		);
		expect(result.ok).toBe(true);
		expect(result.ok && result.settings.defaultKBs).toEqual(["dev"]);
	});
});

describe("project settings (§5 project-vs-global split)", () => {
	it("a project file with no gnubrain key is simply no project settings", () => {
		const result = validateProjectSettings({ other: {} });
		expect(result.errors).toEqual([]);
		expect(result.defaultKBs).toBeUndefined();
	});

	it("a non-object file or non-object gnubrain degrades", () => {
		expect(validateProjectSettings("not json").errors).toContain(
			"project settings file must contain a JSON object",
		);
		expect(validateProjectSettings({ gnubrain: 42 }).errors).toContain(
			"project gnubrain must be an object",
		);
	});

	it("a stray non-defaultKBs key degrades with the key named", () => {
		const result = validateProjectSettings({
			gnubrain: { kbs: [{ name: "x", notebook: "y" }] },
		});
		expect(result.errors).toContain(
			"project gnubrain settings only support 'defaultKBs'; unexpected key 'kbs'",
		);
	});

	it("connection and attention dials are global-only — a project copy is rejected loudly", () => {
		for (const key of [
			"baseUrl",
			"apiToken",
			"writeConfirmTimeout",
			"allowUnattendedWrites",
		]) {
			const result = validateProjectSettings({
				gnubrain: { [key]: true },
			});
			expect(result.errors).toContain(
				`project gnubrain settings only support 'defaultKBs'; unexpected key '${key}'`,
			);
		}
	});

	it("a non-array project defaultKBs degrades with the M1 message verbatim", () => {
		expect(
			validateProjectSettings({ gnubrain: { defaultKBs: "dev" } }).errors,
		).toContain("defaultKBs must be an array of KB name strings");
		expect(
			validateProjectSettings({ gnubrain: { defaultKBs: [1] } }).errors,
		).toContain("defaultKBs must be an array of KB name strings");
	});

	it("a valid project defaultKBs is preserved", () => {
		const result = validateProjectSettings({
			gnubrain: { defaultKBs: ["dev"] },
		});
		expect(result.errors).toEqual([]);
		expect(result.defaultKBs).toEqual(["dev"]);
	});

	it("the loader reads the global file through the full validator and a missing project file is no settings", async () => {
		const loaded = await loadGnubrainSettings(
			async () => JSON.stringify(validConfig()),
			"global",
			undefined,
		);
		expect(loaded.global.ok).toBe(true);
		expect(loaded.project.errors).toEqual([]);
	});

	it("a missing global file is a shape failure; a missing project file is not", async () => {
		const notFound = Object.assign(new Error("nope"), { code: "ENOENT" });
		const loaded = await loadGnubrainSettings(
			async () => {
				throw notFound;
			},
			"global",
			"project",
		);
		expect(loaded.global.ok).toBe(false);
		expect(!loaded.global.ok && loaded.global.errors[0]).toContain("not found");
		expect(loaded.project.errors).toEqual([]);
	});

	it("unparseable JSON degrades both files with the path named", async () => {
		const loaded = await loadGnubrainSettings(
			async () => "{oops",
			"global",
			"project",
		);
		expect(loaded.global.ok).toBe(false);
		expect(!loaded.global.ok && loaded.global.errors[0]).toContain("global");
		expect(loaded.project.errors[0]).toContain("project");
	});
});
