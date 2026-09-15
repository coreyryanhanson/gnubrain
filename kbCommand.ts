// §5 /kb command — scope print, single-name and set-wide toggles, and the
// /kb tools toolset dispatcher. Pure dispatch: recovery (re-validation),
// persistence, and the actual toolset enable/disable happen in index.ts
// before/after this returns. Read verbs (tools read|off) land here; the
// write verb lands with the write toolset and prints usage until then.

import { kbNameProblem } from "./gate.js";
import type { SessionValidation } from "./validation.js";

export interface KbCommandResult {
	message: string;
	severity: "info" | "warning" | "error";
	/** Defined only on an actual scope change — the full post-toggle snapshot. */
	newScope: string[] | undefined;
	/** Defined only on an actual toolset change — the read toolset's target
	 * state (the /kb tools verbs are state setters, not toggles). */
	newReadsEnabled: boolean | undefined;
}

const USAGE =
	"usage: /kb — print scope; /kb <name> on|off — toggle a KB; /kb all on|off — toggle the whole valid set; /kb tools [read|off] — set the tool state";
const TOOLS_USAGE =
	"usage: /kb tools — print tool state; /kb tools read — read tools only; /kb tools off — all kb tools off";

// No scope or toolset change — every read-only / no-op return shares this.
const NO_CHANGE = { newScope: undefined, newReadsEnabled: undefined } as const;

export function dispatchKbCommand(
	args: string,
	validation: SessionValidation,
	/** Bare `/kb` appends one toolset-state line per registered toolset
	 * (§5 tool-masking record — a masked toolset is printed, never silent).
	 * Sprint 3 passes the read toolset's line; Sprint 5 adds the write one. */
	toolsetLines: string[] = [],
	/** Live read-toolset state — the /kb tools verbs are state setters over it. */
	readsEnabled = true,
): KbCommandResult {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return {
			...NO_CHANGE,
			message: scopeSummary(validation, toolsetLines),
			severity: "info",
		};
	}
	if (parts[0] === "tools") {
		return dispatchTools(parts.slice(1), readsEnabled, toolsetLines);
	}
	if (parts.length !== 2 || (parts[1] !== "on" && parts[1] !== "off")) {
		return {
			message: USAGE,
			severity: "error",
			newScope: undefined,
			newReadsEnabled: undefined,
		};
	}
	const [name, verb] = parts as [string, "on" | "off"];
	const turningOn = verb === "on";
	if (name === "all") {
		const fullSet = (validation.settings?.kbs ?? []).flatMap((kb) =>
			validation.validKBs.has(kb.name) ? [kb.name] : [],
		);
		if (turningOn && fullSet.length === 0) {
			return {
				message: "no valid KBs to activate — nothing changed",
				severity: "warning",
				newScope: undefined,
				newReadsEnabled: undefined,
			};
		}
		return applyScope(turningOn ? fullSet : [], validation);
	}

	const problem = kbNameProblem(name, validation);
	if (problem !== undefined) {
		return {
			message: problem,
			severity: "error",
			newScope: undefined,
			newReadsEnabled: undefined,
		};
	}
	let target: string[];
	if (!turningOn) {
		target = validation.scope.filter((n) => n !== name);
	} else if (validation.scope.includes(name)) {
		target = validation.scope;
	} else {
		target = [...validation.scope, name];
	}
	return applyScope(target, validation);
}

// /kb tools — state-setter verbs per the portal /web precedent: each verb
// targets an absolute end state, so re-issuing one is a reported no-op and
// there is exactly one command per state. (The write-disable leg of `read`
// and the `write` verb activate with the write toolset.)
function dispatchTools(
	verbs: string[],
	readsEnabled: boolean,
	toolsetLines: string[],
): KbCommandResult {
	if (verbs.length === 0) {
		const state =
			toolsetLines.length > 0
				? toolsetLines.join("\n")
				: `kb tools: read toolset ${readsEnabled ? "on" : "off"}`; // ponytail: 2-level ternary, splits worse than it reads
		return { ...NO_CHANGE, message: state, severity: "info" };
	}
	const verb = verbs[0];
	if (verbs.length > 1 || (verb !== "read" && verb !== "off")) {
		return { ...NO_CHANGE, message: TOOLS_USAGE, severity: "error" };
	}
	if (verb === "read") {
		if (readsEnabled) {
			return {
				...NO_CHANGE,
				message: "kb tools already read-only",
				severity: "info",
			};
		}
		return {
			message: "kb tools read-only — read toolset on (/kb tools off re-masks)",
			severity: "info",
			newScope: undefined,
			newReadsEnabled: true,
		};
	}
	if (!readsEnabled) {
		return { ...NO_CHANGE, message: "kb tools already off", severity: "info" };
	}
	return {
		message: "kb tools off — read toolset masked (/kb tools read re-enables)",
		severity: "info",
		newScope: undefined,
		newReadsEnabled: false,
	};
}

function applyScope(
	target: string[],
	validation: SessionValidation,
): KbCommandResult {
	// Idempotent re-toggle: report the no-op, don't rewrite an identical snapshot.
	if (sameSet(target, validation.scope)) {
		return {
			...NO_CHANGE,
			message: `scope unchanged: ${scopeList(validation)}`,
			severity: "info",
		};
	}
	return {
		message: `scope: ${target.length > 0 ? target.join(", ") : "(none)"}`,
		severity: "info",
		newScope: target,
		newReadsEnabled: undefined,
	};
}

function scopeSummary(
	validation: SessionValidation,
	toolsetLines: string[],
): string {
	const lines = [`scope: ${scopeList(validation)}`];
	const available = (validation.settings?.kbs ?? [])
		.map((kb) => kb.name)
		.filter((n) => validation.validKBs.has(n) && !validation.scope.includes(n));
	if (available.length > 0) {
		lines.push(`available but off: ${available.join(", ")}`);
	}
	lines.push(...toolsetLines);
	return lines.join("\n");
}

function scopeList(validation: SessionValidation): string {
	return validation.scope.length > 0 ? validation.scope.join(", ") : "(none)";
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((n, i) => n === b[i]);
}
