import { describe, expect, it, vi } from "vitest";
import {
	AUTH_DODGE_THRESHOLD,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
	PINNED_SIYUAN_VERSION,
	type NotebookList,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { errorEnvelope, type Envelope } from "../../envelope.js";
import { gateWriteAttempt, guardCall, runKbCall } from "../../gate.js";
import { resolveKbParam } from "../../kbScope.js";
import { validation } from "./fixtures.js";

const NOW = 1_000_000_000;

function kernelStub(
	getVersion: () => Promise<string> = async () => PINNED_SIYUAN_VERSION,
) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			baseUrl: "http://127.0.0.1:6806",
			async getVersion() {
				calls.push("getVersion");
				return getVersion();
			},
			async listNotebooks() {
				calls.push("listNotebooks");
				throw new Error("not used");
			},
			async query() {
				calls.push("query");
				return [];
			},
		},
	};
}

/** Narrow a gate result to its refusal arm: asserts and narrows in one
 * step, so each case needs no repeated `!== undefined && !ok` ladder. */
function expectRefusal(
	gate: { ok: true; probe: unknown } | { ok: false; envelope: Envelope },
	why = "refusal",
): { ok: false; envelope: Envelope } {
	expect(gate.ok).toBe(false);
	if (gate.ok) throw new Error(`expected ${why}`);
	return gate;
}

// Mirrors SiYuanKernelClient's shape: getVersion is a prototype method that
// reaches the transport through another method via `this`. A this-free stub
// cannot falsify the probe-contact contract — the tracked client's exclusion
// works by binding, and only a member-calling getVersion exercises it.
class ProbeShapeKernel {
	readonly baseUrl = "http://127.0.0.1:6806";
	async getVersion(): Promise<string> {
		return this.request("/api/system/version");
	}
	async request(_path: string): Promise<string> {
		return PINNED_SIYUAN_VERSION;
	}
	async listNotebooks(): Promise<NotebookList> {
		return { notebooks: [] };
	}
}

describe("kb param contract", () => {
	const v = validation();

	it("a rate-limit-skipped validation refuses with the skip named, not stale-or-encrypted", () => {
		// rateLimitedValidation shape: settings parsed, empty valid set, the
		// skip flag set — the refusal must not misreport the KB as stale.
		const skipped = validation({
			validKBs: [],
			scope: [],
		});
		skipped.skippedDueToRateLimit = true;
		const r = resolveKbParam("recipes", "single", skipped);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("validation was skipped");
			expect(r.message).not.toContain("stale or encrypted");
		}
		// Without the flag the same shape still refuses, with the stale branch.
		const plain = validation({ validKBs: [], scope: [] });
		const stale = resolveKbParam("recipes", "single", plain);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.message).toContain("stale or encrypted");
	});

	it("requires the kb param", () => {
		const result = resolveKbParam(undefined, "single", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain(
			"'kb' parameter is required",
		);
	});

	it("rejects an empty array locally (the empty-scope message, no kernel call)", () => {
		const result = resolveKbParam([], "array", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"no KBs in scope — activate one with /kb <name> on, or set gnubrain.defaultKBs",
		);
	});

	it("rejects an unknown KB naming the active set", () => {
		const result = resolveKbParam(["recipies"], "array", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"unknown KB 'recipies'. Active: recipes",
		);
	});

	it("rejects a valid KB outside the active scope, naming the activation paths", () => {
		const result = resolveKbParam("projects", "single", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"'projects' exists but is not in the active scope — activate it with /kb, or change gnubrain.defaultKBs in settings",
		);
	});

	it("rejects a configured-but-invalid KB (stale/encrypted)", () => {
		const v2 = validation({ validKBs: [["recipes", "nb-r"]] });
		const result = resolveKbParam("projects", "single", v2);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toContain("stale or encrypted");
	});

	it("resolves multi-KB sweeps and single names", () => {
		const v2 = validation({ scope: ["recipes", "projects"] });
		expect(resolveKbParam(["recipes", "projects"], "array", v2)).toEqual({
			ok: true,
			names: ["recipes", "projects"],
		});
		expect(resolveKbParam("recipes", "single", v2)).toEqual({
			ok: true,
			names: ["recipes"],
		});
	});

	it("dedupes repeated names (the search fan-out runs one kernel call per name)", () => {
		const v2 = validation({ scope: ["recipes"] });
		expect(resolveKbParam(["recipes", "recipes"], "array", v2)).toEqual({
			ok: true,
			names: ["recipes"],
		});
	});

	it("rejects a non-string 'kb' on single-name calls (the schema is the contract; this guard is the backstop)", () => {
		const message = "'kb' must be exactly one KB name for this call";
		expect(resolveKbParam(["a", "b"], "single", v)).toEqual({
			ok: false,
			message,
		});
		expect(resolveKbParam(["a"], "single", v)).toEqual({
			ok: false,
			message,
		});
		expect(resolveKbParam(42, "single", v)).toEqual({
			ok: false,
			message,
		});
	});
});

