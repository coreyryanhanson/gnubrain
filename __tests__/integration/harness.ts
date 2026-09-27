// Integration-suite harness (runs against the live pinned kernel,
// opt-in with SIYUAN_INTEGRATION=1, never in CI). Three pieces:
//
// 1. Fixture→settings wiring — two disposable notebooks minted per run,
//    injected in memory through the settings-load seam (loadGnubrainSettings
//    with an in-memory readFile; the user's settings files are never read or
//    written). The temp-HOME seeding serializes the same object via
//    buildFixtureSettings.
// 2. Setup pins — kernel version exactly equals the pin (accidental upgrade →
//    red suite), teardown asserts the notebook count back to baseline
//    (zero strays).
// 3. Test-only raw-kernel-call helper — raw DELETE and bogus-token arming
//    deliberately stay outside the typed client;
//    every notebook/doc lifecycle call rides the typed client.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { expect } from "vitest";
import {
	PINNED_SIYUAN_VERSION,
	ownership,
	SiYuanKernelClient,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import {
	globalSettingsPath,
	loadGnubrainSettings,
	type GnubrainSettings,
} from "../../settings.js";
import {
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

/** First heading with exactly this content under a doc — the walk lookup
 * every write-path live case shares. */
export function heading(walk: WalkedBlock[], content: string): WalkedBlock {
	const h = walk.find((b) => b.type === "h" && b.content === content);
	expect(h, `heading '${content}' in walk`).toBeDefined();
	return h!;
}

/** The repo root without a trailing slash — the local path-package entry
 * the temp-HOME seeded settings.json `packages` list carries: the child pi
 * loads the extension through the real install mechanism, not a test seam,
 * so the extension runs unmodified and reads its fixed global path. */
export const REPO_ROOT = fileURLToPath(
	new URL("../..", import.meta.url),
).replace(/\/$/, "");

if (INTEGRATION && BASE_URL === "") {
	throw new Error(
		"SIYUAN_INTEGRATION=1 requires SIYUAN_BASE_URL (the live kernel origin) — the harness bakes in no default",
	);
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
		async () => (await ownership(client, boxId, docId)) !== undefined,
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

// --- headless `pi -p` harness (shared by the gate + headless live files) ---

export interface HeadlessEvent {
	type: string;
	entry?: { type: string; customType?: string; data?: unknown };
	message?: { role?: string };
}

/** Seed the pinned global settings path under a temp HOME — the exact file
 * shape the extension reads by construction. */
export function seedHome(
	home: string,
	settings: unknown,
	packages: string[],
): void {
	mkdirSync(dirname(globalSettingsPath(home)), { recursive: true });
	writeFileSync(
		globalSettingsPath(home),
		JSON.stringify({ packages, gnubrain: settings }),
	);
}

let seedSeq = 0;

/** Seed a pi session file with custom entries — the persisted state a
 * prior session would carry. Needed because pi's flush guard never writes
 * a session file that saw no assistant message, and pure command dispatches
 * produce none — so a --session <id> lookup on a command-only child run
 * finds nothing. The seeded entries use exactly the shapes appendEntry
 * writes (kb-scope snapshots; toolset-state pins), and the resumed child
 * runs the real restore machinery unmodified. */
export function seedSession(
	home: string,
	cwd: string,
	entries: { customType: string; data: unknown }[],
): string {
	const path = `${home}/seed-session-${++seedSeq}.jsonl`;
	const ts = new Date().toISOString();
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: crypto.randomUUID(),
			timestamp: ts,
			cwd,
		}),
	];
	for (const e of entries) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: e.customType,
				data: e.data,
				id: crypto.randomUUID().slice(0, 8),
				parentId: null,
				timestamp: ts,
			}),
		);
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** Spawn one headless pi run and parse its JSON event stream. PI_TOOLMASKING_DEFER
 * is stripped: when the suite itself runs under a pi parent (agent-driven
 * live runs), the parent's child-defer signal would be inherited and the
 * child would defer toolset-mask enforcement — a test-harness artifact, not
 * product behavior (an interactive user run has no such var; masking
 * enforces). Empty string = enforce, per pi-tool-masking's fail-closed
 * foreign-var check. */
export function runHeadlessPi(
	args: string[],
	env: Record<string, string>,
	cwd: string,
	opts: { timeoutMs?: number } = {},
): { events: HeadlessEvent[] } {
	const run = spawnSync("pi", ["-p", "--mode", "json", ...args], {
		env: { ...process.env, ...env, PI_TOOLMASKING_DEFER: "" } as Record<
			string,
			string
		>,
		cwd,
		encoding: "utf8",
		timeout: opts.timeoutMs ?? 120_000,
	});
	expect(run.error).toBeUndefined();
	expect(run.status).toBe(0);
	expect(run.stderr).not.toMatch(/error/i);
	const lines = String(run.stdout).split("\n");
	const header = JSON.parse(lines[0] as string) as { type: string };
	expect(header.type).toBe("session");
	const events = lines
		.slice(1)
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as HeadlessEvent);
	return { events };
}

/** The kb-scope snapshots appended during a run, in order. */
export function scopeEntries(events: HeadlessEvent[]): unknown[] {
	return events
		.filter(
			(e) =>
				e.type === "entry_appended" &&
				e.entry?.type === "custom" &&
				e.entry.customType === "kb-scope",
		)
		.map((e) => e.entry?.data);
}

export interface IntegrationFixtures {
	client: SiYuanKernelClient;
	/** The fixture settings object — the headless tests seed a temp HOME with it. */
	settings: GnubrainSettings;
	/** Full startup validation over the real kernel, scope = both fixtures. */
	validation: SessionValidation;
	notebookIds: { fixtureA: string; fixtureB: string };
	/** Removes both fixtures (typed client) and asserts the notebook count is
	 * back to the setup baseline — zero strays. */
	teardown(): Promise<void>;
}

/** The fixture settings shape, shared by every consumer that needs it: the
 * in-memory settings seam (setupFixtures) and the temp-HOME seeding
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

	// Two notebooks, not one: the multi-KB pins need a deterministic
	// two-KB workspace, not fixture + live notebooks.
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	const fixtureA = await client.createNotebook(`gnubrain-it-a-${stamp}`);
	const fixtureB = await client.createNotebook(`gnubrain-it-b-${stamp}`);
	await client.openNotebook(fixtureA.id);
	await client.openNotebook(fixtureB.id);

	const settings = buildFixtureSettings(fixtureA.id, fixtureB.id);

	// The temp-HOME seeding serializes this same object (buildFixtureSettings).
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
	if (validation.probe.verdict !== "ok") {
		throw new Error(
			`kernel probe verdict is '${validation.probe.verdict}' — expected 'ok' against the pin`,
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
