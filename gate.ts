// The single dispatch gate every kb tool call routes through.
// Order is pinned: shape → breaker → 429 cooldown → `kb` param — all local
// refusals with zero kernel calls. Only then does the kernel op run, and its
// errors classify in one place (auth feeds the breaker, 429 arms the cooldown,
// network drops never count). Reads never consult the cached probe verdict —
// each read attempts the kernel call; writes retry the probe per attempt.

import {
	PINNED_SIYUAN_VERSION,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
	probeKernel,
	type KernelProbeClient,
	type KernelProbeResult,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "./breaker.js";
import {
	breakerRefusalEnvelope,
	configRefusalEnvelope,
	errorEnvelope,
	kernelUnreachable,
	rateLimitRefusalEnvelope,
	refusedEnvelope,
	takePartialReplace,
	versionRefusalEnvelope,
	driftWarning,
	type Envelope,
} from "./envelope.js";
import type { SessionValidation } from "./validation.js";

/** `query`/`search` take an array of names; every other tool exactly one. */
type KbArity = "array" | "single";

/** Empty-scope wording — shared by the gate and the `kbs` discovery
 * form (kb_read), which reuses it verbatim for an empty active set. */
export const EMPTY_SCOPE_MESSAGE =
	"no KBs in scope — activate one with /kb <name> on, or set gnubrain.defaultKBs";

/** Readiness wording — shared by all four tool registrations so the
 * discovery-facing strings cannot drift between read and write tools. */
export const NOT_READY_VALIDATION =
	"kb tools are not ready — session validation has not run";
const NOT_READY_KERNEL = "kb tools are not ready — settings did not load";

function activeList(validation: SessionValidation): string {
	return validation.scope.length > 0 ? validation.scope.join(", ") : "(none)";
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
		return `session validation was skipped while the kernel was rate-limited — run /kb to re-validate '${name}'`;
	}
	if (validation.validKBs.has(name)) return undefined;
	if (!validation.settings?.kbs.some((entry) => entry.name === name)) {
		return `unknown KB '${name}'. Active: ${activeList(validation)}`;
	}
	// Configured but dropped from the valid set (stale/encrypted).
	return `KB '${name}' is not available (stale or encrypted notebook — see the session warnings). Active: ${activeList(validation)}`;
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
	} else {
		// A one-element array still means "exactly one name" — unwrap it;
		// any other array is a shape error.
		if (Array.isArray(kb)) {
			if (kb.length === 1 && typeof kb[0] === "string") {
				kb = kb[0];
			} else {
				return {
					ok: false,
					message: "'kb' must be exactly one KB name for this call",
				};
			}
		}
		if (typeof kb !== "string") {
			return {
				ok: false,
				message: "'kb' must be exactly one KB name for this call",
			};
		}
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
	return { ok: true, names: requested };
}

type GateResult =
	| { ok: true; names: string[] }
	| { ok: false; envelope: Envelope };

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
	if (input.validation.shapeErrors.length > 0) {
		return {
			ok: false,
			envelope: configRefusalEnvelope(input.validation.shapeErrors),
		};
	}
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
 * cooldown (never counted toward the breaker). Returns null for any other
 * error — callers keep their own network/unknown envelopes.
 */
function classifyKernelError(
	err: unknown,
	breaker: CircuitBreaker,
	now: number,
): Envelope | null {
	if (err instanceof SiYuanAuthError) {
		breaker.recordAuthFailure();
		if (breaker.tripped) {
			return breakerRefusalEnvelope();
		}
		return errorEnvelope(
			`SiYuan auth rejected the request (HTTP ${err.status}) — check the apiToken in the global settings file`,
		);
	}
	if (err instanceof SiYuanRateLimitError) {
		breaker.recordRateLimit(err, now);
		return rateLimitRefusalEnvelope(
			breaker.cooldownUntil,
			err.retryAfterSeconds,
			now,
		);
	}
	return null;
}

/** The effective pin: rides the validation (runSessionValidation resolves
 * the per-test override); hand-built validations fall back to the constant. */
function effectivePin(validation: SessionValidation): string {
	return validation.pinnedVersion ?? PINNED_SIYUAN_VERSION;
}

/** The static (cached, kernel-free) half of the write-path version gate:
 * probe === "drift" refuses from session state alone, so it may run before
 * the grant dialog — a drifted session prompts never, for any KB, for as
 * long as the drift persists. One home for the pinned-version resolution:
 * the write entry calls this ahead of the dialog, and gateWriteAttempt
 * delegates to it first, so the two call sites cannot drift. The pin
 * itself resolves through effectivePin. */