describe("guardCall dispatch gate", () => {
	it("a degraded (shape-failed) session rejects every call with the problem named", () => {
		const result = guardCall({
			validation: validation({
				shapeErrors: ["kbs is required and must be an array"],
			}),
			breaker: new CircuitBreaker(),
			kb: "recipes",
			arity: "single",
			now: NOW,
		});
		expect(result.ok).toBe(false);
		expect(!result.ok && result.envelope.status).toBe("refused");
		expect(!result.ok && result.envelope.message).toContain("kbs is required");
	});

	it("a tripped breaker refuses locally before any kernel call", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		const result = guardCall({
			validation: validation(),
			breaker,
			kb: "recipes",
			arity: "single",
			now: NOW,
		});
		expect(!result.ok && result.envelope.status).toBe("refused");
		expect(!result.ok && result.envelope.message).toContain("circuit breaker");
	});

	it("an active 429 cooldown refuses locally with zero kernel round-trips", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 90), NOW);
		const result = guardCall({
			validation: validation(),
			breaker,
			kb: "recipes",
			arity: "single",
			now: NOW + 1000,
		});
		expect(!result.ok && result.envelope.status).toBe("refused");
		expect(!result.ok && result.envelope.message).toContain(
			"rate-limit lockout",
		);
	});

	it("post-expiry the gate passes", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 60), NOW);
		const result = guardCall({
			validation: validation(),
			breaker,
			kb: "recipes",
			arity: "single",
			now: NOW + 60_000,
		});
		expect(result.ok).toBe(true);
	});
});

