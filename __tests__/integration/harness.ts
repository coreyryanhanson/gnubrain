// Sprint 5b integration-suite harness (runs against the live pinned kernel,
// opt-in with SIYUAN_INTEGRATION=1, never in CI). Three pieces:
//
// 1. Fixture→settings wiring — two disposable notebooks minted per run,
//    injected in memory through S1's settings-load seam (loadGnubrainSettings
//    with an in-memory readFile; the user's settings files are never read or
//    written). Item 11's temp-HOME seeding serializes the same object via
//    buildFixtureSettings.
// 2. Setup pins — kernel version exactly equals the pin (accidental upgrade →
//    red suite), teardown asserts the notebook count back to baseline
//    (zero strays).
// 3. Test-only raw-kernel-call helper — raw DELETE, the reindex trigger, and
//    bogus-token arming deliberately stay outside the typed client (§10);
//    every notebook/doc lifecycle call rides the typed client.

import { SiYuanKernelClient } from "siyuan-kernel-api";
import { ownershipStmt } from "../../kernel.js";
import {
	globalSettingsPath,
	loadGnubrainSettings,
	type GnubrainSettings,
} from "../../settings.js";
import {
	PINNED_SIYUAN_VERSION,
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";

export const INTEGRATION = process.env.SIYUAN_INTEGRATION === "1";
/** The live kernel origin is operator config — no default is baked in.
 * Required via SIYUAN_BASE_URL whenever the suite actually runs. */
export const BASE_URL = process.env.SIYUAN_BASE_URL ?? "";
export const TOKEN = process.env.SIYUAN_API_TOKEN ?? "";
/** Live round-trips + fixture-mint polling run well past the unit budget. */
export const LIVE_TIMEOUT = 30_000;

if (INTEGRATION && BASE_URL === "") {
	throw new Error(
		"SIYUAN_INTEGRATION=1 requires SIYUAN_BASE_URL (the live kernel origin) — the harness bakes in no default",
	);
}

/** Raw direct kernel call — a POST fetch with a Token header, bypassing the
 * typed client entirely. `token` override is what bogus-token arming uses. */
export interface RawKernelResult {
	status: number;
	headers: Headers;
	/** Parsed JSON body when parseable, undefined otherwise (throttle/lock
	 * responses may carry non-JSON bodies). */
	body: unknown;
}

export async function rawKernelCall(
	path: string,
	body: unknown,
	opts: { token?: string; baseUrl?: string } = {},
): Promise<RawKernelResult> {
	const res = await fetch(`${opts.baseUrl ?? BASE_URL}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Token ${opts.token ?? TOKEN}`,
		},
		body: JSON.stringify(body ?? {}),
	});
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		// non-JSON body (e.g. a throttle response) — status/headers still speak
	}
	return { status: res.status, headers: res.headers, body: parsed };
}

/** The sanctioned full-index rebuild (`/api/system/rebuildDataIndex` →
 * FullReindex) — bounds the siyuan.db desync the raw-DELETE case leaves.
 * Fire-and-forget at the kernel (task-queued server-side); a case needing
 * convergence polls its own assertions after calling this. */
export async function reindexKernel(opts?: {
	token?: string;
	baseUrl?: string;
}): Promise<RawKernelResult> {
	return rawKernelCall("/api/system/rebuildDataIndex", {}, opts);
}

// --- live-case helpers (shared by the 5b case files) ---

/** Poll a condition with a deadline — the bounded-wait shape every
 * async-index case uses (blocks index, full-text index). */
export async function pollUntil(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline) throw new Error(`${label} never became true`);
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** Poll the SQL blocks index until a minted doc is queryable — the tool
 * flows' ownership/guard queries ride that index, which lags
 * createDocWithMarkdown. */
export async function awaitIndexed(
	client: SiYuanKernelClient,
	boxId: string,
	docId: string,
	timeoutMs = 10_000,
): Promise<void> {
	await pollUntil(
		`fixture doc ${docId} reaching the blocks index`,
		async () => (await client.query(ownershipStmt(boxId, docId))).length > 0,
		timeoutMs,
	);
}

/** Mint a fixture doc (path includes the leading `/`) and wait for the
 * blocks index — the shape every fixture case starts from. */
export async function mintDoc(
	client: SiYuanKernelClient,
	notebookId: string,
	path: string,
	markdown: string,
): Promise<string> {
	const docId = await client.createDocWithMarkdown({
		notebook: notebookId,
		path,
		markdown,
	});
	await awaitIndexed(client, notebookId, docId);
	return docId;
}

/** Poll the full-text index until a search term surfaces the expected hit
 * count across the given boxes (the index lags the blocks index). */
export async function awaitSearchable(
	client: SiYuanKernelClient,
	boxIds: string[],
	query: string,
	minHits: number,
	timeoutMs = 15_000,
): Promise<void> {
	await pollUntil(
		`search index surfacing ${minHits} hits for '${query}'`,
		async () => {
			const result = await client.search({
				query,
				paths: boxIds,
				pageSize: 64,
			});
			return result.blocks.length >= minHits;
		},
		timeoutMs,
	);
}

