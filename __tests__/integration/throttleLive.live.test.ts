// Sprint 5b-d item 12: throttle / raw-DML-hardening / encrypted-notebook
// cases, ordered per §10 — the encrypted case needs the kernel (never inside
// the throttle lock window), the throttle pin runs after all other kernel
// cases and ends by waiting out the extended lock, and the raw-DML hardening
// pin runs last (since 3.8.4 it creates no desync — the position is the kept
// §10-last slot; see DESIGN_v2.md Appendix B, deviation 9). The cross-file
// ordering that puts this file last lives in vitest.config.ts (OrderedSequencer).
//
// Opt-in: SIYUAN_INTEGRATION=1 for the file; the throttle case additionally
// needs SIYUAN_INTEGRATION_THROTTLE=1 (its arming sequence ends at a final
// lock of 480s, extendable to the 15-min cap — never CI, never run twice in
// quick succession, and it self-heals); the encrypted case
// needs SIYUAN_ENCRYPTED_PASSWORD and an encryption-enabled workspace (the
// one-time enable is a user action in SiYuan's own UI — the extension never
// manages the key domain).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient, SiYuanRateLimitError } from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { globalSettingsPath, loadGnubrainSettings } from "../../settings.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import {
	PINNED_SIYUAN_VERSION,
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";
import { sqlString } from "../../kernel.js";
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

const THROTTLE_ENABLED =
	INTEGRATION && process.env.SIYUAN_INTEGRATION_THROTTLE === "1";
