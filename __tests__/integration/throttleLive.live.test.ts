// Encrypted-notebook + raw-DML-hardening cases. The throttle pin lives in
// the primitives live suite: the kernel lock schedule is pin-owning-repo
// knowledge, and the extension-cooldown leg is gnubrain surface primitives
// cannot reach — its refusal branches are pinned by gate.test.ts against a
// stubbed SiYuanRateLimitError, and the real-429 leg (minimal arming, same
// THROTTLE flag) lives in breaker.live.test.ts, sequenced after this file.
// Nothing in this file arms the kernel's per-IP lock, so this file's
// position is convention, not load-bearing. The encrypted case needs
// SIYUAN_ENCRYPTED_PASSWORD and an encryption-enabled workspace (the
// one-time enable is a user action in SiYuan's own UI — the extension never
// manages the key domain).
//
// Opt-in: SIYUAN_INTEGRATION=1. A kernel lock held by an external source
// still surfaces in beforeAll — the guard below names the self-heal.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	PINNED_SIYUAN_VERSION,
	SiYuanKernelClient,
	SiYuanRateLimitError,
	sqlString,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { globalSettingsPath, loadGnubrainSettings } from "../../settings.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import {
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";
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

const ENCRYPTED_PASSWORD = process.env.SIYUAN_ENCRYPTED_PASSWORD ?? "";

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
	const { pi, runToolDetails } = createFakePi();
	registerReadToolsAndToolset(pi, {
		getValidation: () => validation,
		getKernel: () => kernel,
		breaker,
		baselines: ContentBaselines.create(),
	});
	const { ctx } = createFakeCtx();
	return async (params) => runToolDetails("kb_read", params, ctx);
}

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"raw-DML hardening / encrypted-notebook",
	() => {
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

		it.skipIf(!INTEGRATION)(
			"raw-DML hardening pin: the query endpoint cannot mutate siyuan.db; the tool still rejects the same statement",
			{ timeout: 120_000 },
			async () => {
				// Runs last. The original case premise — a raw DELETE via
				// /api/query/sql without mode mutates siyuan.db, requiring a reindex
				// to bound the desync — died at 3.8.4: live probes show DML through
				// the query endpoint is a silent no-op in every mode (single,
				// mode:"multiple"; UPDATE included — code 0, row untouched, even a
				// same-connection DELETE-then-COUNT sees the row). The endpoint is
				// no longer a mutation vector, so the desync/reindex machinery has
				// no live trigger; the case pins the observed hardening plus the
				// tool-side rejection that still holds.
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
					const del = await rawKernelCall("/api/query/sql", {
						stmt: deleteStmt,
					});
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
	},
);