export function staticDriftRefusal(
	validation: SessionValidation,
): Envelope | null {
	if (validation.probe.verdict !== "drift") return null;
	return versionRefusalEnvelope(
		validation.probe.kernelVersion,
		effectivePin(validation),
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
 * (the verdict to carry into the flow) on success. The probe does not fire
 * `contact`: the breaker's reset-on-success contract counts only
 * authenticated calls, and getVersion is unauthenticated — the op's own
 * contact covers any write that actually reaches the kernel. A probe that
 * comes back 429/auth classifies like any kernel call: the 429 arms the
 * local cooldown (retrying writes then refuse locally with zero kernel
 * calls — any call inside an active lock extends it), and the verdict stays
 * unreachable — the probe retries after the cooldown expires.
 */
export async function gateWriteAttempt(input: {
	validation: SessionValidation;
	kernel: KernelProbeClient;
	breaker: CircuitBreaker;
	now?: number;
}): Promise<WriteProbeGate> {
	const { validation, kernel } = input;
	const drift = staticDriftRefusal(validation);
	if (drift !== null) return { ok: false, envelope: drift };
	if (validation.probe.verdict === "ok") {
		return { ok: true, probe: validation.probe };
	}
	// unreachable in production; defensive: per-write-attempt probe retry — never a
	// session-wide loop. The probe rethrows on failure so classifyKernelError
	// sees the thrown object (429 → cooldown, auth → breaker); the comparison
	// lives in the pin-owning package, not re-encoded here.
	try {
		const fresh = await probeKernel(kernel, effectivePin(validation));
		validation.probe = fresh;
		// Exhaustive over both verdict arms: a new KernelProbeResult kind
		// added upstream must fail typecheck here — a fallthrough would
		// count it as writable.
		switch (fresh.verdict) {
			case "drift":
				return {
					ok: false,
					envelope: versionRefusalEnvelope(
						fresh.kernelVersion,
						effectivePin(validation),
					),
				};
			case "ok":
				return { ok: true, probe: fresh };
		}
		fresh satisfies never;
		throw new Error("internal: unhandled probe verdict");
	} catch (err) {
		const classified = classifyKernelError(
			err,
			input.breaker,
			input.now ?? Date.now(),
		);
		if (classified !== null) return { ok: false, envelope: classified };
		validation.probe = { verdict: "unreachable" };
		return {
			ok: false,
			envelope: kernelUnreachable(kernel.baseUrl, "refused"),
		};
	}
}

/** Merge a mid-sequence write's attached partial-apply state into a
 * classified envelope (429 → cooldown refusal, auth → breaker refusal).
 * The write may be half-applied — the model must see that even though the
 * error classified elsewhere, or the post-lock re-run duplicates it. */
function withPartialState(envelope: Envelope, err: unknown): Envelope {
	const partial = takePartialReplace(err);
	if (partial === undefined) return envelope;
	return {
		...envelope,
		message:
			`${envelope.message} NOTE: a kb_write was partially applied before this ` +
			`error — do not re-run it; reconcile from the payload ` +
			`(deletedBlockIds/remainingBlockIds) once kb calls resume`,
		...partial,
	};
}

/**
 * Guard + run + classify. Reads never check the probe verdict: the kernel
 * attempt happens and its failure maps to the error envelope, so reads
 * recover per-call with no recovery step once the kernel returns. The op
 * signals actual kernel contact via `contact` — op-internal refusals (shape,
 * missing docId) made zero kernel calls and must not reset the breaker's
 * consecutive-auth-failure count.
 */
export async function runKbCall(
	input: {
		validation: SessionValidation;
		breaker: CircuitBreaker;
		kb: unknown;
		arity: KbArity;
		now?: number;
	},
	op: (names: string[], contact: () => void) => Promise<Envelope>,
): Promise<Envelope> {
	const gate = guardCall(input);
	if (!gate.ok) return gate.envelope;

	let kernelContact = false;
	const contact = (): void => {
		kernelContact = true;
	};
	let result: Envelope;
	try {
		result = await op(gate.names, contact);
	} catch (err) {
		const now = input.now ?? Date.now();
		const classified = classifyKernelError(err, input.breaker, now);
		if (classified !== null) return withPartialState(classified, err);
		if (
			err instanceof SiYuanNetworkError ||
			err instanceof SiYuanTimeoutError
		) {
			return kernelUnreachable(
				input.validation.settings?.baseUrl ?? "",
				"error",
			);
		}
		return errorEnvelope(err instanceof Error ? err.message : String(err));
	}
	// A call that actually reached the kernel resets the consecutive count —
	// but never the 429 cooldown, which self-heals on expiry alone. This
	// includes a malformed result: the transport succeeded, so contact is real.
	if (kernelContact) input.breaker.recordSuccess();
	// An op that resolves to a non-envelope (a flow's union discrimination
	// letting a `null` transport result through) must render as an error
	// envelope, never a TypeError out of execute.
	if (result === null || typeof result !== "object") {
		return errorEnvelope("internal: kb op returned no envelope");
	}
	// Reads warn and proceed on version drift: the result already
	// succeeded, so the drift rides the envelope as a payload field. Writes
	// are separately refused in gateWriteAttempt; the kbs discovery form
	// (tools.ts) makes zero kernel calls and skips this by design.
	if (result.status === "ok" && input.validation.probe.verdict === "drift") {
		result.drift = driftWarning(
			input.validation.probe.kernelVersion,
			effectivePin(input.validation),
		);
	}
	return result;
}

/** Tool-level dispatch shared by the kb tool registrations: the two "not
 * ready" refusals and the runKbCall invocation live here instead of one
 * copy per tool. The missing-kernel check stays inside the gated op —
 * hoisting it above runKbCall would report a missing kernel before a
 * tripped breaker/cooldown, reordering the pinned gate. kb_read's `kb:
 * "kbs"` discovery form deliberately bypasses this helper (it must run
 * while the breaker is tripped); see tools.ts. */
export async function runGatedTool<K>(
	hooks: {
		getValidation(): SessionValidation | undefined;
		getKernel(): K | undefined;
		breaker: CircuitBreaker;
	},
	kb: unknown,
	arity: KbArity,
	op: (
		kernel: K,
		validation: SessionValidation,
		names: string[],
		contact: () => void,
	) => Promise<Envelope> | Envelope,
): Promise<Envelope> {
	const validation = hooks.getValidation();
	if (validation === undefined) {
		return errorEnvelope(NOT_READY_VALIDATION);
	}
	const kernel = hooks.getKernel();
	return runKbCall(
		{ validation, breaker: hooks.breaker, kb, arity },
		async (names, contact) => {
			if (kernel === undefined) {
				return errorEnvelope(NOT_READY_KERNEL);
			}
			return op(kernel, validation, names, contact);
		},
	);
}
