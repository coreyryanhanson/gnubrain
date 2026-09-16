// The write-confirmation gate: headless default-deny, the interactive
// dialog, and the terminal confirm_timeout rule — plus the markdownFile
// trust posture. Every path here is a zero-kernel-call local decision: the
// gate runs before any guard query.

import { stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import { refusedEnvelope, type Envelope } from "./envelope.js";

export type WriteConfirmFn = (
	title: string,
	message: string,
	opts: { signal?: AbortSignal },
) => Promise<boolean>;

export interface WriteConfirmState {
	/** Keys of writes that hit confirm_timeout — terminal for that write in this session. */
	timedOut: Set<string>;
}

export function createWriteConfirmState(): WriteConfirmState {
	return { timedOut: new Set() };
}

/** Identifies "that write" for the terminal-timeout rule. */
export function writeConfirmKey(parts: (string | undefined)[]): string {
	return parts.map((p) => p ?? "-").join("|");
}

const DEFAULT_WRITE_CONFIRM_TIMEOUT = 60;

/**
 * Pre-dialog permission check: headless default-deny and the terminal
 * confirm_timeout rule — both zero-kernel-call checks that run before the
 * guard so a denied write costs no kernel round-trips. Returns `dialog:
 * true` when the interactive dialog must run after the guard, `dialog:
 * false` for an approved unattended write (dialog skipped).
 */
export function preflightWrite(input: {
	hasUI: boolean;
	allowUnattendedWrites: boolean | undefined;
	state: WriteConfirmState;
	key: string;
	summary: string;
}): { ok: true; dialog: boolean } | { ok: false; envelope: Envelope } {
	if (input.state.timedOut.has(input.key)) {
		return {
			ok: false,
			envelope: refusedEnvelope(
				`this write already hit confirm_timeout in this session — the refusal is terminal. Do not retry; stop and report the pending write ('${input.summary}') to the user.`,
				{ reason: "confirm_timeout" },
			),
		};
	}
	if (!input.hasUI) {
		if (input.allowUnattendedWrites === true) {
			// Dialog skipped; the write proceeds unattended.
			return { ok: true, dialog: false };
		}
		return {
			ok: false,
			envelope: refusedEnvelope(
				`no UI is available to confirm the write (headless session) — writes are denied by default. Set gnubrain.allowUnattendedWrites: true in the global settings file to allow unattended writes.`,
			),
		};
	}
	return { ok: true, dialog: true };
}

/**
 * The dialog half of the write-confirmation gate. Runs only after
 * preflightWrite passed. Returns null to proceed with the write; otherwise
 * a `refused` envelope. Fail-closed by construction: every non-answer —
 * dismissal, thrown dialog call, timeout expiry — resolves to refused. The
 * timeout clock is extension-owned via AbortSignal; the native dialog
 * auto-dismisses on abort and `controller.signal.aborted` distinguishes a
 * real timeout from an explicit decline (pi's documented timed-confirm
 * pattern). Timeout 0 waits indefinitely (no signal, no timer).
 */
export async function confirmWrite(input: {
	confirm: WriteConfirmFn;
	writeConfirmTimeout: number | undefined;
	state: WriteConfirmState;
	key: string;
	summary: string;
}): Promise<Envelope | null> {
	const { confirm, key } = input;
	const timeoutSeconds =
		input.writeConfirmTimeout ?? DEFAULT_WRITE_CONFIRM_TIMEOUT;
	const controller = new AbortController();
	const timer =
		timeoutSeconds > 0
			? setTimeout(() => controller.abort(), timeoutSeconds * 1000)
			: undefined;
	let confirmed: boolean;
	try {
		confirmed = await confirm(
			"GNUbrain write",
			`${input.summary}\n\nConfirm?`,
			timer === undefined ? {} : { signal: controller.signal },
		);
	} catch (err) {
		return refusedEnvelope(
			`write confirmation dialog failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	if (confirmed) return null;
	if (controller.signal.aborted) {
		// Terminal for this write in this session: a re-request refuses
		// immediately without a new dialog — no confirm/timeout/refuse loop.
		input.state.timedOut.add(key);
		return refusedEnvelope(
			`write confirmation timed out after ${timeoutSeconds}s (confirm_timeout) — terminal for this write in this session. Do not retry; stop and report the pending write ('${input.summary}') to the user.`,
			{ reason: "confirm_timeout" },
		);
	}
	// Explicit decline stays ordinary recoverable refused.
	return refusedEnvelope(
		`write declined by the user — a re-ask with a rephrased variant is legitimate.`,
	);
}

// ---------------------------------------------------------------------------
// File-path input — markdown XOR markdownFile, read once at call start
// ---------------------------------------------------------------------------

/** Structured error for file-path input failures (missing / not a regular
 * file / unreadable) — always resolved before any kernel call. */
class BodyFileError extends Error {}

/** The trust posture: "must exist, must be a regular file" — no path
 * allowlisting (single-user VM holding an admin token). */
export async function readBodyFile(path: string): Promise<string> {
	let stat;
	try {
		stat = await fsStat(path);
	} catch (err) {
		throw new BodyFileError(
			`markdownFile '${path}' is not readable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!stat.isFile()) {
		throw new BodyFileError(`markdownFile '${path}' is not a regular file`);
	}
	try {
		return await fsReadFile(path, "utf8");
	} catch (err) {
		throw new BodyFileError(
			`markdownFile '${path}' is unreadable: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
