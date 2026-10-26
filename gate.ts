// The single dispatch gate every kb tool call routes through.
// Order is pinned: shape → breaker → 429 cooldown → `kb` param — all local
// refusals with zero kernel calls. Only then does the kernel op run, and its
// errors classify in one place (auth feeds the breaker, 429 arms the cooldown,
// network drops never count). Reads never consult the cached probe verdict —
// each read attempts the kernel call; writes retry the probe per attempt.
// The KB-scope vocabulary the gate shares with the tool registrations, the
// status slot, and the /kb command lives in kbScope.ts.

import {
	PINNED_SIYUAN_VERSION,
	causeOf,
	probeKernel,
	type KernelCause,
	type KernelProbeResult,
} from "siyuan-kernel-primitives";
import { CircuitBreaker } from "./breaker.js";
import { trackKernel } from "./kernelContact.js";
import {
	authLockEventOf,
	breakerRefusalEnvelope,
	configRefusalEnvelope,
	errorEnvelope,
	kernelUnreachable,
	rateLimitRefusalEnvelope,
	refusedEnvelope,
	partialApplyMarker,
	takePartialApply,
	versionRefusalEnvelope,
	driftWarning,
	PARTIAL_APPLY_GUIDANCE,
	PARTIAL_APPLY_STATUS,
	type Envelope,
} from "./envelope.js";
import type { ContentBaselines } from "./baselines.js";
import type { SessionValidation } from "./validation.js";
import {
	NOT_READY_VALIDATION,
	resolveKbParam,
	type KbArity,
} from "./kbScope.js";

const NOT_READY_KERNEL = "kb tools are not ready — settings did not load";

type GateResult =
	| { ok: true; names: string[] }
	| { ok: false; envelope: Envelope };

/** The kernel-free shape refusal, shared by guardCall's first leg and the
 * `kb: "kbs"` discovery short-circuit (tools.ts), so the two checks cannot
 * drift. Null when the session shape is clean. */
export function shapeRefusal(validation: SessionValidation): Envelope | null {
	if (validation.shapeErrors.length === 0) return null;
	return configRefusalEnvelope(validation.shapeErrors);
}

/** The session-state hooks every kb tool registration receives: closures
 * over session-start state, so masking and post-toggle scope compose
 * mid-session. The write registrar extends this with its grant state and
 * body-file seam (WriteToolHooks). */
export interface SessionHooks<K extends object> {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): K | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped fresh-content baselines — read tools seed it where
	 * content is served to the agent, so the map holds exactly what the
	 * tool last served; the write precondition re-checks against it. */
	baselines: ContentBaselines;
}

/**
 * The dispatch point every kb tool call routes through: local refusals
 * first — shape, breaker, cooldown, `kb` param — each with zero kernel calls.
 * Passes on success for the kernel op (reads call; writes first pass
 * `gateWriteAttempt`).
 */
export function guardCall(input: {
	validation: SessionValidation;
	breaker: CircuitBreaker;
	kb: unknown;
	arity: KbArity;
	now?: number;
}): GateResult {
	const shape = shapeRefusal(input.validation);
	if (shape !== null) return { ok: false, envelope: shape };
	if (input.breaker.tripped) {
		return { ok: false, envelope: breakerRefusalEnvelope() };
	}
	if (input.breaker.inCooldown(input.now)) {
		return {
			ok: false,
			envelope: rateLimitRefusalEnvelope(
				input.breaker.cooldownUntil,
				input.breaker.lastRetryAfterSeconds,
				input.now ?? Date.now(),
			),
		};
	}
	const resolved = resolveKbParam(input.kb, input.arity, input.validation);
	if (!resolved.ok) {
		return { ok: false, envelope: refusedEnvelope(resolved.message) };
	}
	return { ok: true, names: resolved.names };
}

/**
 * Breaker-mutating error legs shared by the read dispatch and the write
 * probe: auth feeds the consecutive-failure count, 429 arms the local
 * cooldown (never counted toward the breaker). The layer-1 classification
 * itself lives down-repo (`causeOf`); this site keeps only the session
 * policy. Returns null for transport/kernel causes — callers keep their
 * own network/unknown envelopes.
 */
