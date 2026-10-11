// The per-KB, per-interaction write grant: one tri-state dialog per KB per
// interaction (ctx.ui.select), the turn/session grant sets, the
// turn-denial set every non-answer lands in, and the process-wide dialog
// lock — plus the markdownFile trust posture. Every path here is a
// zero-kernel-call local decision: the gate runs before the probe's live
// legs and before any guard query.

import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import type {
	ExtensionUIDialogOptions,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { refusedEnvelope, type Envelope } from "./envelope.js";

const DEFAULT_WRITE_CONFIRM_TIMEOUT = 60;

/** Exact grant labels — grant polarity is `=== label`: every other answer
 * (the literal No, an ESC's undefined, a native-timeout dismissal, an
 * unknown or renamed label, a thrown select) denies the KB for the
 * interaction. "Yes" stays index 0, so reflexive Enter grants at most the
 * current interaction. */
export const GRANT_YES = "Yes";
export const GRANT_SESSION = "Always this session";
export const GRANT_OPTIONS = [GRANT_YES, GRANT_SESSION, "No"];

/** Select seam matching pi's ExtensionUIContext.select — aliased onto
 * pi's own exported types so the seam cannot drift from the real API:
 * the abort signal (the run's signal — pi force-resolves the dialog to
 * undefined on abort, in every mode) and the native timeout in
 * milliseconds (0 = none, no option passed). */
export type GrantSelectOptions = ExtensionUIDialogOptions;
export type GrantSelectFn = ExtensionUIContext["select"];

/** Per-KB write-grant state — session-scoped machinery, same lifecycle
 * class as the breaker. Grants key on KB name. `lock` serializes the
 * single-slot interactive selector (process-wide, not per-KB): concurrent
 * writes queue on the chain and inherit the verdict. */
export interface WriteGrantState {
	turnGrants: Set<string>;
	sessionGrants: Set<string>;
	turnDenials: Set<string>;
	lock: Promise<unknown>;
}

export function createWriteGrantState(): WriteGrantState {
	return {
		turnGrants: new Set(),
		sessionGrants: new Set(),
		turnDenials: new Set(),
		lock: Promise.resolve(),
	};
}

/** Interaction boundary (agent_settled): turn grants and the turn-denial
 * set clear; session grants survive. The lock resets with them — hygiene
 * for already-released chains, never the primary release path. */
export function clearInteractionGrants(state: WriteGrantState): void {
	state.turnGrants.clear();
	state.turnDenials.clear();
	state.lock = Promise.resolve();
}

/** Session boundary (session_start / session_shutdown): all three sets
 * clear and the lock resets — a stale grant or denial must not leak across
 * a session replacement in the same process. */
export function clearSessionGrants(state: WriteGrantState): void {
	state.turnGrants.clear();
	state.sessionGrants.clear();
	state.turnDenials.clear();
	state.lock = Promise.resolve();
}

/** The one terminal-denial refusal. The cause is never stated as fact — a
 * declined, dismissed, and timed-out dialog are indistinguishable, and the
 * wording owns that ambiguity. `$suffix` carries the thrown-select detail
 * only; there is no second string. */
function denialEnvelope(name: string, suffix = ""): Envelope {
	return refusedEnvelope(
		`no write grant for KB '${name}' this interaction — the approval dialog ` +
			`was not answered with a grant (declined, dismissed, or timed out; these ` +
			`are indistinguishable and all terminal). Do not retry or rephrase a ` +
			`write to this KB; report the pending write to the user — the dialog ` +
			`returns when you next attempt the write after their reply.${suffix}`,
		{ reason: "write_denied" },
	);
}

/**
 * The write-entry grant gate — after shape/kb resolution and the static
 * drift refusal, before the probe gate's live legs. Only the two exact
 * grant labels grant; every other answer denies the KB for the rest of the
 * interaction (terminal, remembered, no re-prompting).
 * `allowUnattendedWrites: true` skips the dialog in every session;
 * headless sessions without it default-deny.
 * The dialog runs behind the process-wide lock with grant state re-checked
 * inside it — "check, then acquire" would resurrect the check-then-act
 * race against the single-slot selector — so concurrent writes queue and
 * inherit the verdict. The lock releases in a finally-shaped continuation:
 * verdict, denial, thrown select, and abort all release, or a rejected
 * chain tail would wedge every later kb_write in the process.
 */
export async function grantGate(input: {
	name: string;
	hasUI: boolean;
	allowUnattendedWrites: boolean | undefined;
	writeConfirmTimeout: number | undefined;
	signal: AbortSignal | undefined;
	select: GrantSelectFn;
	state: WriteGrantState;
}): Promise<Envelope | null> {
	const { name, state } = input;
	if (input.allowUnattendedWrites === true) return null;
	if (state.turnGrants.has(name) || state.sessionGrants.has(name)) return null;
	if (state.turnDenials.has(name)) return denialEnvelope(name);
	if (!input.hasUI) {
		return refusedEnvelope(
			`no UI is available to grant the write (headless session) — writes are ` +
				`denied by default. Set gnubrain.allowUnattendedWrites: true in the ` +
				`global settings file to allow unattended writes.`,
			{ reason: "write_denied" },
		);
	}
	const run = state.lock.then(async (): Promise<Envelope | null> => {
		// Re-check inside the lock: a concurrent write may have settled the
		// verdict while this one queued behind it.
		if (state.turnGrants.has(name) || state.sessionGrants.has(name)) {
			return null;
		}
		if (state.turnDenials.has(name)) return denialEnvelope(name);
		const title =
			`Agent wants to write to KB '${name}' this interaction (may include ` +
			`deletes). Back up your KB first if in doubt (SiYuan → Data ` +
			`History can help; it is not a backup).`;
		const seconds = input.writeConfirmTimeout ?? DEFAULT_WRITE_CONFIRM_TIMEOUT;
		const opts: GrantSelectOptions = {
			...(input.signal !== undefined ? { signal: input.signal } : {}),
			...(seconds > 0 ? { timeout: seconds * 1000 } : {}),
		};
		let answer: string | undefined;
		try {
			answer = await input.select(title, GRANT_OPTIONS, opts);
		} catch (err) {
			state.turnDenials.add(name);
			return denialEnvelope(
				name,
				` (dialog failed: ${err instanceof Error ? err.message : String(err)})`,
			);
		}
		if (answer === GRANT_YES) {
			state.turnGrants.add(name);
			return null;
		}
		if (answer === GRANT_SESSION) {
			state.sessionGrants.add(name);
			return null;
		}
		// Every non-answer is terminal: No, undefined (ESC, native timeout,
		// abort), an unrecognized label — one arm, no cause-split.
		state.turnDenials.add(name);
		return denialEnvelope(name);
	});
	// Release the lock no matter how the dialog settles.
	state.lock = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

// ---------------------------------------------------------------------------
// File-path input — markdown XOR markdownFile, read once at call start
// ---------------------------------------------------------------------------

/** The trust posture: "must exist, must be a regular file" — no path
 * allowlisting (single-user VM holding an admin token). */
export async function readBodyFile(path: string): Promise<string> {
	let stat;
	try {
		stat = await fsStat(path);
	} catch (err) {
		throw new Error(
			`markdownFile '${path}' is not readable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`markdownFile '${path}' is not a regular file`);
	}
	try {
		return await fsReadFile(path, "utf8");
	} catch (err) {
		throw new Error(
			`markdownFile '${path}' is unreadable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