describe("runKbCall version-drift warning", () => {
	it("read results carry the drift warning when the probe verdict is drift", async () => {
		const v = validation({
			probe: { verdict: "drift", kernelVersion: "3.8.5" },
		});
		const envelope = await runKbCall(
			{
				validation: v,
				breaker: new CircuitBreaker(),
				kernel: kernelStub().client,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (_names, kernel) => {
				await kernel?.query();
				return { status: "ok", message: "2 rows" };
			},
		);
		// Reads warn and proceed: the result stays ok, the drift rides the
		// envelope naming both versions and the write refusal.
		expect(envelope.status).toBe("ok");
		expect(envelope.drift).toContain("3.8.5");
		expect(envelope.drift).toContain(PINNED_SIYUAN_VERSION);
		expect(envelope.drift).toContain("writes are refused");
	});

	it("no drift field on a probe-ok session, and gateWriteAttempt still refuses writes statically", async () => {
		const breaker = new CircuitBreaker();
		const ok = await runKbCall(
			{
				validation: validation(),
				breaker,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async () => ({ status: "ok", message: "" }),
		);
		expect(ok.drift).toBeUndefined();

		const drifted = validation({
			probe: { verdict: "drift", kernelVersion: "3.8.5" },
		});
		const refusal = expectRefusal(
			await gateWriteAttempt({
				validation: drifted,
				kernel: kernelStub(async () => "3.8.5").client,
				breaker,
				now: NOW,
			}),
		);
		expect(refusal.envelope.message).toContain("3.8.5");
	});
});

describe("runKbCall non-envelope op results", () => {
	it("renders a null op result as an error envelope instead of throwing", async () => {
		const envelope = await runKbCall(
			{
				validation: validation(),
				breaker: new CircuitBreaker(),
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			// A flow's union discrimination can hand a `null` transport result
			// back typed as an Envelope — the gate must render it, not throw.
			async () => null as unknown as import("../../envelope.js").Envelope,
		);
		expect(envelope.status).toBe("error");
		expect(envelope.message).toContain("no envelope");
	});
});

describe("runKbCall error classification", () => {
	it("feeds the breaker on auth failures and refuses locally once tripped", async () => {
		const breaker = new CircuitBreaker();
		const v = validation();
		const call = () =>
			runKbCall(
				{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
				async () => {
					throw new SiYuanAuthError(401);
				},
			);
		await call();
		await call();
		const third = await call();
		expect(third.status).toBe("refused");
		expect(third.message).toContain("circuit breaker");
		// Zero further kernel calls from tool calls: the op below must never run.
		let kernelCalls = 0;
		const refused = await runKbCall(
			{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
			async () => {
				kernelCalls++;
				throw new Error("must not be reached");
			},
		);
		expect(refused.status).toBe("refused");
		expect(kernelCalls).toBe(0);
	});

	it("429 with a genuine SiYuanRateLimitError: no breaker increment, no retry, pinned refusal content", async () => {
		const breaker = new CircuitBreaker();
		const err = new SiYuanRateLimitError(429, 120);
		const envelope = await runKbCall(
			{
				validation: validation(),
				breaker,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async () => {
				throw err;
			},
		);
		expect(envelope.status).toBe("refused");
		// Lockout, cause, self-healing expiry quoting the served Retry-After.
		expect(envelope.message).toContain("HTTP 429");
		expect(envelope.message).toContain("keyed by client IP");
		expect(envelope.message).toContain("Retry-After: 120s");
		// Do-not-change-token / do-not-retry guidance, and the wait-then-/kb rule.
		expect(envelope.message).toContain("Do not change the token or settings");
		expect(envelope.message).toContain("do not retry");
		expect(envelope.message).toContain("Wait out the lock first, then /kb");
		// The breaker was not fed by the 429.
		expect(breaker.tripped).toBe(false);
		// The next call inside the cooldown is refused locally — the op never runs.
		let kernelCalls = 0;
		const refused = await runKbCall(
			{
				validation: validation(),
				breaker,
				kb: "recipes",
				arity: "single",
				now: NOW + 1000,
			},
			async () => {
				kernelCalls++;
				return { status: "ok", message: "" };
			},
		);
		expect(refused.status).toBe("refused");
		expect(kernelCalls).toBe(0);
		// Post-expiry the call simply succeeds, with no recovery step.
		const after = await runKbCall(
			{
				validation: validation(),
				breaker,
				kb: "recipes",
				arity: "single",
				now: NOW + 120_000,
			},
			async () => {
				kernelCalls++;
				return { status: "ok", message: "fine" };
			},
		);
		expect(after.status).toBe("ok");
		expect(kernelCalls).toBe(1);
	});

	it("a successful authenticated call resets the consecutive count", async () => {
		const breaker = new CircuitBreaker();
		const v = validation();
		let fail = true;
		const envelope = await runKbCall(
			{
				validation: v,
				breaker,
				kernel: kernelStub().client,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (_names, kernel) => {
				if (fail) throw new SiYuanAuthError(403);
				await kernel?.query();
				return { status: "ok", message: "" };
			},
		);
		expect(envelope.status).toBe("error");
		fail = false;
		await runKbCall(
			{
				validation: v,
				breaker,
				kernel: kernelStub().client,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (_names, kernel) => {
				await kernel?.query();
				return { status: "ok", message: "" };
			},
		);
		fail = true;
		await runKbCall(
			{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
			async () => {
				throw new SiYuanAuthError(403);
			},
		);
		// 2 fail → success → 1 fail: not tripped.
		expect(breaker.tripped).toBe(false);
	});

	it("an op-internal refusal that never touched the kernel does not reset the consecutive count", async () => {
		const breaker = new CircuitBreaker();
		const v = validation();
		const authFail = () =>
			runKbCall(
				{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
				async () => {
					throw new SiYuanAuthError(403);
				},
			);
		await authFail();
		await authFail();
		// A kernel-free refusal (e.g. kb_read's missing-docId) sits between
		// auth failures: the "3 consecutive" property must survive it.
		const refused = await runKbCall(
			{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
			async () => ({ status: "refused", message: "docId is required" }),
		);
		expect(refused.status).toBe("refused");
		const third = await authFail();
		expect(third.status).toBe("refused");
		expect(third.message).toContain("circuit breaker");
		expect(breaker.tripped).toBe(true);
	});

	// Network drop vs timeout — both mean the response never arrived, so
	// both map to the unreachable envelope and neither counts toward the
	// breaker's consecutive-auth-failure count (network drops never feed it).
	it.each([
		["a network drop", () => new SiYuanNetworkError()],
		["a timeout", () => new SiYuanTimeoutError(30_000)],
	])(
		"%s maps to the unreachable error envelope and never counts toward the breaker",
		async (_label, make) => {
			const breaker = new CircuitBreaker();
			for (let i = 0; i < 5; i++) {
				const envelope = await runKbCall(
					{
						validation: validation(),
						breaker,
						kb: "recipes",
						arity: "single",
						now: NOW,
					},
					async () => {
						throw make();
					},
				);
				expect(envelope.status).toBe("error");
				expect(envelope.message).toBe(
					"SiYuan unreachable at http://127.0.0.1:6806",
				);
			}
			expect(breaker.tripped).toBe(false);
		},
	);
});

describe("write gate", () => {
	it("version drift fails closed with the static refusal naming both versions", async () => {
		const { client, calls } = kernelStub();
		const v = validation({
			probe: { verdict: "drift", kernelVersion: "3.9.0" },
		});
		const envelope = expectRefusal(
			await gateWriteAttempt({
				validation: v,
				kernel: client,
				breaker: new CircuitBreaker(),
			}),
		);
		expect(envelope.envelope.message).toContain("3.9.0");
		expect(envelope.envelope.message).toContain(PINNED_SIYUAN_VERSION);
		expect(envelope.envelope.message).toContain("PINNED_SIYUAN_VERSION");
		expect(calls).toEqual([]); // drift verdict is cached — no extra probe
	});

	it("an unreachable kernel retries the probe per write attempt", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const { client: kernel, calls } = kernelStub();
		// First write attempt retries and heals the cached verdict — the
		// gate surfaces the fresh verdict as the stamp.
		const healed = await gateWriteAttempt({
			validation: v,
			kernel,
			breaker: new CircuitBreaker(),
		});
		expect(healed.ok).toBe(true);
		if (!healed.ok) throw new Error("expected stamp");
		expect(healed.probe).toEqual({
			verdict: "ok",
			kernelVersion: PINNED_SIYUAN_VERSION,
		});
		expect(v.probe).toEqual({
			verdict: "ok",
			kernelVersion: PINNED_SIYUAN_VERSION,
		});
		// Second attempt sees the cached ok verdict — no extra probe; the
		// stamp is the cached verdict itself.
		const cached = await gateWriteAttempt({
			validation: v,
			kernel,
			breaker: new CircuitBreaker(),
		});
		expect(cached.ok && cached.probe.verdict === "ok").toBe(true);
		expect(calls).toEqual(["getVersion"]);
	});

	it("a still-failed probe retry refuses only that write", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const { client: kernel } = kernelStub(async () => {
			throw new SiYuanNetworkError();
		});
		const envelope = expectRefusal(
			await gateWriteAttempt({
				validation: v,
				kernel,
				breaker: new CircuitBreaker(),
			}),
		);
		expect(envelope.envelope.status).toBe("refused");
		expect(envelope.envelope.message).toContain(
			"SiYuan unreachable at http://127.0.0.1:6806",
		);
		expect(v.probe).toEqual({ verdict: "unreachable" });
	});

	it("a 429 on the probe arms the cooldown instead of reporting unreachable", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const breaker = new CircuitBreaker();
		const { client: kernel } = kernelStub(async () => {
			throw new SiYuanRateLimitError(429, 90);
		});
		const envelope = expectRefusal(
			await gateWriteAttempt({
				validation: v,
				kernel,
				breaker,
				now: NOW,
			}),
		);
		expect(envelope.envelope.message).toContain("rate-limit lockout");
		expect(envelope.envelope.message).toContain("Retry-After: 90s");
		// The 429 arms the local cooldown — subsequent writes refuse in
		// guardCall with zero kernel calls (any call inside an active lock
		// extends it) — and never counts toward the breaker.
		expect(breaker.inCooldown(NOW)).toBe(true);
		expect(breaker.tripped).toBe(false);
		// The status ladder has no throttle state: the verdict stays
		// "unreachable" and the probe retries after the cooldown expires.
		expect(v.probe).toEqual({ verdict: "unreachable" });
	});

	it("a 401 on the probe feeds the breaker's consecutive-failure count", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const breaker = new CircuitBreaker();
		const { client: kernel } = kernelStub(async () => {
			throw new SiYuanAuthError(401);
		});
		const envelope = expectRefusal(
			await gateWriteAttempt({
				validation: v,
				kernel,
				breaker,
			}),
			"classification",
		);
		expect(envelope.envelope.status).toBe("error");
		expect(envelope.envelope.message).toContain("auth rejected the request");
		// The probe's own 401 counted toward the threshold — two more
		// failures trip it, not three.
		expect(breaker.tripped).toBe(false);
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
		expect(v.probe).toEqual({ verdict: "unreachable" });
	});

	it("an ok probe passes without any probe call", async () => {
		const { client, calls } = kernelStub();
		const pass = await gateWriteAttempt({
			validation: validation(),
			kernel: client,
			breaker: new CircuitBreaker(),
		});
		expect(pass.ok && pass.probe.verdict === "ok").toBe(true);
		expect(calls).toEqual([]);
	});

	it("version drift after a probe retry fails closed", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const { client: kernel } = kernelStub(async () => "4.0.0");
		const envelope = expectRefusal(
			await gateWriteAttempt({
				validation: v,
				kernel,
				breaker: new CircuitBreaker(),
			}),
		);
		expect(envelope.envelope.message).toContain("4.0.0");
		expect(v.probe.verdict).toBe("drift");
	});

	it("an auth failure after a probe retry trips the breaker — classification sees the thrown error", async () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		const v = validation({ probe: { verdict: "unreachable" } });
		const { client: kernel } = kernelStub();
		const envelope = await runKbCall(
			{
				validation: v,
				breaker,
				kernel,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (_names, tracked) => {
				await gateWriteAttempt({ validation: v, kernel: tracked!, breaker });
				throw new SiYuanAuthError(403); // token still bad after the probe
			},
		);
		expect(envelope.status).toBe("refused"); // tripped → fail-fast refusal
		expect(v.probe.verdict).toBe("ok"); // the probe did reach the kernel
		// 2 previous failures + this one = tripped; the probe must not have
		// cleared the count.
		expect(breaker.tripped).toBe(true);
	});

	it("a probe-only write refusal resets no breaker count — the probe marks no contact", async () => {
		const breaker = new CircuitBreaker();
		const recordSuccess = vi.spyOn(breaker, "recordSuccess");
		const v = validation({ probe: { verdict: "unreachable" } });
		const envelope = await runKbCall(
			{
				validation: v,
				breaker,
				kernel: new ProbeShapeKernel(),
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (_names, tracked) => {
				// A property read passes through unmarked — the probe
				// succeeds below, so this line is the only property read
				// through the proxy in this op.
				void tracked!.baseUrl;
				// The retry-path probe runs against the tracked client; the
				// write itself refuses above the mutation (probe-only).
				await gateWriteAttempt({
					validation: v,
					kernel: tracked!,
					breaker,
				});
				return { status: "refused", message: "probe-only refusal" };
			},
		);
		expect(v.probe.verdict).toBe("ok"); // the probe did reach the kernel
		expect(envelope.status).toBe("refused");
		// An unauthenticated probe must not reset the consecutive count.
		expect(recordSuccess).not.toHaveBeenCalled();
	});
});

describe("reads never gate on the cached unreachable verdict", () => {
	it("runKbCall attempts the kernel op even while the probe verdict is unreachable", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		let kernelCalls = 0;
		const envelope = await runKbCall(
			{
				validation: v,
				breaker: new CircuitBreaker(),
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async (names) => {
				kernelCalls++;
				return { status: "ok", message: `read ${names.join(",")}` };
			},
		);
		expect(kernelCalls).toBe(1);
		expect(envelope.status).toBe("ok");
	});
});

describe("runKbCall verification-phase auth accounting", () => {
	const gatedWrite = (breaker: CircuitBreaker) => ({
		validation: validation(),
		breaker,
		kernel: kernelStub().client,
		kb: "recipes" as const,
		arity: "single" as const,
		now: NOW,
	});

	it("a rate-limit verdict arms the cooldown — reset-on-success is skipped", async () => {
		const breaker = new CircuitBreaker();
		const envelope = await runKbCall(gatedWrite(breaker), async () =>
			errorEnvelope(
				"the kernel's per-IP auth lock refused the write's verification read (HTTP 429): SiYuan rate-limited the request (HTTP 429, Retry-After 90s)",
				{
					kb: "recipes",
					verificationFailed: true,
					authEvent: { kind: "rate-limit", retryAfterSeconds: 90 },
				},
			),
		);
		// The verdict carried the served Retry-After and the cooldown is
		// armed: the transport success did not reset the breaker over it.
		expect(envelope.status).toBe("error");
		expect(breaker.inCooldown(NOW)).toBe(true);
		expect(breaker.lastRetryAfterSeconds).toBe(90);
	});

	it("auth verdicts accumulate to the trip threshold instead of resetting", async () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < AUTH_DODGE_THRESHOLD; i++) {
			await runKbCall(gatedWrite(breaker), async () =>
				errorEnvelope(
					"SiYuan rejected the write's verification read (auth failure): SiYuan auth rejected the request (HTTP 401)",
					{
						kb: "recipes",
						verificationFailed: true,
						authEvent: { kind: "auth" },
					},
				),
			);
		}
		expect(breaker.tripped).toBe(true);
	});
});