export interface IntegrationFixtures {
	client: SiYuanKernelClient;
	/** The fixture settings object — item 11 seeds a temp HOME with it. */
	settings: GnubrainSettings;
	/** Full startup validation over the real kernel, scope = both fixtures. */
	validation: SessionValidation;
	notebookIds: { fixtureA: string; fixtureB: string };
	/** Removes both fixtures (typed client) and asserts the notebook count is
	 * back to the setup baseline — zero strays. */
	teardown(): Promise<void>;
}

/** The fixture settings shape, shared by every consumer that needs it: the
 * in-memory settings seam (setupFixtures) and item 11's temp-HOME seeding
 * (separate `pi -p` process — serialize this same object into
 * <tempHome>/.pi/agent/settings.json). */
export function buildFixtureSettings(
	fixtureAId: string,
	fixtureBId: string,
): GnubrainSettings {
	return {
		baseUrl: BASE_URL,
		apiToken: TOKEN,
		kbs: [
			{ name: "fixture-a", notebook: fixtureAId },
			{ name: "fixture-b", notebook: fixtureBId },
		],
		defaultKBs: ["fixture-a", "fixture-b"],
		allowUnattendedWrites: true,
	};
}

export async function setupFixtures(): Promise<IntegrationFixtures> {
	if (!INTEGRATION || TOKEN === "") {
		throw new Error("setupFixtures called outside a live integration run");
	}
	const client = new SiYuanKernelClient(BASE_URL, TOKEN);

	// Pin: the kernel must report the exact version (accidental upgrade → red).
	const version = await client.getVersion();
	if (version !== PINNED_SIYUAN_VERSION) {
		throw new Error(
			`kernel version ${version} does not match the pin ${PINNED_SIYUAN_VERSION} — re-pin or investigate before running the suite`,
		);
	}

	const baselineCount = (await client.listNotebooks()).notebooks.length;

	// Two notebooks, not one (§10): the multi-KB pins need a deterministic
	// two-KB workspace, not fixture + live notebooks.
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	const fixtureA = await client.createNotebook(`gnubrain-it-a-${stamp}`);
	const fixtureB = await client.createNotebook(`gnubrain-it-b-${stamp}`);
	await client.openNotebook(fixtureA.id);
	await client.openNotebook(fixtureB.id);

	const settings = buildFixtureSettings(fixtureA.id, fixtureB.id);

	// Item 11's temp-HOME seeding serializes this same object (buildFixtureSettings).
	const settingsText = JSON.stringify({ gnubrain: settings });
	const loaded = await loadGnubrainSettings(
		async () => settingsText,
		globalSettingsPath("/gnubrain-it-fake-home"),
		undefined,
	);

	const validation = await runSessionValidation({
		loaded,
		kernel: client,
	});
	if (validation.settings === undefined || validation.shapeErrors.length > 0) {
		throw new Error(
			`fixture settings failed shape validation: ${validation.shapeErrors.join("; ")}`,
		);
	}
	if (validation.probe !== "ok") {
		throw new Error(
			`kernel probe verdict is '${validation.probe}' (version ${validation.kernelVersion}) — expected 'ok' against the pin`,
		);
	}
	for (const name of ["fixture-a", "fixture-b"] as const) {
		if (!validation.validKBs.has(name)) {
			throw new Error(
				`KB '${name}' did not validate (warnings: ${validation.warnings.join("; ")})`,
			);
		}
	}
	if (
		validation.scope.length !== 2 ||
		!validation.scope.includes("fixture-a") ||
		!validation.scope.includes("fixture-b")
	) {
		throw new Error(
			`scope is [${validation.scope.join(", ")}] — expected both fixtures active via defaultKBs`,
		);
	}

	return {
		client,
		settings,
		validation,
		notebookIds: { fixtureA: fixtureA.id, fixtureB: fixtureB.id },
		async teardown(): Promise<void> {
			const failures: string[] = [];
			for (const id of [fixtureA.id, fixtureB.id]) {
				try {
					await client.removeNotebook(id);
				} catch (err) {
					// Attempt both removals; report after, never mask a pin failure.
					failures.push(
						`removeNotebook(${id}) failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const remaining = (await client.listNotebooks()).notebooks;
			const strays = remaining.filter(
				(n) => n.id === fixtureA.id || n.id === fixtureB.id,
			);
			if (strays.length > 0 || failures.length > 0) {
				throw new Error(
					`teardown left strays: ${strays.map((s) => s.id).join(", ") || "none"} — ${failures.join("; ") || "removals reported success"}`,
				);
			}
			if (remaining.length !== baselineCount) {
				throw new Error(
					`post-teardown notebook count ${remaining.length} != baseline ${baselineCount} — unexpected notebook set changed during the run`,
				);
			}
		},
	};
}
