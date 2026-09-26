// Session-lifetime holder over the barrel's auth-dodge reducer
// (authLockDodge): the schedule-shaped judgment — the trip threshold held in
// reserve under the kernel's 6-failure per-IP lock, the 429 cooldown floor,
// deadline extension, reset-on-success — lives beside authLockSeconds in
// siyuan-kb-primitives. This side owns only session scoping, the genuine
// SiYuanRateLimitError → event seam, and the wording state.
//
// Session-lifetime by design, and deliberately not persisted across sessions
// or processes: pi re-registers the extension per session, so a fresh
// `register()` closure mints a fresh breaker at zero — and a persisted state
// file would add stale-deadline and multi-writer hazards to dodge a lock
// that self-heals on its own (≤15 min). The residual — a fresh session
// restarts consecutive counting at zero against a kernel that locks at six
// consecutive — is accepted: the lock self-heals, the cooldown floor plus
// the served Retry-After bound the retries, and /kb recovery is the explicit
// reset path.

import {
	authDodgeTripped,
	authLockDodge,
	type AuthDodgeState,
	type SiYuanRateLimitError,
} from "siyuan-kb-primitives";

export class CircuitBreaker {
	// Fresh literal per instance — the reducer is pure, but a module-level
	// shared object would make any future direct mutation cross instances.
	private state: AuthDodgeState = {
		consecutiveAuthFailures: 0,
		cooldownUntil: 0,
	};
	/** Served `Retry-After` of the most recent 429, for the refusal message. */
	lastRetryAfterSeconds: number | undefined;

	recordAuthFailure(): void {
		this.state = authLockDodge(this.state, { kind: "auth-failure" }, 0);
	}

	/** reset-on-success: any successful authenticated call clears the count. */
	recordSuccess(): void {
		this.state = authLockDodge(this.state, { kind: "success" }, 0);
	}

	/** Arms the local cooldown. Takes the genuine `SiYuanRateLimitError` from the
	 * client so the extension can never misclassify a synthetic 429 shape. */
	recordRateLimit(err: SiYuanRateLimitError, now: number = Date.now()): void {
		this.lastRetryAfterSeconds = err.retryAfterSeconds;
		this.state = authLockDodge(
			this.state,
			{ kind: "rate-limit", servedRetryAfterSeconds: err.retryAfterSeconds },
			now,
		);
	}

	get tripped(): boolean {
		return authDodgeTripped(this.state);
	}

	inCooldown(now: number = Date.now()): boolean {
		return now < this.state.cooldownUntil;
	}

	get cooldownUntil(): number {
		return this.state.cooldownUntil;
	}

	/** /kb recovery clears the breaker count only — an active 429 cooldown is
	 * deliberately untouched and self-heals on expiry (pins no /kb recovery
	 * for the cooldown; clearing it early would let a retry re-extend the lock). */
	reset(): void {
		this.state = authLockDodge(this.state, { kind: "success" }, 0);
	}
}