function classifyKernelError(
	cause: KernelCause,
	breaker: CircuitBreaker,
	now: number,
): Envelope | null {
	switch (cause.kind) {
		case "auth": {
			breaker.recordAuthFailure();
			if (breaker.tripped) {
				return breakerRefusalEnvelope();
			}
			return errorEnvelope(
				`SiYuan auth rejected the request (HTTP ${cause.status}) — check the apiToken in the global settings file`,
			);
		}
		case "rate-limit":
			breaker.recordRateLimitFromVerdict(cause.retryAfterSeconds, now);
			return rateLimitRefusalEnvelope(
				breaker.cooldownUntil,
				cause.retryAfterSeconds,
				now,
			);
		case "transport":
		case "kernel":
			return null;
	}
	cause satisfies never;
	return null;
}

/** The static (cached, kernel-free) half of the write-path version gate:
 * probe === "drift" refuses from session state alone, so it may run before
 * the grant dialog — a drifted session prompts never, for any KB, for as
 * long as the drift persists. The write entry calls this ahead of the
 * dialog, and gateWriteAttempt delegates to it first, so the two call
 * sites cannot drift. The pin itself is the primitives' module constant —
 * probeKernel judges against it, so the wording names the same pin the
 * verdict was judged against. */
export function staticDriftRefusal(
	validation: SessionValidation,
): Envelope | null {
	if (validation.probe.verdict !== "drift") return null;
	return versionRefusalEnvelope(
		validation.probe.kernelVersion,
		PINNED_SIYUAN_VERSION,
	);
}

/** Result of the write-path probe gate: either the envelope that refuses
 * this write, or the verdict to stamp into the flow input — the cached-ok
 * verdict on the cached path, the fresh re-probe result on the retry path
 * (so prepareWrite's caller stamps exactly what the gate verified). */
type WriteProbeGate =
	| { ok: true; probe: KernelProbeResult }
	| { ok: false; envelope: Envelope };

/**
 * Write-path gate: a successful probe must precede any write. Version
 * drift refuses statically; an unreachable kernel retries the probe per write
 * attempt — a still-failed retry refuses only that write. Returns the stamp
 * (the verdict to carry into the flow) on success. The probe marks no
 * kernel contact: the breaker's reset-on-success contract counts only
 * authenticated calls, and the probe runs on the raw client the gate
 * hands the op alongside the tracked one — the trap never sees it —
 * while any write that actually reaches the kernel marks contact
 * through that same tracked client. A probe that
 * comes back 429/auth classifies like any kernel call: the 429 arms the
 * local cooldown (retrying writes then refuse locally with zero kernel
 * calls — any call inside an active lock extends it), and the verdict stays
 * unreachable — the probe retries after the cooldown expires.
 */
export async function gateWriteAttempt(input: {
	validation: SessionValidation;
	kernel: ProbeHandle;
	breaker: CircuitBreaker;
	now?: number;
}): Promise<WriteProbeGate> {
	const { validation, kernel } = input;
	const drift = staticDriftRefusal(validation);
	if (drift !== null) return { ok: false, envelope: drift };
	if (validation.probe.verdict === "ok") {
		return { ok: true, probe: validation.probe };
	}
	// The cached verdict was unreachable or never-probed: retry the probe here,
	// per write attempt — never a session-wide loop. The probe rethrows on
	// failure so classifyKernelError sees the thrown object (429 → cooldown,
	// auth → breaker); the comparison lives in the pin-owning package, not
	// re-encoded here.
	let fresh: KernelProbeResult;
	try {
		fresh = await probeKernel(kernel);
	} catch (err) {
		const cause = causeOf(err);
		const classified =
			cause !== undefined
				? classifyKernelError(cause, input.breaker, input.now ?? Date.now())
				: null;
		if (classified !== null) return { ok: false, envelope: classified };
		validation.probe = { verdict: "unreachable" };
		return {
			ok: false,
			envelope: kernelUnreachable(kernel.baseUrl, "refused"),
		};
	}
	validation.probe = fresh;
	// Exhaustive over both verdict arms: a new KernelProbeResult kind
	// added upstream must fail typecheck here — a fallthrough would
	// count it as writable. Outside the catch above so an internal
	// failure here cannot render as "unreachable" (nor poison the
	// cached verdict).
	switch (fresh.verdict) {
		case "drift":
			return {
				ok: false,
				envelope: versionRefusalEnvelope(
					fresh.kernelVersion,
					PINNED_SIYUAN_VERSION,
				),
			};
		case "ok":
			return { ok: true, probe: fresh };
	}
	fresh satisfies never;
	throw new Error("internal: unhandled probe verdict");
}

