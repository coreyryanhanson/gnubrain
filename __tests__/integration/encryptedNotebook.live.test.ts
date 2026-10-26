// The encrypted-notebook tool-path case. The kernel-fact half (encrypted
// present and accurate in both lock states) and the branch that depends on
// it (resolveNotebooks) live in the primitives, falsified by their
// notebooks.live suite; what remains here is the tool surface: the startup
// rejection wording, the dropped-KB scope, zero SQL from validation, and
// zero round-trips on the refused tool call. Nothing in this file arms the
// kernel's per-IP lock, so its position is convention, not load-bearing.
// The case needs SIYUAN_ENCRYPTED_PASSWORD and an encryption-enabled
// workspace (the one-time enable is a user action in SiYuan's own UI — the
// extension never manages the key domain).
//
// Opt-in: SIYUAN_INTEGRATION=1. A kernel lock held by an external source
// still surfaces in beforeAll — the guard below names the self-heal.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	PINNED_SIYUAN_VERSION,
	SiYuanKernelClient,
	SiYuanRateLimitError,
} from "siyuan-kernel-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { globalSettingsPath, loadGnubrainSettings } from "../../settings.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import {
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";
import { BASE_URL, INTEGRATION, LIVE_TIMEOUT, TOKEN } from "./harness.js";

const ENCRYPTED_PASSWORD = process.env.SIYUAN_ENCRYPTED_PASSWORD ?? "";

interface KernelCounts {
	query: number;
	search: number;
	getChildBlocks: number;
}

const zeroCounts = (): KernelCounts => ({
	query: 0,
	search: 0,
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
		fullTextSearch: async (
			p: Parameters<SiYuanKernelClient["fullTextSearch"]>[0],
		) => {
			counts.search += 1;
			return client.fullTextSearch(p);
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

describe.skipIf(!INTEGRATION || TOKEN === "")("encrypted-notebook", () => {
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
		"encrypted-notebook tool path: startup rejection names the KB in both lock states, the plain KB validates clean, zero kernel calls from the encrypted KB",
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
				// the plain KB validates clean alongside. (The row facts —
				// encrypted:true in both lock states — are pinned in the
				// primitives' notebooks.live suite beside resolveNotebooks.)
				const unlocked = await validate();
				expect(unlocked.validKBs.has("enc-kb")).toBe(false);
				expect(unlocked.validKBs.has("plain-kb")).toBe(true);
				expect(
					unlocked.warnings.some(
						(w) => w.includes("enc-kb") && w.includes("encrypted notebook"),
					),
				).toBe(true);

				// Lock it (typed closeNotebook — the kernel's locked state) and
				// re-validate: one rejection, both lock states — one problem kind
				// covers both, so the wording never branches on the lock.
				await client.closeNotebook(enc.id);
				const locked = await validate();
				expect(locked.validKBs.has("enc-kb")).toBe(false);
				expect(
					locked.warnings.some((w) => w.includes("encrypted notebook")),
				).toBe(true);

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
});
