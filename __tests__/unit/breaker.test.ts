import { describe, expect, it } from "vitest";
import { SiYuanRateLimitError } from "siyuan-kb-primitives";
import { BREAKER_THRESHOLD, CircuitBreaker } from "../../breaker.js";

const NOW = 1_000_000_000;

describe("CircuitBreaker", () => {
	it("trips after 3 consecutive auth failures", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(false);
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
	});

	it("resets the consecutive count on a successful authenticated call", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		breaker.recordSuccess();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		// 2 fail → success → 2 fail does not trip (reset-on-success rule).
		expect(breaker.tripped).toBe(false);
	});

	it("a 429 never increments the consecutive count and never resets it", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordAuthFailure();
		// Genuine SiYuanRateLimitError instance, not a synthetic 429 shape.
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 90), NOW);
		// Neither incremented (3x429 stays under the threshold)…
		for (let i = 0; i < BREAKER_THRESHOLD; i++) {
			breaker.recordRateLimit(new SiYuanRateLimitError(429, 60), NOW);
		}
		expect(breaker.tripped).toBe(false);
		// …nor reset the count already accumulated.
		breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
	});

	it("429 arms a local cooldown floored at 60s and quoting the served Retry-After", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429), NOW);
		// Floor: absent Retry-After → 60s.
		expect(breaker.inCooldown(NOW + 59_999)).toBe(true);
		expect(breaker.inCooldown(NOW + 60_000)).toBe(false);

		const breaker2 = new CircuitBreaker();
		breaker2.recordRateLimit(new SiYuanRateLimitError(429, 120), NOW);
		expect(breaker2.inCooldown(NOW + 120_000)).toBe(false);
		expect(breaker2.inCooldown(NOW + 119_999)).toBe(true);
		// Served value below the floor is floored up.
		const breaker3 = new CircuitBreaker();
		breaker3.recordRateLimit(new SiYuanRateLimitError(429, 5), NOW);
		expect(breaker3.inCooldown(NOW + 59_999)).toBe(true);
		expect(breaker3.lastRetryAfterSeconds).toBe(5);
	});

	it("an extended lock keeps the later deadline", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 60), NOW);
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 300), NOW + 1000);
		expect(breaker.inCooldown(NOW + 60_000)).toBe(true);
		expect(breaker.inCooldown(NOW + 301_000)).toBe(false);
	});

	it("post-expiry calls succeed (inCooldown goes false)", () => {
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 60), NOW);
		expect(breaker.inCooldown(NOW)).toBe(true);
		expect(breaker.inCooldown(NOW + 60_000)).toBe(false);
	});

	it("/kb recovery resets the count but never an active 429 cooldown", () => {
		const breaker = new CircuitBreaker();
		breaker.recordAuthFailure();
		breaker.recordRateLimit(new SiYuanRateLimitError(429, 300), NOW);
		breaker.reset();
		expect(breaker.tripped).toBe(false);
		// reset() cleared the count — it takes a full threshold again to trip.
		for (let i = 0; i < BREAKER_THRESHOLD - 1; i++) {
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
