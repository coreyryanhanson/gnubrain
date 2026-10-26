// status bar slot — a glance surface, two words max. The text never changes
// with capability; the dot color carries it. Precedence is fix-it causes
// before wait-it-out ones: unreachable → red; degraded-config causes
// (yellow, first match wins) → shape `config`, tripped breaker `breaker`,
// version drift `version`, lockout `lockout`; then never-probed → grey;
// healthy → capability colors. Drift out-ranks a lockout because a lockout
// clears without anyone deciding anything, while drift needs a config or
// kernel change — the cause that survives the cooldown stays visible after
// it.

import { renderScopeList } from "./kbScope.js";
import type { ProbeVerdict, SessionValidation } from "./validation.js";

interface KbStatusTheme {
	/** pi's Theme.fg — colorizes the glyph. */
	fg(color: string, text: string): string;
}

export interface KbStatusInput {
	probe: ProbeVerdict;
	shapeErrors: string[];
	breakerTripped: boolean;
	/** The session cannot serve calls — a session-liveness fact, not a
	 * probe verdict. Derived in statusInput. */
	lockout: boolean;
	scope: string[];
	/** Live toolset state (no toolsets registered → both false → hollow). */
	readsEnabled: boolean;
	writesEnabled: boolean;
}

const GLYPH_FILLED = "●";
const GLYPH_HOLLOW = "○";

/**
 * The single derivation site for the status slot's input — the one place a
 * future lockout source joins (OR it into `lockout`). The cooldown reads
 * fresh here (no clock in the cached validation claim), so a cooldown leg
 * clears itself at the next paint after expiry; the skip-flag leg holds
 * until /kb re-validates. The paint contract this
 * rests on: every status-input mutation happens inside a kb tool call (the
 * gate's cached-probe writes, a 429 arming the cooldown, breaker
 * trip/recovery) or on an already-painting path (session start, /kb,
 * session_tree, toolset events) — so the tool-result boundary in index.ts
 * covers the whole class, no per-source change hook.
 */
export function statusInput(
	breaker: { tripped: boolean; inCooldown(): boolean },
	validation: SessionValidation | undefined,
	toolsets: { reads: boolean; writes: boolean },
): KbStatusInput {
	return {
		probe: validation?.probe ?? { verdict: "never-probed" },
		shapeErrors: validation?.shapeErrors ?? [],
		breakerTripped: breaker.tripped,
		lockout: breaker.inCooldown() || validation?.skippedDueToRateLimit === true,
		scope: validation?.scope ?? [],
		// Glyph state reads live toolset state — any disabler (our toggle,
		// toolsetDefaults pins, allowlist mode) is reflected.
		readsEnabled: toolsets.reads,
		writesEnabled: toolsets.writes,
	};
}

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
		return `${fg("error", GLYPH_FILLED)} kb: ${renderScopeList(input.scope)}`;
	}

	// Degraded-config causes: yellow, first match wins in severity order.
	let cause: string | undefined;
	if (input.shapeErrors.length > 0) cause = "config";
	else if (input.breakerTripped) cause = "breaker";
	else if (verdict === "version") cause = "version";
	else if (input.lockout) cause = "lockout";
	if (cause !== undefined) {
		return `${fg("warning", GLYPH_FILLED)} kb: ${cause}`;
	}

	if (verdict === "never-probed") {
		return `${fg("muted", GLYPH_FILLED)} kb: ${renderScopeList(input.scope)}`;
	}

	// Healthy: the capability ladder — writes on → success/green; else reads on
	// → accent/blue; else hollow. Glyph state reads live toolset state.
	const glyph =
		input.writesEnabled || input.readsEnabled ? GLYPH_FILLED : GLYPH_HOLLOW;
	const color = input.writesEnabled ? "success" : "accent";
	return `${fg(color, glyph)} kb: ${renderScopeList(input.scope)}`;
}
