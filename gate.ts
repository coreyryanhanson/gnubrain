// The single dispatch gate every kb tool call routes through.
// Order is pinned: shape → breaker → 429 cooldown → `kb` param — all local
// refusals with zero kernel calls. Only then does the kernel op run, and its
// errors classify in one place (auth feeds the breaker, 429 arms the cooldown,
// network drops never count). Reads never consult the cached probe verdict —
// each read attempts the kernel call; writes retry the probe per attempt.

import {
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
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
import type { KernelProbeClient, SessionValidation } from "./validation.js";
import { PINNED_SIYUAN_VERSION } from "./validation.js";

/** `query`/`search` take an array of names; every other tool exactly one. */
export type KbArity = "array" | "single";

/** Empty-scope wording — shared by the gate and the `kbs` discovery
 * form (kb_read), which reuses it verbatim for an empty active set. */
export const EMPTY_SCOPE_MESSAGE =
	"no KBs in scope — activate one with /kb <name> on, or set gnubrain.defaultKBs";

/** Readiness wording — shared by all four tool registrations so the
 * discovery-facing strings cannot drift between read and write tools. */
export const NOT_READY_VALIDATION =
	"kb tools are not ready — session validation has not run";
export const NOT_READY_KERNEL =
	"kb tools are not ready — settings did not load";

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

/**
 * Write-path gate: a successful probe must precede any write. Version
 * drift refuses statically; an unreachable kernel retries the probe per write
 * attempt — a still-failed retry refuses only that write. Returns null to
 * proceed. The probe does not fire `contact`: the breaker's reset-on-success
 * contract counts only authenticated calls, and getVersion is unauthenticated
 * — the op's own contact covers any write that actually reaches the kernel.
 * A probe that comes back 429/auth classifies like any kernel call: the 429
 * arms the local cooldown (retrying writes then refuse locally with zero
 * kernel calls — any call inside an active lock extends it), and the verdict
 * stays "unreachable" — the probe retries after the cooldown expires.
 */
export async function gateWriteAttempt(input: {
	validation: SessionValidation;
	kernel: KernelProbeClient;
	breaker: CircuitBreaker;
	now?: number;
}): Promise<Envelope | null> {
	const { validation, kernel } = input;
	// The effective pin rides the validation (runSessionValidation resolves
	// the per-test override); hand-built validations fall back to the constant.
	const pinnedVersion = validation.pinnedVersion ?? PINNED_SIYUAN_VERSION;
	if (validation.probe === "drift") {
		return versionRefusalEnvelope(
			validation.kernelVersion ?? "unknown",
			pinnedVersion,
		);
	}
	if (validation.probe === "ok") {
		return null;
	}
	// unreachable in production; defensive: per-write-attempt probe retry — never a
	// session-wide loop.
	try {
		const version = await kernel.getVersion();
		validation.kernelVersion = version;
		if (version !== pinnedVersion) {
			validation.probe = "drift";
			return versionRefusalEnvelope(version, pinnedVersion);
		}
		validation.probe = "ok";
		return null;
	} catch (err) {
		const classified = classifyKernelError(
			err,
			input.breaker,
			input.now ?? Date.now(),
		);
		if (classified !== null) return classified;
		validation.probe = "unreachable";
		return refusedEnvelope(`SiYuan unreachable at ${kernel.baseUrl}`);
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
			return kernelUnreachable(input.validation.settings?.baseUrl ?? "");
		}
		return errorEnvelope(err instanceof Error ? err.message : String(err));
	}
	// A call that actually reached the kernel resets the consecutive count —
	// but never the 429 cooldown, which self-heals on expiry alone.
	if (kernelContact) input.breaker.recordSuccess();
	// Reads warn and proceed on version drift: the result already
	// succeeded, so the drift rides the envelope as a payload field. Writes
	// are separately refused in gateWriteAttempt; the kbs discovery form
	// (tools.ts) makes zero kernel calls and skips this by design.
	if (
		result.status === "ok" &&
		input.validation.probe === "drift" &&
		input.validation.kernelVersion !== undefined
	) {
		result.drift = driftWarning(
			input.validation.kernelVersion,
			input.validation.pinnedVersion ?? PINNED_SIYUAN_VERSION,
		);
	}
	return result;
}
