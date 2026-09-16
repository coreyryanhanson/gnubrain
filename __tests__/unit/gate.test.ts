import { describe, expect, it } from "vitest";
import {
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import {
	gateWriteAttempt,
	guardCall,
	resolveKbParam,
	runKbCall,
} from "../../gate.js";
import type { SessionValidation } from "../../validation.js";

const NOW = 1_000_000_000;

function validation(overrides?: {
	scope?: string[];
	validKBs?: [string, string][];
	shapeErrors?: string[];
	probe?: SessionValidation["probe"];
	kernelVersion?: string;
}): SessionValidation {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [
				{ name: "recipes", notebook: "nb-r" },
				{ name: "projects", notebook: "nb-p" },
			],
		},
		shapeErrors: overrides?.shapeErrors ?? [],
		probe: overrides?.probe ?? "ok",
		kernelVersion: overrides?.kernelVersion ?? "3.8.3",
		validKBs: new Map(
			overrides?.validKBs ?? [
				["recipes", "nb-r"],
				["projects", "nb-p"],
			],
		),
		scope: overrides?.scope ?? ["recipes"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	};
}

function kernelStub() {
	const calls: string[] = [];
	return {
		calls,
		client: {
			baseUrl: "http://127.0.0.1:6806",
			async getVersion() {
				calls.push("getVersion");
				return "3.8.3";
			},
			async listNotebooks() {
				calls.push("listNotebooks");
				throw new Error("not used");
			},
		},
	};
}

describe("kb param contract", () => {
	const v = validation();

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
		const result = resolveKbParam(["projects"], "single", v);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.message).toBe(
			"'projects' exists but is not in the active scope — activate it with /kb, or change gnubrain.defaultKBs in settings",
		);
	});

	it("rejects a configured-but-invalid KB (stale/encrypted)", () => {
		const v2 = validation({ validKBs: [["recipes", "nb-r"]] });
		const result = resolveKbParam(["projects"], "single", v2);
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

	it("enforces the single-name arity on write-shaped calls", () => {
		expect(resolveKbParam(["a", "b"], "single", v).ok).toBe(false);
		expect(resolveKbParam(["a"], "single", v).ok).toBe(false);
		expect(resolveKbParam(42, "single", v).ok).toBe(false);
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
			{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
			async (_names, contact) => {
				if (fail) throw new SiYuanAuthError(403);
				contact();
				return { status: "ok", message: "" };
			},
		);
		expect(envelope.status).toBe("error");
		fail = false;
		await runKbCall(
			{ validation: v, breaker, kb: "recipes", arity: "single", now: NOW },
			async () => ({ status: "ok", message: "" }),
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

	it("a network drop maps to the error envelope and never counts toward the breaker", async () => {
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
					throw new SiYuanNetworkError();
				},
			);
			expect(envelope.status).toBe("error");
			expect(envelope.message).toBe(
				"SiYuan unreachable at http://127.0.0.1:6806",
			);
		}
		expect(breaker.tripped).toBe(false);
	});

	it("a timeout maps to the same unreachable error envelope and never counts toward the breaker", async () => {
		const breaker = new CircuitBreaker();
		const envelope = await runKbCall(
			{
				validation: validation(),
				breaker,
				kb: "recipes",
				arity: "single",
				now: NOW,
			},
			async () => {
				throw new SiYuanTimeoutError(30_000);
			},
		);
		expect(envelope.status).toBe("error");
		expect(envelope.message).toBe(
			"SiYuan unreachable at http://127.0.0.1:6806",
		);
		expect(breaker.tripped).toBe(false);
	});
});

describe("write gate", () => {
	it("version drift fails closed with the static refusal naming both versions", async () => {
		const { client, calls } = kernelStub();
		const v = validation({ probe: "drift", kernelVersion: "3.9.0" });
		const envelope = await gateWriteAttempt({ validation: v, kernel: client });
		expect(envelope?.status).toBe("refused");
		expect(envelope?.message).toContain("3.9.0");
		expect(envelope?.message).toContain("3.8.3");
		expect(envelope?.message).toContain("PINNED_SIYUAN_VERSION");
		expect(calls).toEqual([]); // drift verdict is cached — no extra probe
	});

	it("an unreachable kernel retries the probe per write attempt", async () => {
		const calls: string[] = [];
		const v = validation({ probe: "unreachable" });
		const kernel = {
			baseUrl: "http://127.0.0.1:6806",
			getVersion: async () => {
				calls.push("probe");
				return "3.8.3";
			},
			listNotebooks: async () => {
				throw new Error("not used");
			},
		};
		// First write attempt retries and heals the cached verdict.
		expect(await gateWriteAttempt({ validation: v, kernel })).toBeNull();
		expect(v.probe).toBe("ok");
		// Second attempt sees the cached ok verdict — no extra probe.
		expect(await gateWriteAttempt({ validation: v, kernel })).toBeNull();
		expect(calls).toEqual(["probe"]);
	});

	it("a still-failed probe retry refuses only that write", async () => {
		const v = validation({ probe: "unreachable" });
		const kernel = {
			baseUrl: "http://127.0.0.1:6806",
			getVersion: async () => {
				throw new SiYuanNetworkError();
			},
			listNotebooks: async () => {
				throw new Error("not used");
			},
		};
		const envelope = await gateWriteAttempt({ validation: v, kernel });
		expect(envelope?.status).toBe("refused");
		expect(envelope?.message).toContain(
			"SiYuan unreachable at http://127.0.0.1:6806",
		);
	});

	it("an ok probe passes without any probe call", async () => {
		const { client, calls } = kernelStub();
		expect(
			await gateWriteAttempt({ validation: validation(), kernel: client }),
		).toBeNull();
		expect(calls).toEqual([]);
	});

	it("version drift after a probe retry fails closed", async () => {
		const v = validation({ probe: "unreachable" });
		const kernel = {
			baseUrl: "http://127.0.0.1:6806",
			getVersion: async () => "4.0.0",
			listNotebooks: async () => {
				throw new Error("not used");
			},
		};
		const envelope = await gateWriteAttempt({ validation: v, kernel });
		expect(envelope?.status).toBe("refused");
		expect(envelope?.message).toContain("4.0.0");
		expect(v.probe).toBe("drift");
	});
});

describe("reads never gate on the cached unreachable verdict", () => {
	it("runKbCall attempts the kernel op even while the probe verdict is unreachable", async () => {
		const v = validation({ probe: "unreachable" });
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
