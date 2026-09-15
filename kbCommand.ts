// §5 /kb command — scope print, single-name and set-wide toggles.
// Pure dispatch: recovery (re-validation) and persistence happen in index.ts
// before/after this returns. `writes` toggling the write toolset lands in
// Sprint 5; until then it is rejected as a reserved unknown name.

import { kbNameProblem } from "./gate.js";
import type { SessionValidation } from "./validation.js";

export interface KbCommandResult {
	message: string;
	severity: "info" | "warning" | "error";
	/** Defined only on an actual scope change — the full post-toggle snapshot. */
	newScope: string[] | undefined;
}

const USAGE =
	"usage: /kb — print scope; /kb <name> on|off — toggle a KB; /kb all on|off — toggle the whole valid set";

export function dispatchKbCommand(
	args: string,
	validation: SessionValidation,
): KbCommandResult {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return {
			message: scopeSummary(validation),
			severity: "info",
			newScope: undefined,
		};
	}
	if (parts.length !== 2 || (parts[1] !== "on" && parts[1] !== "off")) {
		return { message: USAGE, severity: "error", newScope: undefined };
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
			};
		}
		return applyScope(turningOn ? fullSet : [], validation);
	}

	const problem = kbNameProblem(name, validation);
	if (problem !== undefined) {
		return { message: problem, severity: "error", newScope: undefined };
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

function applyScope(
	target: string[],
	validation: SessionValidation,
): KbCommandResult {
	// Idempotent re-toggle: report the no-op, don't rewrite an identical snapshot.
	if (sameSet(target, validation.scope)) {
		return {
			message: `scope unchanged: ${scopeList(validation)}`,
			severity: "info",
			newScope: undefined,
		};
	}
	return {
		message: `scope: ${target.length > 0 ? target.join(", ") : "(none)"}`,
		severity: "info",
		newScope: target,
	};
}

function scopeSummary(validation: SessionValidation): string {
	const lines = [`scope: ${scopeList(validation)}`];
	const available = (validation.settings?.kbs ?? [])
		.map((kb) => kb.name)
		.filter((n) => validation.validKBs.has(n) && !validation.scope.includes(n));
	if (available.length > 0) {
		lines.push(`available but off: ${available.join(", ")}`);
	}
	return lines.join("\n");
}

function scopeList(validation: SessionValidation): string {
	return validation.scope.length > 0 ? validation.scope.join(", ") : "(none)";
}

function sameSet(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((n, i) => n === b[i]);
}
