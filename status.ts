// status bar slot — a glance surface, two words max. The text never changes
// with capability; the dot color carries it. Precedence is severity-first:
// unreachable → red; degraded-config causes (yellow, first match wins) →
// shape `config`, tripped breaker `breaker`, version drift `version`;
// then never-probed → grey; healthy → capability colors.

import type { ProbeVerdict } from "./validation.js";

export interface KbStatusTheme {
	/** pi's Theme.fg — colorizes the glyph. */
	fg(color: string, text: string): string;
}

export interface KbStatusInput {
	probe: ProbeVerdict;
	shapeErrors: string[];
	breakerTripped: boolean;
	scope: string[];
	/** Live toolset state (no toolsets registered → both false → hollow). */
	readsEnabled: boolean;
	writesEnabled: boolean;
}

const GLYPH_FILLED = "●";
const GLYPH_HOLLOW = "○";

/**
 * Pure render — headless-safe (no ctx access; the caller wraps `setStatus` in
 * try/catch). Without a theme, colors pass through unchanged.
 */
export function renderKbStatus(
	input: KbStatusInput,
	theme?: KbStatusTheme,
): string {
	const fg = theme
		? (color: string, text: string) => theme.fg(color, text)
		: (_color: string, text: string) => text;

	// The verdict read as a discriminator: one exhaustive switch (no default)
	// plus the trailing never-check — a new ProbeVerdict member is a compile
	// error here instead of a silently blank status dot. The ladder below
	// interleaves non-verdict causes, so the ordering lives outside.
	const verdict = ((): "unreachable" | "version" | "never-probed" | "ok" => {
		switch (input.probe.verdict) {
			case "unreachable":
				return "unreachable";
			case "drift":
				return "version";
			case "never-probed":
				return "never-probed";
			case "ok":
				return "ok";
		}
		input.probe satisfies never;
		return "ok";
	})();

	if (verdict === "unreachable") {
		return `${fg("error", GLYPH_FILLED)} kb: ${input.scope.join(", ") || "(none)"}`;
	}

	// Degraded-config causes: yellow, first match wins in severity order.
	let cause: string | undefined;
	if (input.shapeErrors.length > 0) cause = "config";
	else if (input.breakerTripped) cause = "breaker";
	else if (verdict === "version") cause = "version";
	if (cause !== undefined) {
		return `${fg("warning", GLYPH_FILLED)} kb: ${cause}`;
	}

	if (verdict === "never-probed") {
		return `${fg("muted", GLYPH_FILLED)} kb: ${input.scope.join(", ") || "(none)"}`;
	}

	// Healthy: the capability ladder — writes on → success/green; else reads on
	// → accent/blue; else hollow. Glyph state reads live toolset state.
	const glyph =
		input.writesEnabled || input.readsEnabled ? GLYPH_FILLED : GLYPH_HOLLOW;
	const color = input.writesEnabled ? "success" : "accent";
	return `${fg(color, glyph)} kb: ${input.scope.join(", ") || "(none)"}`;
}
