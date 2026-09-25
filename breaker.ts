// auth-lockout circuit breaker + 429 cooldown.
// The breaker counts consecutive 401/403 failures per session and trips at 3.
// A 429 is never counted toward the breaker and never resets it (it is not
// evidence this session's token is wrong); it arms a local cooldown deadline
// so a retrying model cannot extend the kernel's IP-keyed lock.
//
// Session-lifetime by design, and deliberately not persisted across sessions
// or processes: pi re-registers the extension per session, so a fresh
// `register()` closure mints a fresh breaker at zero — and a persisted state
// file would add stale-deadline and multi-writer hazards to dodge a lock
// that self-heals on its own (≤15 min; any call during a lock re-arms it,
// which is why the breaker only waits it out, never retries into one). The
// residual — a fresh session restarts consecutive counting at zero against
// a kernel that locks at six consecutive — is accepted: the lock self-heals,
// the cooldown floor plus the served Retry-After bound the retries, and /kb
// recovery is the explicit reset path.

import {
	authLockSeconds,
	type SiYuanRateLimitError,
} from "siyuan-kb-primitives";

export const BREAKER_THRESHOLD = 3;
/** floor: the pinned kernel's first lock is authLockSeconds(6) = 60s; the
 * served header can understate a lock extended since it was computed, so the
 * deadline is advisory. The schedule itself lives in the pin-owning package
 * (authLockSeconds) — a kernel upgrade falsifies it there, not here. */
const COOLDOWN_FLOOR_SECONDS = authLockSeconds(6);

export class CircuitBreaker {
	private consecutive = 0;
	private cooldownDeadline = 0;
	/** Served `Retry-After` of the most recent 429, for the refusal message. */
	lastRetryAfterSeconds: number | undefined;

	recordAuthFailure(): void {
		this.consecutive += 1;
	}

	/** reset-on-success: any successful authenticated call clears the count. */
	recordSuccess(): void {
		this.consecutive = 0;
	}

	/** Arms the local cooldown. Takes the genuine `SiYuanRateLimitError` from the
	 * client so the extension can never misclassify a synthetic 429 shape. */
	recordRateLimit(err: SiYuanRateLimitError, now: number = Date.now()): void {
		const served = err.retryAfterSeconds;
		this.lastRetryAfterSeconds = served;
		const seconds = Math.max(
			COOLDOWN_FLOOR_SECONDS,
			served ?? COOLDOWN_FLOOR_SECONDS,
		);
		this.cooldownDeadline = Math.max(
			this.cooldownDeadline,
			now + seconds * 1000,
		);
	}

	get tripped(): boolean {
		return this.consecutive >= BREAKER_THRESHOLD;
	}

	inCooldown(now: number = Date.now()): boolean {
		return now < this.cooldownDeadline;
	}

	get cooldownUntil(): number {
		return this.cooldownDeadline;
	}

	/** /kb recovery clears the breaker count only — an active 429 cooldown is
	 * deliberately untouched and self-heals on expiry (pins no /kb recovery
	 * for the cooldown; clearing it early would let a retry re-extend the lock). */
	reset(): void {
		this.consecutive = 0;
	}
}
