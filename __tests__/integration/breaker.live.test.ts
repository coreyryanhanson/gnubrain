// Live auth-failure classification through the extension gate, in-process
// over the register(pi, deps) seam. Two cases, one per breaker leg:
//
// - 401 → breaker: a token that validates at startup but is rejected
//   per-call (rotation = the field scenario) feeds the consecutive-failure
//   count; the tripping read returns the local breaker refusal, post-trip
//   reads refuse with zero kernel round-trips, and /kb recovery with the
//   corrected token restores reads immediately. Never arms the lock.
// - 429 → cooldown: the extension half of the throttle story. A genuine
//   kernel 429 (a CORRECT token riding an armed per-IP lock — the shared
//   lock, not a wrong credential) must classify to the cooldown: the
//   offending call refuses, the next call inside the window refuses locally
//   with zero kernel round-trips, and the lock self-heals on expiry with no
//   recovery step. "Real 429 → typed throw" is falsified primitives-side
//   (siyuan-kb-primitives throttle.live, same flag); "typed throw → gate
//   refusal → local cooldown" here — the stub in gate.test.ts pins the same
//   branches and cannot see the kernel's real response shape.
//
// The 429 case is the ONLY lock-arming case in this suite, and it arms
// minimally: 6 bogus auths + the one during-lock request the observation
// itself makes (final FailCount 7 → authLockSeconds(7) = 120s, self-heals
// in ~2 min). The schedule is pin-owning-repo knowledge — this case must
// never grow arms. It is double-gated (SIYUAN_INTEGRATION_THROTTLE=1 on top
// of SIYUAN_INTEGRATION=1) and must run LAST (INTEGRATION_ORDER): while the
// lock is held, every other live case on this IP would 429.
//
// Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	SiYuanKernelClient,
	SiYuanRateLimitError,
	authLockSeconds,
} from "siyuan-kb-primitives";
import register, { type GnubrainDeps } from "../../index.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import {
	BASE_URL,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	rawKernelCall,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

/** Lock-arming opt-in — same flag as the primitives' throttle pin: it means
 * "this run may arm the kernel's per-IP lock and wait it out". */
const THROTTLE_ENABLED =
	INTEGRATION && process.env.SIYUAN_INTEGRATION_THROTTLE === "1";

/** Call-counting client wrapper: every client method records its name, then
 * dispatches to the target `dispatch()` returns at call time — the token
 * rotator (401 case) and the plain pass-through (429 case) differ only in
 * that target. `baseUrl` passes through as a plain property. */
function countingClient(dispatch: () => SiYuanKernelClient): {
	calls: string[];
	client: () => SiYuanKernelClient;
} {
	const calls: string[] = [];
	return {
		calls,
		client: () =>
			new Proxy({} as SiYuanKernelClient, {
				get(_t, prop) {
					if (prop === "baseUrl") return BASE_URL;
					return async (...args: unknown[]) => {
						calls.push(String(prop));
						const target = dispatch();
						const fn = Reflect.get(target as object, prop) as (
							...a: unknown[]
						) => unknown;
						return fn.apply(target, args);
					};
				},
			}),
	};
}

/** The register(pi, deps) seam against the live fixtures: project settings
 * unreadable (ENOENT), global settings in memory, the kernel rides the
 * caller's client factory. Fires session_start (startup validation — the
 * callers need it before they arm anything) and returns the session's
 * command driver and a docId-read helper over fixture-a. */
async function startGatedSession(
	fixtures: IntegrationFixtures,
	createClient: NonNullable<GnubrainDeps["createClient"]>,
) {
	const { pi, fire, runCommand, runTool } = createFakePi();
	register(pi, {
		readFile: async (path: string) => {
			if (path.startsWith("/project")) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			}
			return JSON.stringify({ gnubrain: fixtures.settings });
		},
		createClient,
	});
	const { ctx } = createFakeCtx({ cwd: "/project" });
	await fire("session_start", ctx);
	return {
		ctx,
		runCommand,
		read: async (docId: string) =>
			(await runTool("kb_read", { kb: "fixture-a", docId }, ctx)).details as {
				status: string;
				message: string;
			},
	};
}

