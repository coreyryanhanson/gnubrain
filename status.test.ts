import { describe, expect, it } from "vitest";
import { renderKbStatus, type KbStatusInput } from "./status.js";

// Passthrough theme — the pure render is what's under test; a real theme
// colorizes the glyph via Theme.fg.
const theme = { fg: (_color: string, text: string) => text };

function input(overrides?: Partial<KbStatusInput>): KbStatusInput {
	return {
		probe: "ok",
		shapeErrors: [],
		breakerTripped: false,
		scope: ["recipes", "projects"],
		readsEnabled: false,
		writesEnabled: false,
		...overrides,
	};
}

describe("renderKbStatus", () => {
	it("renders the scope names with a hollow glyph in Sprint 1 (no toolsets)", () => {
		expect(renderKbStatus(input(), theme)).toBe("○ kb: recipes, projects");
	});

	it("is headless-safe without a theme (plain text, no throw)", () => {
		expect(renderKbStatus(input())).toBe("○ kb: recipes, projects");
	});

	it("an unreachable kernel shows red and keeps the scope text", () => {
		const text = renderKbStatus(input({ probe: "unreachable" }), {
			fg: (c, t) => `[${c}]${t}`,
		});
		expect(text).toBe("[error]● kb: recipes, projects");
	});

	it("degraded-config causes branch two-word tags, first match wins in severity order", () => {
		const render = (o: Partial<KbStatusInput>) =>
			renderKbStatus(input(o), theme);
		expect(render({ shapeErrors: ["bad"] })).toBe("● kb: config");
		// Unreachable wins over a tripped breaker — red, scope text, no tag.
		expect(render({ breakerTripped: true, probe: "unreachable" })).toBe(
			"● kb: recipes, projects",
		);
		expect(render({ breakerTripped: true })).toBe("● kb: breaker");
		expect(render({ probe: "drift" })).toBe("● kb: version");
		// Shape failure beats the breaker and version drift.
		expect(
			render({ shapeErrors: ["bad"], breakerTripped: true, probe: "drift" }),
		).toBe("● kb: config");
	});

	it("degraded-config beats the healthy colors, and shape-failure beats never-probed grey", () => {
		expect(
			renderKbStatus(
				input({ probe: "never-probed", shapeErrors: ["bad"] }),
				theme,
			),
		).toBe("● kb: config");
	});

	it("never-probed renders grey with the scope text", () => {
		expect(renderKbStatus(input({ probe: "never-probed" }), theme)).toBe(
			"● kb: recipes, projects",
		);
	});

	it("the healthy capability ladder: reads on → filled dot (Sprint 3 wires the color)", () => {
		expect(
			renderKbStatus(input({ readsEnabled: true }), {
				fg: (c, t) => `[${c}]${t}`,
			}),
		).toBe("[accent]● kb: recipes, projects");
	});

	it("writes on beats reads on → success/green", () => {
		expect(
			renderKbStatus(input({ readsEnabled: true, writesEnabled: true }), {
				fg: (c, t) => `[${c}]${t}`,
			}),
		).toBe("[success]● kb: recipes, projects");
	});

	it("an empty scope renders (none)", () => {
		expect(renderKbStatus(input({ scope: [] }), theme)).toBe("○ kb: (none)");
	});
});
