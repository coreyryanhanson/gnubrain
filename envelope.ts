// §5 error envelope — one shared helper. Every tool result carries
// {status, message, ...payload}. `truncated`/`post_filtered` are payload
// markers, never statuses; success results (Sprint 3's read tools onward)
// carry `status: "ok"` plus their payload.

export type EnvelopeStatus =
	| "ok"
	| "near_matches"
	| "duplicate"
	| "error"
	| "refused";

export interface Envelope {
	status: EnvelopeStatus;
	message: string;
	[key: string]: unknown;
}

export function errorEnvelope(
	message: string,
	payload: Record<string, unknown> = {},
): Envelope {
	return { status: "error", message, ...payload };
}

export function refusedEnvelope(
	message: string,
	payload: Record<string, unknown> = {},
): Envelope {
	return { status: "refused", message, ...payload };
}

/** §5: reads while the kernel is unreachable — `{status: error, message: SiYuan unreachable at <baseUrl>}`. */
export function kernelUnreachable(baseUrl: string): Envelope {
	return errorEnvelope(`SiYuan unreachable at ${baseUrl}`);
}

/** §5 version refusal — static text naming the kernel version, the pinned
 * version, and the fix. The one message that fires on any upgrade. */
export function versionRefusalEnvelope(
	kernelVersion: string,
	pinnedVersion: string,
): Envelope {
	return refusedEnvelope(
		`SiYuan kernel version ${kernelVersion} does not match the pinned version ` +
			`${pinnedVersion}. Writes are refused. Run the upgrade checklist ` +
			`(DESIGN_v2.md §10) against the new kernel, re-pin ` +
			`PINNED_SIYUAN_VERSION, then start a new session.`,
	);
}

/** §5 429 cooldown refusal — names the lockout, its cause, its self-healing
 * expiry (quoting the served Retry-After), and pins the do-not-retry guidance. */
export function rateLimitRefusalEnvelope(
	cooldownUntil: number,
	retryAfterSeconds: number | undefined,
	now: number,
): Envelope {
	const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
	const expiry =
		`the lockout self-heals in ~${secondsLeft}s` +
		(retryAfterSeconds === undefined
			? ""
			: ` (kernel Retry-After: ${retryAfterSeconds}s)`);
	return refusedEnvelope(
		`SiYuan rate-limit lockout (HTTP 429): all kb calls are refused until ` +
			`${expiry}. The lock is keyed by client IP and may have been tripped by ` +
			`another client — your token is probably correct. Do not change the ` +
			`token or settings, and do not retry. Report the lockout to the user ` +
			`and pause kb work until the stated window passes. Wait out the lock ` +
			`first, then /kb.`,
	);
}

/** §5 breaker refusal — fail-fast, names the token fix and the /kb recovery. */
export function breakerRefusalEnvelope(): Envelope {
	return refusedEnvelope(
		`SiYuan auth circuit breaker tripped after 3 consecutive auth failures — ` +
			`all kb calls are refused locally with zero kernel calls. Fix the ` +
			`apiToken in the global settings file, then run /kb to re-validate.`,
	);
}

/** §5 degraded-config rejection — every tool call names the config problem. */
export function configRefusalEnvelope(errors: string[]): Envelope {
	return refusedEnvelope(`gnubrain settings are invalid: ${errors.join("; ")}`);
}