const ENCRYPTED_PASSWORD = process.env.SIYUAN_ENCRYPTED_PASSWORD ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The kernel's lockout math at 3.8.4 (util/session.go): locking starts at
 * the 6th consecutive fail, `30 << (FailCount - 5)` seconds, capped at 15
 * min; any request during a lock (correct token included) records another
 * fail and overwrites the lock. This case's arming sequence ends at FailCount
 * 9 — 6 bogus + the 7th + the correct-token 429 + the during-call kb_read —
 * so the final lock is 30 << 4 = 480s. Each served Retry-After reports the
 * remaining time of the lock BEFORE the fail that extended it, so the last
 * served value (240s) understates the final lock by one generation — the
 * wait floors on the computed 480s, doubled last-served as drift cover.
 * The margin absorbs clock skew (5 s raced it once in the client's runs). */
const THROTTLE_FINAL_LOCK_MS = 480_000;
const SLEEP_MARGIN_MS = 15_000;

interface KernelCounts {
	query: number;
	search: number;
	exportMarkdown: number;
	getChildBlocks: number;
}

const zeroCounts = (): KernelCounts => ({
	query: 0,
	search: 0,
	exportMarkdown: 0,
	getChildBlocks: 0,
});

/** Prototype-chained counting view — the inherited methods keep their
 * binding, so this observes every kernel round-trip the extension makes. */
function countingKernel(
	client: SiYuanKernelClient,
	counts: KernelCounts,
): SiYuanKernelClient {
	return Object.assign(Object.create(client), {
		query: async (stmt: string) => {
			counts.query += 1;
			return client.query(stmt);
		},
		search: async (p: Parameters<SiYuanKernelClient["search"]>[0]) => {
			counts.search += 1;
			return client.search(p);
		},
		exportMarkdown: async (id: string) => {
			counts.exportMarkdown += 1;
			return client.exportMarkdown(id);
		},
		getChildBlocks: async (id: string) => {
			counts.getChildBlocks += 1;
			return client.getChildBlocks(id);
		},
	}) as SiYuanKernelClient;
}

/** kb_read runner over the read tools (the same execute shape every live
 * case file uses). */
function readRunner(
	validation: SessionValidation,
	kernel: SiYuanKernelClient,
	breaker: CircuitBreaker,
): (
	params: Record<string, unknown>,
) => Promise<Record<string, unknown> & { status: string }> {
	const { pi, toolDefs } = createFakePi();
	registerReadToolsAndToolset(pi, {
		getValidation: () => validation,
		getKernel: () => kernel,
		breaker,
		baselines: ContentBaselines.create(),
	});
	const { ctx } = createFakeCtx();
	return async (params) =>
		(
			await (
				toolDefs.get("kb_read") as unknown as {
					execute: (...args: unknown[]) => Promise<{
						details: Record<string, unknown> & { status: string };
					}>;
				}
			).execute("id", params, undefined, undefined, ctx)
		).details;
}

/** Teardown that surfaces an active lock instead of cascading extensions
 * toward the cap (each 429 under the lock re-arms it). */
async function teardownToleratingLock(
	fixtures: IntegrationFixtures,
): Promise<void> {
	try {
		await fixtures.teardown();
	} catch (err) {
		if (err instanceof SiYuanRateLimitError) {
			throw new Error(
				"throttle teardown hit the active lock — fixture notebooks left in place, kernel container reset required",
			);
		}
		throw err;
	}
}

describe.skipIf(!INTEGRATION || TOKEN === "")("5b-d item 12 cases", () => {
	let client: SiYuanKernelClient;
	let baselineCount: number;

	beforeAll(async () => {
		client = new SiYuanKernelClient(BASE_URL, TOKEN);
		const version = await client.getVersion();
		expect(version).toBe(PINNED_SIYUAN_VERSION);
		try {
			baselineCount = (await client.listNotebooks()).notebooks.length;
		} catch (err) {
			if (err instanceof SiYuanRateLimitError) {
				throw new Error(
					"throttle lock still held from a previous run — it self-heals (≤15 min) or the kernel containers can be reset; rerun after it clears",
				);
			}
			throw err;
		}
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		// Every test tears down its own fixtures and asserts the baseline; a
		// failure here is the red that keeps the workspace clean.
		const remaining = (await client.listNotebooks()).notebooks.length;
		expect(remaining).toBe(baselineCount);
	}, LIVE_TIMEOUT);

	it(
		"encrypted-notebook pins: encrypted:true in both lock states, startup rejection names the KB, the plain KB validates clean, zero kernel calls from the encrypted KB",
		{ timeout: 180_000 },
		async (ctx) => {
			const status = await client.getEncryptedNotebookStatus();
			if (!status.enabled || ENCRYPTED_PASSWORD === "") {
				ctx.skip();
				return;
			}

			const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
			// Typed createEncryptedNotebook: the box comes back mounted/unlocked.
			const enc = await client.createEncryptedNotebook(
				`gnubrain-it-enc-${stamp}`,
				ENCRYPTED_PASSWORD,
			);
			const plain = await client.createNotebook(`gnubrain-it-plain-${stamp}`);
			await client.openNotebook(plain.id);
			// A doc in the plain fixture so its tool call has a real target; the
			// encrypted KB gets nothing — its tools must never fire.
			const plainDocId = await client.createDocWithMarkdown({
				notebook: plain.id,
				path: "/plain doc",
				markdown: "plain fixture body",
			});

			// Best-effort removals on any failure path — removeNotebook works
			// on encrypted boxes in either lock state, so teardown cannot
			// strand a fixture.
			const cleanup = async () => {
				await client.removeNotebook(enc.id);
				await client.removeNotebook(plain.id);
			};
			try {
				const counts = zeroCounts();
				const kernel = countingKernel(client, counts);
				const settings = {
					baseUrl: BASE_URL,
					apiToken: TOKEN,
					kbs: [
						{ name: "enc-kb", notebook: enc.id },
						{ name: "plain-kb", notebook: plain.id },
					],
					defaultKBs: ["enc-kb", "plain-kb"],
					allowUnattendedWrites: true,
				};
				const loaded = await loadGnubrainSettings(
					async () => JSON.stringify({ gnubrain: settings }),
					globalSettingsPath("/gnubrain-it-fake-home"),
					undefined,
				);
				const validate = (): Promise<SessionValidation> =>
					runSessionValidation({ loaded, kernel });

				// Lock state A — unlocked, as created: the rejection names the KB,
				// the plain KB validates clean alongside.
				const unlocked = await validate();
				expect(unlocked.validKBs.has("enc-kb")).toBe(false);
				expect(unlocked.validKBs.has("plain-kb")).toBe(true);
				expect(
					unlocked.warnings.some(
						(w) => w.includes("enc-kb") && w.includes("encrypted notebook"),
					),
				).toBe(true);

				// Lock it (typed closeNotebook — the kernel's locked state: cached
				// key cleared, per-box db closed) and re-validate: one rejection,
				// both lock states — the always-present-flag pin.
				await client.closeNotebook(enc.id);
				const lockedRow = (await client.listNotebooks()).notebooks.find(
					(n) => n.id === enc.id,
				);
				expect(lockedRow?.encrypted).toBe(true);
				expect(lockedRow?.unlocked).toBe(false);
				const locked = await validate();
				expect(locked.validKBs.has("enc-kb")).toBe(false);
				expect(
					locked.warnings.some((w) => w.includes("encrypted notebook")),
				).toBe(true);

				// The recovery path stays live: typed unlockAndOpenNotebook +
				// password re-mounts the box; the lsNotebooks row reports it
				// unlocked again (still encrypted — the flag never hides).
				await client.unlockAndOpenNotebook(enc.id, ENCRYPTED_PASSWORD);
				const reopened = (await client.listNotebooks()).notebooks.find(
					(n) => n.id === enc.id,
				);
				expect(reopened?.encrypted).toBe(true);
				expect(reopened?.unlocked).toBe(true);

				// No SQL from the extension ever targets the encrypted box: neither
				// validation pass issued a query (the box left the valid set, so no
				// tool can route there either).
				expect(counts.query, "validation issues no SQL").toBe(0);

				// Tool-level: kb_read on the encrypted KB is refused with zero
				// kernel round-trips.
				const breaker = new CircuitBreaker();
				const run = readRunner(locked, kernel, breaker);
				const before = { ...counts };
				const result = await run({ kb: "enc-kb" });
				expect(result.status).toBe("refused");
				expect(String(result.message)).toContain("enc-kb");
				for (const key of Object.keys(counts) as (keyof KernelCounts)[]) {
					expect(counts[key]).toBe(before[key]);
				}

				// The plain KB stays usable beside it (coexistence on one workspace).
				const plainResult = await run({ kb: "plain-kb", docId: plainDocId });
				expect(plainResult.status).toBe("ok");

				// Teardown: typed removeNotebook handles the encrypted box directly
				// (unmount + encrypted index removal) — no workspace disposal.
			} finally {
				await cleanup();
			}
			const remaining = (await client.listNotebooks()).notebooks.length;
			expect(remaining).toBe(baselineCount);
		},
	);

	it.skipIf(!THROTTLE_ENABLED)(
		"throttle pin: 6 bogus requests arm the lock, a kb call rides it, expiry self-heals",
		{ timeout: 1_500_000 },
		async () => {
			const fixtures: IntegrationFixtures = await setupFixtures();
			try {
				// The fixture pair is active (defaultKBs) before anything is
				// armed; validation ran clean inside setupFixtures.
				const marker = `throttle target ${fixtures.notebookIds.fixtureA}`;
				const docId = await mintDoc(
					client,
					fixtures.notebookIds.fixtureA,
					"/throttle target",
					`# throttle target\n\n${marker}`,
				);

				// Known-good call on a guarded endpoint: resets the kernel's
				// fail counter (successes clear it), so the arming sequence
				// starts from a clean counter. Rides the typed client — the
				// raw helper is only for the §10-sanctioned raw pins below.
				await client.listNotebooks();

				// 6 bogus-token requests; the 6th still returns 401. All throttle
				// legs use a guarded endpoint (lsNotebooks) — an unauthenticated
				// version probe would succeed with a bogus token and prove
				// nothing.
				for (let i = 0; i < 6; i++) {
					const res = await rawKernelCall(
						"/api/notebook/lsNotebooks",
						{},
						{
							token: `bogus-throttle-${i}`,
						},
					);
					expect(res.status).toBe(401);
				}

				// 7th bogus call: the distinct 429 class with Retry-After.
				const seventh = await rawKernelCall(
					"/api/notebook/lsNotebooks",
					{},
					{
						token: "bogus-throttle-6",
					},
				);
				expect(seventh.status).toBe(429);
				expect(seventh.headers.get("retry-after")).not.toBeNull();
				console.error(
					`[throttle] 7th served Retry-After: ${seventh.headers.get("retry-after")}`,
				);

				// 8th, correctly-authenticated call: the same 429 — the lock is
				// shared per-IP (the §5 two-session 3+3 case, exercised for
				// real). The genuine error arms the extension's cooldown.
				let served: SiYuanRateLimitError | undefined;
				try {
					await client.listNotebooks();
					expect.unreachable("the lock must 429 a correct token too");
				} catch (err) {
					expect(err).toBeInstanceOf(SiYuanRateLimitError);
					served = err as SiYuanRateLimitError;
				}
				expect(served?.retryAfterSeconds).toBeDefined();
				console.error(
					`[throttle] 8th (correct token) served Retry-After: ${served?.retryAfterSeconds}`,
				);

				// Extension cooldown leg: a kb call during the lock arms the
				// local cooldown (it receives the 429 and classifies it); the
				// next call inside the window is refused locally with zero
				// kernel round-trips.
				const breaker = new CircuitBreaker();
				const counts = zeroCounts();
				const kernel = countingKernel(client, counts);
				const run = readRunner(fixtures.validation, kernel, breaker);
				const armedAt = Date.now();
				const during = await run({ kb: "fixture-a", docId });
				expect(during.status).toBe("refused");
				expect(String(during.message)).toContain("429");
				expect(breaker.inCooldown()).toBe(true);
				// The during-call must have made exactly one kernel round-trip —
				// every extra 429'd call extends the lock a full generation.
				expect(counts.query).toBe(1);
				console.error(
					`[throttle] during-call served Retry-After: ${breaker.lastRetryAfterSeconds}`,
				);
				const afterDuring = { ...counts };
				const inside = await run({ kb: "fixture-a", docId });
				expect(inside.status).toBe("refused");
				for (const key of Object.keys(counts) as (keyof KernelCounts)[]) {
					expect(counts[key]).toBe(afterDuring[key]);
				}

				// Passive wait ≥ the final lock with ZERO kernel calls — any
				// request during the lock re-enters the throttle and extends it,
				// so a poll loop cannot terminate. The during-call's own 429 is
				// the last extension (the inside call is refused locally), and
				// each served Retry-After understates the final lock by one
				// extension generation — the floor accounts for that (see
				// THROTTLE_FINAL_LOCK_MS above).
				const lastServed =
					breaker.lastRetryAfterSeconds ?? THROTTLE_FINAL_LOCK_MS / 1000;
				await sleep(
					Math.max(
						THROTTLE_FINAL_LOCK_MS,
						2 * lastServed * 1000,
						breaker.cooldownUntil - Date.now(),
					) + SLEEP_MARGIN_MS,
				);
				console.error(
					`[throttle] wait done at +${((Date.now() - armedAt) / 1000).toFixed(0)}s after arming`,
				);

				// Post-expiry: the next call succeeds with no recovery step
				// (§5 self-healing expiry — no /kb, no re-validation). One bounded
				// recovery cycle covers an external auth-fail source on this IP
				// (another client's bad token re-arms the shared per-IP lock
				// during the blind wait — observed live once): sleep out the
				// served remainder and probe again. This is not the naive poll —
				// the sleep always lands past the served remaining time, so it
				// converges as soon as the external fails stop; if they continue,
				// no wait strategy can terminate and the case goes red naming the
				// external source.
				try {
					await client.listNotebooks();
				} catch (err) {
					if (!(err instanceof SiYuanRateLimitError)) throw err;
					const remaining = err.retryAfterSeconds ?? 0;
					console.error(
						`[throttle] first post-wait probe still locked (remaining ${remaining}s) — external extension suspected; one recovery wait`,
					);
					await sleep(remaining * 1000 + SLEEP_MARGIN_MS);
					await expect(client.listNotebooks()).resolves.toBeDefined();
				}
				const after = await run({ kb: "fixture-a", docId });
				expect(after.status).toBe("ok");
			} finally {
				await teardownToleratingLock(fixtures);
			}
		},
	);

	it.skipIf(!INTEGRATION)(
		"raw-DML hardening pin: the query endpoint cannot mutate siyuan.db; the tool still rejects the same statement",
		{ timeout: 120_000 },
		async () => {
			// Runs last (§10). The original case premise — a raw DELETE via
			// /api/query/sql without mode mutates siyuan.db, requiring a reindex
			// to bound the desync — died at 3.8.4: live probes show DML through
			// the query endpoint is a silent no-op in every mode (single,
			// mode:"multiple"; UPDATE included — code 0, row untouched, even a
			// same-connection DELETE-then-COUNT sees the row). The endpoint is
			// no longer a mutation vector, so the desync/reindex machinery has
			// no live trigger; the case pins the observed hardening plus the
			// tool-side rejection that still holds (deviation 9).
			const fixtures: IntegrationFixtures = await setupFixtures();
			try {
				const marker = `raw delete target ${fixtures.notebookIds.fixtureA}`;
				const docId = await mintDoc(
					client,
					fixtures.notebookIds.fixtureA,
					"/raw delete target",
					`# raw delete target\n\n${marker}`,
				);
				const rows = await client.query(
					`SELECT id, content FROM blocks WHERE root_id = ${sqlString(docId)} AND type = 'p' LIMIT 1`,
				);
				const blockId = rows[0]?.id as string;
				expect(blockId).toBeTruthy();

				// Tool-side: the same DELETE through kb_query is parser-rejected
				// with zero kernel calls (layer 1 — DML never leaves the tool).
				const counts = zeroCounts();
				const kernel = countingKernel(client, counts);
				const breaker = new CircuitBreaker();
				const run = readRunner(fixtures.validation, kernel, breaker);
				const before = { ...counts };
				const refused = await run({
					kb: "fixture-a",
					sql: `DELETE FROM blocks WHERE id = ${sqlString(blockId)}`,
				});
				expect(refused.status).toBe("refused");
				for (const key of Object.keys(counts) as (keyof KernelCounts)[]) {
					expect(counts[key]).toBe(before[key]);
				}

				// Raw side: the same DML via /api/query/sql (without mode, and
				// again under mode:"multiple") answers code 0 but does NOT mutate
				// siyuan.db — the 3.8.4 kernel hardens the endpoint by construction
				// (the defense-in-depth contrast with the 3.8.3 behavior the
				// design was written against; the client still sends
				// mode: "readonly", pinned in the client's suite).
				const deleteStmt = `DELETE FROM blocks WHERE id = ${sqlString(blockId)}`;
				const del = await rawKernelCall("/api/query/sql", { stmt: deleteStmt });
				expect(del.status).toBe(200);
				expect((del.body as { code?: number }).code).toBe(0);
				const multi = await rawKernelCall("/api/query/sql", {
					stmt: `SELECT 1; ${deleteStmt}`,
					mode: "multiple",
				});
				expect(multi.status).toBe(200);
				const still = await client.query(
					`SELECT COUNT(*) AS n FROM blocks WHERE id = ${sqlString(blockId)}`,
				);
				expect(Number(still[0]?.n)).toBe(1);
				// Consistency holds both ways: the index row survives and the tree
				// still serves the content — no desync, nothing to reindex. The
				// sanctioned rebuild (rebuildDataIndex) keeps no live trigger in
				// this suite at 3.8.4.
			} finally {
				await fixtures.teardown();
			}
		},
	);
});
