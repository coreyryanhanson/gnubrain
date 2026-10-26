// error envelope — one shared helper. Every tool result carries
// {status, message, ...payload}. `truncated`/`postFiltered` are payload
// markers, never statuses; success results carry
// `status: "ok"` plus their payload.

import { AUTH_DODGE_THRESHOLD as BREAKER_THRESHOLD } from "siyuan-kernel-primitives";
import type { KernelCause } from "siyuan-kernel-primitives";

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

/** Exhaustive-switch tail: the never-typed parameter keeps a missed arm
 * a compile error when a primitives release widens a verdict union, and
 * the returned envelope is the shape the switch would have produced if
 * that guarantee ever broke at runtime. */
export function unreachable(_value: never, message: string): Envelope {
	return errorEnvelope(`internal: ${message}`);
}

/** Payload fields a partially-applied write must carry even when the
 * triggering error propagates for classification (429 → cooldown, auth →
 * breaker) or lands in finishWrite (network/timeout → verificationFailed).
 * Mid/post-mutation flows (replace-section's batched delete leg, and the
 * flows built on the same partial-apply plumbing) attach the state to the
 * error; the catch sites merge it into their classified envelope. The
 * agent-visible marker is not stored here — it is derived at render time
 * (partialApplyMarker). */
export interface PartialApplyState {
	/** The replacement block the flow's insert leg landed — absent for
	 * flows with no replacement (the delete flows' walk-failed rethrow). */
	newBlockId?: string;
	/** Ids a write touched whose application no complete post-write walk
	 * verified. Two shapes ride it: acked-but-unjudged (deletes acked or
	 * cascade-inferred, the post-write walk failed or truncated) and
	 * no-ack (a batched transact throw may be still committing or already
	 * committed — nothing is claimed applied, the whole judged set rides
	 * unconfirmed). Reconcile from the outline before treating them as
	 * settled. */
	unconfirmedBlockIds?: string[];
}

export function markPartialApply(err: unknown, state: PartialApplyState): void {
	if (typeof err === "object" && err !== null) {
		(err as Record<string, unknown>).partialApplyState = state;
	}
}

export function takePartialApply(err: unknown): PartialApplyState | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	return (err as { partialApplyState?: PartialApplyState }).partialApplyState;
}

/** The agent-visible marker a partial-apply state renders under: every
 * state that reaches the shared frame is applied-but-unverified — the
 * mutation phase is over or the batch may already be committed, and only
 * the judgment is missing. Wording that says "partially applied" over
 * such a state invites the retry the guidance forbids. Shared by every
 * render site (the flow verdict arms, finishWrite's mid-write frame, the
 * gate's withPartialState NOTE) so they cannot diverge. The terminal
 * cascade-consumed state is not part of this shape: `appliedConsumed` is
 * spread directly by the one flow that reaches it (replace-section's
 * delete-leg cascade-consumed arm) and never rendered through the shared
 * frame.
 *
 * Marker convention: `verificationFailed: true` rides the arms where
 * the mutation phase ended in a transport- or verification-phase
 * failure — the ladder's `transport-unverified` arm (the write call
 * itself failed at transport), the verification-failed arm (the
 * mutation acked, then the verification phase hit auth/429/drop),
 * finishWrite's rethrow, and the batched applied-but-unverified
 * envelope. The single-op judged-unconfirmed arms (block delete's
 * `absence-unconfirmed`, the insert/move `landing-unconfirmed`) carry
 * no marker — the mutation acked and the post-write walk ran to its
 * depth bound, so the verdict is a rendered judgment with its own walk
 * evidence. All of these mean the same thing: never re-run blind. */
export const partialApplyMarker = { appliedUnverified: true } as const;

/** The mid-write partial-apply guidance, shared by both render sites
 * (the gate's classified-envelope merge and finishWrite's verification
 * catch). The unconfirmed set rides the envelope beside it. */
export const PARTIAL_APPLY_GUIDANCE =
	"do NOT re-run the write; re-fetch the outline (kb_read) and reconcile from the payload's unconfirmed id set";

/** The prose half of the partial-apply render — the status phrase and
 * the landing-state clause; the render contract is the marker's
 * docblock above. */
export const PARTIAL_APPLY_STATUS = "applied but unverified";
export const PARTIAL_APPLY_TAIL = "nothing remains to apply";

/** The envelope marker carrying a verification-phase auth/lock event (401
 * or the kernel's per-IP 429) out of a write flow. The primitives classify
 * verification-phase auth errors into `verification-failed` instead of
 * rethrowing — the mutation already acked — so the breaker accounting
 * that runKbCall's catch otherwise performs rides the verdict envelope
 * under this key. Same role as `partialApplyState` above:
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

/** Unreachable-kernel envelope — the status differs by path (a failed
 * read is an error, a blocked write is a refusal). */
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
 * model actually reads, matching the truncated/postFiltered marker pattern. */
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

/** Shared recovery guidance for stale/foreign target refusals. */
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
			`PINNED_SIYUAN_VERSION in siyuan-kernel-primitives (its version.ts), ` +
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

/** A docId that does not resolve in the KB, shared by the read and write
 * paths. */
export function noSuchDocEnvelope(name: string, docId: string): Envelope {
	return errorEnvelope(
		`no doc '${docId}' in KB '${name}' — docIds come from kb_search rows (docId), kb_query rows (root_id), or kb_read/write results; an ID from another KB reads as nothing`,
	);
}
