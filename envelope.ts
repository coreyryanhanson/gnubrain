// error envelope — one shared helper. Every tool result carries
// {status, message, ...payload}. `truncated`/`post_filtered` are payload
// markers, never statuses; success results carry
// `status: "ok"` plus their payload.

import { AUTH_DODGE_THRESHOLD as BREAKER_THRESHOLD } from "siyuan-kb-primitives";
import type { KernelCause } from "siyuan-kb-primitives";

type EnvelopeStatus = "ok" | "near_matches" | "duplicate" | "error" | "refused";

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

/** Payload fields a partially-applied write must carry even when the
 * triggering error propagates for classification (429 → cooldown, auth →
 * breaker) or lands in finishWrite (network/timeout → verificationFailed).
 * Mid-sequence flows (replace-section's delete sweep) attach the state to
 * the error; the catch sites merge it into their classified envelope. */
interface PartialReplaceState {
	partialReplace: true;
	newBlockId: string;
	deletedBlockIds: string[];
	remainingBlockIds: string[];
}

export function markPartialReplace(
	err: unknown,
	state: PartialReplaceState,
): void {
	if (typeof err === "object" && err !== null) {
		(err as Record<string, unknown>).partialReplaceState = state;
	}
}

export function takePartialReplace(
	err: unknown,
): PartialReplaceState | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	return (err as { partialReplaceState?: PartialReplaceState })
		.partialReplaceState;
}

/** The mid-write partial-apply guidance — one wording home for both render
 * sites (the gate's classified-envelope merge and finishWrite's
 * verification catch), so the same half-applied write cannot render two
 * different do-not-re-run sentences. The payloads
 * (deletedBlockIds/remainingBlockIds) ride the envelope beside it. */
export const PARTIAL_APPLY_GUIDANCE =
	"do NOT re-run the write; re-fetch the outline (kb_read) and reconcile from the payload (deletedBlockIds/remainingBlockIds)";

/** The envelope marker carrying a verification-phase auth/lock event (401
 * or the kernel's per-IP 429) out of a write flow. The primitives classify
 * verification-phase auth errors into `verification-failed` instead of
 * rethrowing — the mutation already acked — so the breaker accounting
 * that runKbCall's catch otherwise performs rides the verdict envelope
 * under this key. Same role as `partialReplaceState` above:
 * structured state attached to a result, read by the gate, never worded
 * here. */
export type AuthLockEvent = Extract<
	KernelCause,
	{ kind: "auth" | "rate-limit" }
>;

export function authLockEventOf(result: unknown): AuthLockEvent | undefined {
	if (typeof result === "object" && result !== null && "authEvent" in result) {
		const event = (result as { authEvent: unknown }).authEvent;
		if (typeof event === "object" && event !== null) {
			const kind = (event as { kind?: unknown }).kind;
			if (kind === "auth" || kind === "rate-limit") {
				return event as AuthLockEvent;
			}
		}
	}
	return undefined;
}

/** Unreachable-kernel envelope — one home for the sentence; the status
 * differs by path (a failed read is an error, a blocked write is a
 * refusal). */
export function kernelUnreachable(
	baseUrl: string,
	status: "error" | "refused",
): Envelope {
	return {
		status,
		message:
			baseUrl === ""
				? "SiYuan unreachable"
				: `SiYuan unreachable at ${baseUrl}`,
	};
}

/** Read-path version-drift warning — reads warn and proceed: the op
 * already succeeded, so the drift rides the result as a payload field the
 * model actually reads, matching the truncated/post_filtered marker pattern. */
export function driftWarning(
	kernelVersion: string,
	pinnedVersion: string,
): string {
	return (
		`kernel version ${kernelVersion} does not match the pinned version ` +
		`${pinnedVersion} — results may not match pinned-kernel behavior, and ` +
		`writes are refused until the kernel is re-verified and re-pinned`
	);
}

/** Shared recovery guidance for stale/foreign target refusals — one home
 * so the re-target instruction cannot drift between the flows that word
 * it. */
export const STALE_TARGET_GUIDANCE =
	"stale or foreign target; re-fetch the outline (kb_read) and re-target";

/** version refusal — static text naming the kernel version, the pinned
 * version, and the fix. The one message that fires on any upgrade. */
export function versionRefusalEnvelope(
	kernelVersion: string,
	pinnedVersion: string,
): Envelope {
	return refusedEnvelope(
		`SiYuan kernel version ${kernelVersion} does not match the pinned version ` +
			`${pinnedVersion}. Writes are refused. Verify the new kernel against ` +
			`the integration checklist, re-pin ` +
			`PINNED_SIYUAN_VERSION in siyuan-kb-primitives (its version.ts), ` +
			`then start a new session.`,
	);
}

/** 429 cooldown refusal — names the lockout, its cause, its self-healing
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

/** Tool result wrapper — pretty-printed envelope as text content plus the
 * structured details (the shape every tool result rides). */
export function textResult(envelope: Envelope): {
	content: { type: "text"; text: string }[];
	details: Envelope;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
		details: envelope,
	};
}

/** breaker refusal — fail-fast, names the token fix and the /kb recovery. */
export function breakerRefusalEnvelope(): Envelope {
	return refusedEnvelope(
		`SiYuan auth circuit breaker tripped after ${BREAKER_THRESHOLD} consecutive auth failures — ` +
			`all kb calls are refused locally with zero kernel calls. Fix the ` +
			`apiToken in the global settings file, then run /kb to re-validate.`,
	);
}

/** degraded-config rejection — every tool call names the config problem. */
export function configRefusalEnvelope(errors: string[]): Envelope {
	return refusedEnvelope(`gnubrain settings are invalid: ${errors.join("; ")}`);
}

/** A docId that does not resolve in the KB — shared by the read and write
 * paths so the discovery hint cannot drift between them. */
export function noSuchDocEnvelope(name: string, docId: string): Envelope {
	return errorEnvelope(
		`no doc '${docId}' in KB '${name}' — docIds come from kb_search rows (docId), kb_query rows (root_id), or kb_read/write results; an ID from another KB reads as nothing`,
	);
}
