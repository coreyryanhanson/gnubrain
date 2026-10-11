// /kb command — scope print, single-name and set-wide toggles, and the
// /kb tools toolset dispatcher. Pure dispatch: recovery (re-validation),
// persistence, and the actual toolset enable/disable happen in index.ts
// before/after this returns.

import { kbNameProblem } from "./gate.js";
import type { SessionValidation } from "./validation.js";

interface KbCommandResult {
	message: string;
	severity: "info" | "warning" | "error";
	/** Defined only on an actual scope change — the full post-toggle snapshot. */
	newScope: string[] | undefined;
	/** Defined only on an actual toolset change — the target states (the
	 * /kb tools verbs are state setters, not toggles). */
	newReadsEnabled: boolean | undefined;
	newWritesEnabled: boolean | undefined;
}

const USAGE =
	"usage: /kb — print scope; /kb <name> on|off — toggle a KB; /kb all on|off — toggle the whole valid set; /kb tools [read|write|off] — set the tool state";
const TOOLS_USAGE =
	"usage: /kb tools — print tool state; /kb tools read — read tools only; /kb tools write — read + write; /kb tools off — all kb tools off";

// No scope or toolset change — every read-only / no-op return shares this.
const NO_CHANGE = {
	newScope: undefined,
	newReadsEnabled: undefined,
	newWritesEnabled: undefined,
} as const;

export function dispatchKbCommand(
	args: string,
	validation: SessionValidation,
	/** Bare `/kb` appends one toolset-state line per registered toolset
	 * (tool-masking record — a masked toolset is printed, never silent). */
	toolsetLines: string[] = [],
	/** Live toolset state — the /kb tools verbs are state setters over it. */
	readsEnabled = true,
	writesEnabled = false,
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
		return dispatchTools(
			parts.slice(1),
			readsEnabled,
			writesEnabled,
			toolsetLines,
		);
	}
	if (parts.length !== 2 || (parts[1] !== "on" && parts[1] !== "off")) {
		return { ...NO_CHANGE, message: USAGE, severity: "error" };
	}
	const [name, verb] = parts as [string, "on" | "off"];
	const turningOn = verb === "on";
	if (name === "all") {
		const fullSet = (validation.settings?.kbs ?? []).flatMap((kb) =>
			validation.validKBs.has(kb.name) ? [kb.name] : [],
		);
		if (turningOn && fullSet.length === 0) {
			return {
				...NO_CHANGE,
				message: "no valid KBs to activate — nothing changed",
				severity: "warning",
			};
		}
		return applyScope(turningOn ? fullSet : [], validation);
	}

	const problem = kbNameProblem(name, validation);
	if (problem !== undefined) {
		return { ...NO_CHANGE, message: problem, severity: "error" };
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
// there is exactly one command per state. `write` targets read+write (the
// requires-cascade pulls reads on with it); `read` targets read-only
// (an explicit write disable — the portal /web on precedent); `off` masks
// both.
function dispatchTools(
	verbs: string[],
	readsEnabled: boolean,
	writesEnabled: boolean,
	toolsetLines: string[],
): KbCommandResult {
	if (verbs.length === 0) {
		return {
			...NO_CHANGE,
			message: toolsetLines.join("\n"),
			severity: "info",
		};
	}
	const verb = verbs[0];
	if (
		verbs.length > 1 ||
		(verb !== "read" && verb !== "write" && verb !== "off")
	) {
		return { ...NO_CHANGE, message: TOOLS_USAGE, severity: "error" };
	}
	const target =
		verb === "write"
			? { reads: true, writes: true }
			: verb === "read"
				? { reads: true, writes: false }
				: { reads: false, writes: false };
	if (readsEnabled === target.reads && writesEnabled === target.writes) {
		return {
			...NO_CHANGE,
			message:
				verb === "write"
					? "kb tools already read+write"
					: verb === "read"
						? "kb tools already read-only"
						: "kb tools already off",
			severity: "info",
		};
	}
	const message =
		verb === "write"
			? "kb tools read+write — write toolset on (reads cascaded on)"
			: verb === "read"
				? "kb tools read-only — write toolset masked (/kb tools write re-enables)"
				: "kb tools off — all kb toolsets masked (/kb tools read|write re-enables)";
	return {
		message,
		severity: "info",
		newScope: undefined,
		newReadsEnabled: target.reads,
		newWritesEnabled: target.writes,
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
		newWritesEnabled: undefined,
	};
}

function scopeSummary(
	validation: SessionValidation,
	toolsetLines: string[],
): string {
	const lines = [`scope: ${scopeList(validation)}`];
	// Degradation reasons (shape errors, incl. a revalidate that degraded):
	// bare /kb is the diagnostic surface — never print the degraded scope
	// without naming why.
	lines.push(...validation.shapeErrors);
	// Warn-and-drop reasons (unknown config name, stale/encrypted notebook):
	// the scope silently shrank, so name what fell out.
	lines.push(...validation.warnings);
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
