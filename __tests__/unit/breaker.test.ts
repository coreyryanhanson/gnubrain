import { describe, expect, it } from "vitest";
import {
	AUTH_DODGE_THRESHOLD,
	SiYuanRateLimitError,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";

const NOW = 1_000_000;

// Seam suite: the dodge schedule itself (trip threshold, 429-vs-count rules,
// cooldown floor and monotonic extension, reset-on-success) lives beside
// authLockSeconds in siyuan-kb-primitives and is falsified there. These cases
// pin only the holder's wiring — genuine error class → event mapping, the
// wording state, and the /kb recovery rule.

describe("CircuitBreaker — session holder over authLockDodge", () => {
	it("feeds auth failures to the reducer and trips on the barrel's threshold", () => {
		const breaker = new CircuitBreaker();
		for (let i = 0; i < AUTH_DODGE_THRESHOLD - 1; i++) {
			breaker.recordAuthFailure();
		}
		expect(breaker.tripped).toBe(false);
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
	});

	it("reset-on-success wiring: a successful call clears the count", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		breaker.recordSuccess();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(false);
	});

	it("a genuine 429 arms the cooldown and captures the served Retry-After for wording", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 90), NOW);
		expect(breaker.inCooldown(NOW)).toBe(true);
		expect(breaker.inCooldown(NOW + 90_000)).toBe(false);
		expect(breaker.cooldownUntil).toBe(NOW + 90_000);
		expect(breaker.lastRetryAfterSeconds).toBe(90);
	});

	it("/kb recovery resets the count but never an active 429 cooldown", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 300), NOW);
		breaker.reset();
		expect(breaker.tripped).toBe(false);
		// reset() cleared the count — it takes a full threshold again to trip.
		for (let i = 0; i < AUTH_DODGE_THRESHOLD - 1; i++) {
			breaker.recordAuthFailure();
		}
		expect(breaker.tripped).toBe(false);
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
		// The cooldown self-heals on expiry alone — no /kb recovery for it.
		expect(breaker.inCooldown(NOW)).toBe(true);
		expect(breaker.inCooldown(NOW + 300_000)).toBe(false);
	});
});