/** Merge a mid-sequence write's attached partial-apply state into a
 * classified envelope (429 → cooldown refusal, auth → breaker refusal).
 * The write is applied-but-unverified — the model must see that even
 * though the error classified elsewhere, or the post-lock re-run
 * duplicates it. Every
 * catch arm of runKbCall renders through this: the attached state exists
 * only for mid/post-mutation errors (the mark sites sit inside
 * finishWrite), but the gate upholds the render invariant itself rather
 * than per arm. The merged envelope keeps its own status — a 429 refusal
 * stays `refused`, an unreachable transport stays `error` — only the
 * message gains the do-not-re-run NOTE and the payload the receipt rides
 * in. */
function withPartialState(envelope: Envelope, err: unknown): Envelope {
	const partial = takePartialApply(err);
	if (partial === undefined) return envelope;
	return {
		...envelope,
		message:
			`${envelope.message} NOTE: a kb_write was ${PARTIAL_APPLY_STATUS} before this ` +
			`error — ${PARTIAL_APPLY_GUIDANCE} once kb calls resume`,
		...partial,
		...partialApplyMarker,
	};
}

/**
 * Guard + run + classify. Reads never check the probe verdict: the kernel
 * attempt happens and its failure maps to the error envelope, so reads
 * recover per-call with no recovery step once the kernel returns. The op
 * runs against a tracked client: kernel contact is observed structurally
 * (any method invocation — the trap lives in kernelContact.ts), so
 * op-internal refusals that make zero kernel calls (shape, missing docId)
 * cannot reset the breaker's consecutive-auth-failure count.
 */
export async function runKbCall<K extends object>(
	input: {
		validation: SessionValidation;
		breaker: CircuitBreaker;
		/** The op's client — absent when the session built no kernel. Ops
		 * receive the tracked wrapper (or undefined) and own the
		 * missing-kernel refusal inside the gated op. */
		kernel?: K | undefined;
		kb: unknown;
		arity: KbArity;
		now?: number;
	},
	op: (names: string[], kernel: K | undefined) => Promise<Envelope> | Envelope,
): Promise<Envelope> {
	const gate = guardCall(input);
	if (!gate.ok) return gate.envelope;

	let kernelContact = false;
	const tracked =
		input.kernel === undefined
			? undefined
			: trackKernel(input.kernel, () => {
					kernelContact = true;
				});
	let result: Envelope;
	try {
		result = await op(gate.names, tracked);
	} catch (err) {
		const now = input.now ?? Date.now();
		const cause = causeOf(err);
		const classified =
			cause !== undefined
				? classifyKernelError(cause, input.breaker, now)
				: null;
		if (classified !== null) return withPartialState(classified, err);
		if (cause?.kind === "transport") {
			return withPartialState(
				kernelUnreachable(input.validation.settings?.baseUrl ?? "", "error"),
				err,
			);
		}
		// A kernel-cause throw always rode a real call (the kernel answered,
		// without an auth event); an unclassified throw resets only if the
		// tracked client was actually invoked. Either way the consecutive
		// count resets like the success path. The transport arm above stays
		// reset-free: the response never arrived.
		if (kernelContact) input.breaker.recordSuccess();
		return withPartialState(
			errorEnvelope(err instanceof Error ? err.message : String(err)),
			err,
		);
	}
	// A call that actually reached the kernel resets the consecutive count —
	// but never the 429 cooldown, which self-heals on expiry alone. This
	// includes a malformed result: the transport succeeded, so contact is real.
	// Exception: a verification-phase auth/lock verdict (the primitives
	// classify those instead of rethrowing — the mutation already acked, so
	// the marker accounts for the event here). The kernel's per-IP FailCount
	// advanced behind this op's transport success, so the event is counted
	// and reset-on-success is skipped — resetting would let the next write
	// pass a gate the kernel is actively refusing.
	const now = input.now ?? Date.now();
	const authEvent = authLockEventOf(result);
	if (authEvent?.kind === "auth") {
		input.breaker.recordAuthFailure();
	} else if (authEvent?.kind === "rate-limit") {
		input.breaker.recordRateLimitFromVerdict(authEvent.retryAfterSeconds, now);
	} else if (kernelContact) {
		input.breaker.recordSuccess();
	}
	// An op that resolves to a non-envelope (a flow's union discrimination
	// letting a `null` transport result through) must render as an error
	// envelope, never a TypeError out of execute.
	if (result === null || typeof result !== "object") {
		return errorEnvelope("internal: kb op returned no envelope");
	}
	// Reads warn and proceed on version drift: the result already
	// succeeded, so the drift rides the envelope as a payload field. Writes
	// are separately refused in gateWriteAttempt; the kbs discovery form
	// (tools.ts) makes zero kernel calls and skips this by design. Drift
	// attaches to a fully-ok result only — the other read statuses carry
	// their own refusal/near-match wording.
	if (result.status === "ok" && input.validation.probe.verdict === "drift") {
		result.drift = driftWarning(
			input.validation.probe.kernelVersion,
			PINNED_SIYUAN_VERSION,
		);
	}
	return result;
}