describe.skipIf(!INTEGRATION || TOKEN === "")("auth breaker (live)", () => {
	let fixtures: IntegrationFixtures;
	beforeAll(async () => {
		fixtures = await setupFixtures();
	}, LIVE_TIMEOUT);
	afterAll(async () => {
		if (fixtures === undefined) return;
		// The 429 case arms the kernel's per-IP lock; if it fails before its
		// post-expiry read, teardown runs inside the lock and every call 429s
		// and re-arms it — surface that instead of cascading opaque errors.
		try {
			await fixtures.teardown();
		} catch (err) {
			if (err instanceof SiYuanRateLimitError) {
				throw new Error(
					"teardown hit the armed 429 lock — fixture notebooks left in place, kernel container reset required; the lock self-heals in ≤15 min, rerun after it clears",
				);
			}
			throw err;
		}
	}, LIVE_TIMEOUT);

	// ---------------------------------------------------------------
	// Auth breaker, live: a token that validates at startup but
	// is rejected per-call (rotation = the field scenario) feeds the
	// breaker; the tripping read returns refused with the breaker message
	// (the 3rd consecutive failure returns the local
	// refusal, not the auth error), post-trip reads refuse locally with
	// ZERO kernel round-trips, and /kb recovery with the corrected token
	// restores reads immediately.
	// ---------------------------------------------------------------
	it("auth breaker trips on live 401s, refuses locally, recovers via /kb", async () => {
		const docId = await mintDoc(
			fixtures.client,
			fixtures.notebookIds.fixtureA,
			"/gate-breaker",
			"breaker recovery target",
		);

		// Token-rotating client: validation rides the real token; tool calls
		// ride a stale token while `stale` is set — the 401s below are
		// genuine live kernel rejections.
		let stale = false;
		const { calls, client } = countingClient(() =>
			stale
				? new SiYuanKernelClient(BASE_URL, "gnubrain-gate-bogus-token")
				: fixtures.client,
		);
		const { ctx, runCommand, read } = await startGatedSession(fixtures, client);

		// Mid-session rotation: startup validated with the real token; from
		// here the client rides the stale token.
		stale = true;
		// Reads 1–2: genuine 401s surface as auth errors and feed the breaker.
		const first = await read(docId);
		expect(first.status).toBe("error");
		expect(first.message).toMatch(/auth/i);
		const second = await read(docId);
		expect(second.status).toBe("error");
		expect(second.message).toMatch(/auth/i);
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// The tripping read returns the local refusal, not an auth error.
		const tripping = await read(docId);
		expect(tripping.status).toBe("refused");
		expect(tripping.message).toContain("circuit breaker");

		// Post-trip: refused locally with zero kernel round-trips.
		calls.length = 0;
		const fourth = await read(docId);
		expect(fourth.status).toBe("refused");
		expect(fourth.message).toContain("circuit breaker");
		expect(calls).toEqual([]);

		// Recovery: /kb with the corrected (un-rotated) client re-validates
		// against the live kernel — success clears the breaker — and reads
		// restore immediately, no cooldown wait.
		stale = false;
		// Bare /kb: the recovery hook re-validates against the live kernel
		// before dispatch; success clears the breaker.
		await runCommand("", ctx);
		calls.length = 0;
		const recovered = await read(docId);
		expect(recovered.status).toBe("ok");
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});

	// ---------------------------------------------------------------
	// 429 cooldown, live — the extension half of the throttle story.
	// Gated separately: this case arms the kernel's per-IP lock (a
	// correct-token call inside an armed lock re-arms it — the field
	// scenario the local cooldown exists for), so it opt-ins further and
	// must run last. The call-counting wrapper proves the cooldown window
	// is honored locally (zero round-trips), and the expiry wait doubles as
	// the no-stray-calls proof: any kb call during the wait would re-arm
	// the lock past the computed floor and the post-expiry read would 429.
	// ---------------------------------------------------------------
	it.skipIf(!THROTTLE_ENABLED)(
		"a live kernel 429 (correct token, armed lock) arms the cooldown, refuses locally, self-heals",
		{ timeout: 300_000 },
		async () => {
			// A lock held by a previous run or an external source would turn
			// the arming sequence into an extension cascade — fail with
			// instructions instead (it self-heals; rerun after it clears).
			try {
				await fixtures.client.listNotebooks();
			} catch (err) {
				if (err instanceof SiYuanRateLimitError) {
					throw new Error(
						"a throttle lock is already held (previous run or an external source) — it self-heals in ≤15 min; rerun after it clears",
					);
				}
				throw err;
			}

			const docId = await mintDoc(
				fixtures.client,
				fixtures.notebookIds.fixtureA,
				"/breaker-429",
				"429 cooldown target",
			);
			const { calls, client } = countingClient(() => fixtures.client);
			const { read } = await startGatedSession(fixtures, client);

			// Arm minimally: six bogus-token auths (token + one char) on a
			// guarded endpoint — the first five 401, the sixth records fail 6
			// and arms the lock. The observation call below is the last
			// failure this case ever records (FailCount 7); growing arms here
			// would re-pin the schedule, which belongs to the primitives.
			for (let i = 0; i < 6; i++) {
				const res = await rawKernelCall(
					"/api/notebook/lsNotebooks",
					{},
					{
						token: `${TOKEN}x`,
					},
				);
				expect(res.status).toBe(401);
			}

			// The live 429: a correctly-authenticated kb_read during the lock.
			// The shared per-IP lock 429s a valid token; the first kernel HTTP
			// request → typed throw → the gate arms the local cooldown.
			calls.length = 0;
			const armed = await read(docId);
			expect(armed.status).toBe("refused");
			expect(armed.message).toContain("HTTP 429");
			expect(armed.message).toContain("keyed by client IP");
			expect(armed.message).toContain("Do not change the token or settings");
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const served = Number(
				/kernel Retry-After: (\d+)s/.exec(armed.message)?.[1] ?? 0,
			);
			expect(served).toBeGreaterThan(0);

			// Inside the cooldown: refused locally with zero kernel round-trips
			// — the gate never lets a retry reach the lock to extend it.
			calls.length = 0;
			const refused = await read(docId);
			expect(refused.status).toBe("refused");
			expect(refused.message).toContain("rate-limit lockout");
			expect(calls).toEqual([]);

			// Wait out the KERNEL lock with zero kb calls — any call during the
			// lock re-arms it, so a poll loop cannot terminate. Final FailCount
			// 7 → authLockSeconds(7) = 120s; the served Retry-After understates
			// the lock by one extension generation (it was computed before the
			// observation call's own fail), so the floor doubles it as drift
			// cover, like the primitives' throttle case does.
			await new Promise((resolve) =>
				setTimeout(
					resolve,
					Math.max(authLockSeconds(7), 2 * served) * 1000 + 15_000,
				),
			);

			// Post-expiry: the next call succeeds with no recovery step — and
			// its success clears the kernel's fail counter, leaving nothing
			// behind. A stray kb call during the wait would have re-armed the
			// lock past this floor and made this read 429 instead.
			const healed = await read(docId);
			expect(healed.status).toBe("ok");
		},
	);
});
