// KB-scope vocabulary and resolution — the pieces the gate, the tool
// registrations, the status slot, and the /kb command all consume. Kept
// apart from gate.ts's dispatch so presentation surfaces (status, /kb)
// never depend on the gate module: they import from here, the gate
// imports from here, and the dependency direction stays one-way.

import type { SessionValidation } from "./validation.js";

/** `query`/`search` take an array of names; every other tool exactly one. */
export type KbArity = "array" | "single";

/** Empty-scope wording — shared by the gate and the `kbs` discovery
 * form (kb_read), which reuses it verbatim for an empty active set. */
export const EMPTY_SCOPE_MESSAGE =
	"no KBs in scope — activate one with /kb <name> on, or set gnubrain.defaultKBs";

/** Rate-limit-skip wording — shared by the named-KB refusal (kbNameProblem)
 * and the `kbs` discovery form, which has no name to re-validate. */
export const RATE_LIMIT_SKIP_MESSAGE =
	"session validation was skipped while the kernel was rate-limited — run /kb to re-validate";

/** Readiness wording — shared by all four tool registrations so the
 * discovery-facing strings cannot drift between read and write tools. */
export const NOT_READY_VALIDATION =
	"kb tools are not ready — session validation has not run";

/** One rendering of the active-name list for agent- and user-facing
 * messages; a wording change lands here once. */
export function renderScopeList(names: readonly string[]): string {
	return names.length > 0 ? names.join(", ") : "(none)";
}

/** The gate guarantees every resolved name sits in the valid set; this keeps
 * that invariant explicit rather than a non-null assertion. Throw, never an
 * error envelope: ops run inside runKbCall's catch, which renders the message. */
export function resolveBox(
	name: string,
	validation: SessionValidation,
): string {
	const box = validation.validKBs.get(name);
	if (box === undefined) {
		throw new Error(
			`internal: '${name}' passed the gate but left the valid set`,
		);
	}
	return box;
}

/** One rejection vocabulary shared by the tool `kb` param and `/kb`
 * toggles — unknown name vs configured-but-invalid. */
export function kbNameProblem(
	name: string,
	validation: SessionValidation,
): string | undefined {
	// A validation skipped under an armed 429 cooldown has an empty valid set
	// by design — the KB is neither stale nor encrypted, so naming the skip is
	// the only honest refusal. /kb re-validates once the cooldown expires.
	if (validation.skippedDueToRateLimit === true) {
		return `${RATE_LIMIT_SKIP_MESSAGE} '${name}'`;
	}
	if (validation.validKBs.has(name)) return undefined;
	if (!validation.settings?.kbs.some((entry) => entry.name === name)) {
		return `unknown KB '${name}'. Active: ${renderScopeList(validation.scope)}`;
	}
	// Configured but dropped from the valid set (stale/encrypted).
	return `KB '${name}' is not available (stale or encrypted notebook — see the session warnings). Active: ${renderScopeList(validation.scope)}`;
}

/** `kb` param contract — messages are the model's discovery mechanism. */
export function resolveKbParam(
	kb: unknown,
	arity: KbArity,
	validation: SessionValidation,
): { ok: true; names: string[] } | { ok: false; message: string } {
	if (kb === undefined || kb === null) {
		return {
			ok: false,
			message:
				"the 'kb' parameter is required — pass a KB name (query/search accept an array of names)",
		};
	}
	if (arity === "array") {
		if (!Array.isArray(kb) || !kb.every((n) => typeof n === "string")) {
			return {
				ok: false,
				message: "'kb' must be an array of KB name strings",
			};
		}
		const names = kb as string[];
		if (names.length === 0) {
			// Refused locally, no kernel call: an empty resolved set must mean
			// "nothing is in scope", never "search everything".
			return { ok: false, message: EMPTY_SCOPE_MESSAGE };
		}
	} else if (typeof kb !== "string") {
		// Single-arity tools declare `kb: Type.String()`; pi validates tool
		// arguments before dispatch, so an array or non-string never reaches
		// here — this guard is the local backstop, not the contract.
		return {
			ok: false,
			message: "'kb' must be exactly one KB name for this call",
		};
	}
	const requested: string[] =
		arity === "array" ? (kb as string[]) : [kb as string];
	for (const name of requested) {
		const problem = kbNameProblem(name, validation);
		if (problem !== undefined) {
			return { ok: false, message: problem };
		}
		if (!validation.scope.includes(name)) {
			return {
				ok: false,
				message: `'${name}' exists but is not in the active scope — activate it with /kb, or change gnubrain.defaultKBs in settings`,
			};
		}
	}
	// Dedupe: the search fan-out issues one kernel call per name, so a
	// repeated name would run the same search twice and merge every row
	// twice; the echo must reflect what actually ran.
	return { ok: true, names: [...new Set(requested)] };
}