/** The probe handle's surface: the two unauthenticated reads the probe
 * gate makes. Deliberately narrower than the primitives'
 * `KernelProbeClient`, whose `listNotebooks` is an authenticated route a
 * call through the raw handle must not be able to typecheck — it would
 * bypass contact marking entirely. */
export interface ProbeHandle {
	readonly baseUrl: string;
	getVersion(): Promise<string>;
}

/** The gate's served client narrowed to the probe surface: a real kernel
 * call through the raw probe handle fails typecheck — it would bypass
 * contact marking entirely. `Extract` keeps this structural for every K
 * the gate serves: read clients carry no probe methods and narrow to
 * `{}`; write clients expose only the unauthenticated origin + version
 * reads, hiding the authenticated surface. */
type ProbeSurface<K extends object> = Pick<
	K,
	Extract<keyof K, keyof ProbeHandle>
>;

/** Tool-level dispatch shared by the kb tool registrations: the two "not
 * ready" refusals and the runKbCall invocation live here instead of one
 * copy per tool. The missing-kernel check stays inside the gated op —
 * hoisting it above runKbCall would report a missing kernel before a
 * tripped breaker/cooldown, reordering the pinned gate. kb_read's `kb:
 * "kbs"` discovery form deliberately bypasses this helper (it must run
 * while the breaker is tripped); see tools.ts. */
export async function runGatedTool<K extends object>(
	hooks: SessionHooks<K>,
	kb: unknown,
	arity: KbArity,
	op: (
		kernel: K,
		validation: SessionValidation,
		names: string[],
		/** The raw (untracked) client, narrowed by `ProbeSurface` —
		 * probe-class calls only. */
		probe: ProbeSurface<K>,
	) => Promise<Envelope> | Envelope,
): Promise<Envelope> {
	const validation = hooks.getValidation();
	if (validation === undefined) {
		return errorEnvelope(NOT_READY_VALIDATION);
	}
	const kernel = hooks.getKernel();
	return runKbCall(
		{ validation, breaker: hooks.breaker, kernel, kb, arity },
		async (names, tracked) => {
			// tracked is built from kernel inside runKbCall, so the two are
			// defined together — one check narrows both.
			if (tracked === undefined || kernel === undefined) {
				return errorEnvelope(NOT_READY_KERNEL);
			}
			return op(tracked, validation, names, kernel);
		},
	);
}
