// Sprint 6 gate — the scripted live checks for items 1, 2, 3 and 5 (the
// manual residuals — TTY write-confirm, status-slot visibility — stay with
// the operator by design, §10). Two layers:
//
// - Items 1–3 run real `pi -p` child sessions under a temp HOME seeded with
//   the fixture settings (the item 11 pattern): a probe extension dumps
//   pi.getAllTools()/getActiveTools() to a file so the tool-registration and
//   masking asserts are mechanical, never eyeballed; seeded session files
//   (seedSession below) put the resumed child through the real restore path.
// - Item 5 (auth breaker) runs in-process over the live kernel through the
//   register(pi, deps) seam, with a token-rotating client wrapper so the
//   per-call 401s are genuine kernel rejections (the field scenario the
//   breaker exists for: a token that validates at startup but is rejected
//   mid-session). The zero-further-kernel-calls property is observed here
//   via the call-counting wrapper (it cannot be observed in an interactive
//   session — no extension request log — where only the refused-vs-auth-error
//   signature is visible; the counting-fetch pin itself stays unit-only).
//
// Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import register, { type GnubrainDeps } from "../../index.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import {
	BASE_URL,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

/** The child pi loads extensions through the real install mechanism — the
 * repos listed under `packages` in the seeded settings.json — not a test
 * seam, so the extension runs unmodified and reads its fixed global path. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(
	/\/$/,
	"",
);

interface HeadlessEvent {
	type: string;
	entry?: { type: string; customType?: string; data?: unknown };
	message?: { role?: string };
}

interface ToolDump {
	all: { name: string; path: string | null }[];
	active: string[];
}

/** A probe extension that dumps tool registration state to a file — the
 * mechanical enumerate-pi.getAllTools() check the gate item names. */
const PROBE_SOURCE = `
export default function (pi) {
	pi.registerCommand("tools-dump", {
		description: "dump tool registration state (gate probe)",
		handler: async () => {
			const fs = await import("node:fs");
			const all = pi.getAllTools().map((t) => ({
				name: t.name,
				path: t.sourceInfo?.path ?? null,
			}));
			fs.writeFileSync(
				process.env.GNUBRAIN_PROBE_OUT ?? "/dev/null",
				JSON.stringify({ all, active: pi.getActiveTools() }),
			);
		},
	});
}
`;

/** Seed a pi session file with one custom entry — the persisted state a
 * prior session would carry. Needed because pi's flush guard never writes
 * a session file that saw no assistant message, and pure command dispatches
 * (every gate prompt here) produce none — so a --session <id> lookup on a
 * command-only child run finds nothing. The seeded entries use exactly the
 * shapes appendEntry writes (kb-scope snapshots — item 11's stream evidence;
 * toolset-state pins — pi-tool-masking's appendEntry(spec.persistKey,
 * {enabled})); the resumed child runs the real restore machinery unmodified. */
let seedSeq = 0;
function seedSession(
	home: string,
	cwd: string,
	entries: { customType: string; data: unknown }[],
): string {
	const path = `${home}/seed-session-${++seedSeq}.jsonl`;
	const ts = new Date().toISOString();
	const header = {
		type: "session",
		version: 3,
		id: crypto.randomUUID(),
		timestamp: ts,
		cwd,
	};
	const lines = [JSON.stringify(header)];
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

/** Spawn one headless pi run and parse its JSON event stream. */
function runPi(
	args: string[],
	env: Record<string, string>,
	cwd: string,
): { events: HeadlessEvent[] } {
	const run = spawnSync("pi", ["-p", "--mode", "json", ...args], {
		env: gateEnv(env),
		cwd,
		encoding: "utf8",
		timeout: 120_000,
	});
	expect(run.error).toBeUndefined();
	expect(run.status).toBe(0);
	expect(run.stderr).not.toMatch(/error/i);
	const lines = String(run.stdout).split("\n");
	const header = JSON.parse(lines[0] as string) as {
		type: string;
		id: string;
	};
	expect(header.type).toBe("session");
	const events = lines
		.slice(1)
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as HeadlessEvent);
	return { events };
}

/** The kb-scope snapshots appended during a run, in order. */
function scopeEntries(events: HeadlessEvent[]): unknown[] {
	return events
		.filter(
			(e) =>
				e.type === "entry_appended" &&
				e.entry?.type === "custom" &&
				e.entry.customType === "kb-scope",
		)
		.map((e) => e.entry?.data);
}

function seedHome(home: string, settings: unknown, packages: string[]): void {
	mkdirSync(`${home}/.pi/agent`, { recursive: true });
	writeFileSync(
		`${home}/.pi/agent/settings.json`,
		JSON.stringify({ packages, gnubrain: settings }),
	);
}

/** Child env for the gate's pi runs. PI_TOOLMASKING_DEFER is stripped: when
 * the suite itself runs under a pi parent (agent-driven gate runs), the
 * parent's child-defer signal would be inherited and the child would defer
 * toolset-mask enforcement — a test-harness artifact, not product behavior
 * (an interactive user run has no such var; masking enforces). Empty string
 * = enforce, per pi-tool-masking's fail-closed foreign-var check. */
function gateEnv(overrides: Record<string, string>): Record<string, string> {
	return { ...process.env, ...overrides, PI_TOOLMASKING_DEFER: "" } as Record<
		string,
		string
	>;
}

describe.skipIf(!INTEGRATION || TOKEN === "")("sprint 6 gate (live)", () => {
	let fixtures: IntegrationFixtures;
	beforeAll(async () => {
		fixtures = await setupFixtures();
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	// ---------------------------------------------------------------
	// Item 1 — tools callable from pi: registered, active, unshadowed;
	// /kb tools masking live; toolset state survives session resume.
	// ---------------------------------------------------------------
	it(
		"item 1: all four kb tools + unshadowed builtins; /kb tools read masks kb_write; state survives resume",
		{ timeout: 480_000 },
		() => {
			const home = mkdtempSync(`${tmpdir()}/gnubrain-gate-home-`);
			const cwd = mkdtempSync(`${tmpdir()}/gnubrain-gate-cwd-`);
			const probeDir = mkdtempSync(`${tmpdir()}/gnubrain-gate-probe-`);
			const dumpPath = `${home}/tools-dump.json`;
			try {
				seedHome(home, fixtures.settings, [REPO_ROOT, probeDir]);
				writeFileSync(`${probeDir}/index.ts`, PROBE_SOURCE);

				const readDump = (): ToolDump =>
					JSON.parse(readFileSync(dumpPath, "utf8")) as ToolDump;
				const env = { HOME: home, GNUBRAIN_PROBE_OUT: dumpPath };

				// Run 1: fresh in-memory session — probe the default
				// registration state (--no-session; a resume seed isn't needed
				// for the default state: both toolsets default-enable).
				const first = runPi(["--no-session", "/tools-dump"], env, cwd);
				const initial = readDump();
				const names = initial.all.map((t) => t.name);
				// All four kb tools registered, sourced from this repo (not
				// builtins), and active (both toolsets default-enabled).
				for (const kb of ["kb_query", "kb_search", "kb_read", "kb_write"]) {
					expect(names).toContain(kb);
				}
				// The collision check: the builtins survive alongside the kb_
				// names — present, and no duplicate tool names exist (a shadowed
				// builtin would surface as two entries for one name).
				expect(names).toContain("read");
				expect(names).toContain("write");
				expect(new Set(names).size).toBe(names.length);
				for (const t of initial.all) {
					if (t.name.startsWith("kb_")) {
						// sourceInfo.path is the package root (a local path package
						// is added to settings without copying) — not a builtin.
						expect(t.path?.startsWith(REPO_ROOT)).toBe(true);
					}
				}
				for (const kb of ["kb_query", "kb_search", "kb_read", "kb_write"]) {
					expect(initial.active).toContain(kb);
				}
				// Command dispatches, not LLM round-trips.
				expect(first.events.some((e) => e.message?.role === "assistant")).toBe(
					false,
				);

				// Runs 2–4: resumed seeds. The mask pin is the persisted shape
				// pi-tool-masking's /kb tools write appends; run 2 resumes with
				// reads already toggled off (the state a prior /kb tools read
				// session would have persisted), run 3 resumes from it again to
				// prove the restore re-applies, run 4 resumes from a clean seed
				// and re-enables writes via the real /kb tools write verb.
				const readOffSeed = seedSession(home, cwd, [
					{
						customType: "toolset-state:gnubrain.write",
						data: { enabled: false },
					},
				]);
				runPi(["--session", readOffSeed, "/tools-dump"], env, cwd);
				const readOnly = readDump();
				expect(readOnly.active).not.toContain("kb_write");
				for (const name of [
					"kb_read",
					"kb_query",
					"kb_search",
					"read",
					"write",
				]) {
					expect(readOnly.active).toContain(name);
				}

				runPi(["--session", readOffSeed, "/tools-dump"], env, cwd);
				expect(readDump().active).not.toContain("kb_write");

				const cleanSeed = seedSession(home, cwd, []);
				runPi(
					["--session", cleanSeed, "/kb tools write", "/tools-dump"],
					env,
					cwd,
				);
				expect(readDump().active).toContain("kb_write");
			} finally {
				for (const dir of [home, cwd, probeDir]) {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		},
	);

	// ---------------------------------------------------------------
	// Item 2 — scope survives session restart: the resumed session
	// resolves scope from the persisted kb-scope entry (seeded in the
	// exact shape appendEntry writes — item 11's stream evidence — and
	// restored by the real resume machinery). Discriminator: the
	// idempotent-toggle skip. Toggling an already-off KB must NOT append
	// a snapshot — which only happens if the resumed session read the
	// persisted entry; a fall back to defaultKBs (both fixtures) would
	// see the KB as active and append a fresh snapshot.
	// ---------------------------------------------------------------
	it(
		"item 2: scope survives session restart (resume reads the persisted entry)",
		{ timeout: 300_000 },
		() => {
			const home = mkdtempSync(`${tmpdir()}/gnubrain-gate-home-`);
			const cwd = mkdtempSync(`${tmpdir()}/gnubrain-gate-cwd-`);
			try {
				seedHome(home, fixtures.settings, [REPO_ROOT]);
				const env = { HOME: home };

				// A session whose persisted scope is [fixture-b] — the state
				// after a prior session's /kb fixture-a off.
				const seed = seedSession(home, cwd, [
					{ customType: "kb-scope", data: { active: ["fixture-b"] } },
				]);

				// Resume: re-issue the same toggle. Idempotent no-op — no
				// snapshot appended, because scope came from the persisted entry.
				const resumed = runPi(
					["--session", seed, "/kb fixture-a off"],
					env,
					cwd,
				);
				expect(scopeEntries(resumed.events)).toEqual([]);

				// Control: the still-active KB toggles fine in the same resumed
				// session (proving the no-op above is scope-derived, not a dead
				// command path) and appends the full post-toggle snapshot.
				const toggled = runPi(
					["--session", seed, "/kb fixture-b off"],
					env,
					cwd,
				);
				expect(scopeEntries(toggled.events)).toEqual([{ active: [] }]);
			} finally {
				for (const dir of [home, cwd]) {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		},
	);

	// ---------------------------------------------------------------
	// Item 3 — /kb <name> on and /kb all off land mid-session: several
	// command dispatches inside ONE pi -p process (same live session, no
	// restart between), each appending its full post-toggle snapshot.
	// ---------------------------------------------------------------
	it(
		"item 3: /kb <name> on and /kb all off land mid-session",
		{ timeout: 300_000 },
		() => {
			const home = mkdtempSync(`${tmpdir()}/gnubrain-gate-home-`);
			const cwd = mkdtempSync(`${tmpdir()}/gnubrain-gate-cwd-`);
			try {
				seedHome(home, fixtures.settings, [REPO_ROOT]);
				const { events } = runPi(
					["/kb fixture-a off", "/kb all off", "/kb fixture-a on"],
					{ HOME: home },
					cwd,
				);
				// Full post-toggle snapshots, in dispatch order, same process:
				// [a,b] → a off → [b]; all off → []; a on → [a].
				expect(scopeEntries(events)).toEqual([
					{ active: ["fixture-b"] },
					{ active: [] },
					{ active: ["fixture-a"] },
				]);
			} finally {
				for (const dir of [home, cwd]) {
					rmSync(dir, { recursive: true, force: true });
				}
			}
		},
	);

	// ---------------------------------------------------------------
	// Item 5 — auth breaker, live: a token that validates at startup but
	// is rejected per-call (rotation = the field scenario) feeds the
	// breaker; the tripping read returns refused with the breaker message
	// (Sprint 1 semantics: the 3rd consecutive failure returns the local
	// refusal, not the auth error), post-trip reads refuse locally with
	// ZERO kernel round-trips, and /kb recovery with the corrected token
	// restores reads immediately.
	// ---------------------------------------------------------------
	it("item 5: auth breaker trips on live 401s, refuses locally, recovers via /kb", async () => {
		const { pi, fire, runCommand, runTool } = createFakePi();
		const docId = await mintDoc(
			fixtures.client,
			fixtures.notebookIds.fixtureA,
			"/gate-breaker",
			"breaker recovery target",
		);

		let stale = false;
		const calls: string[] = [];
		const globalSettings = JSON.stringify({ gnubrain: fixtures.settings });
		const deps: GnubrainDeps = {
			readFile: async (path: string) => {
				if (path.startsWith("/project")) {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				}
				return globalSettings;
			},
			// Token-rotating client factory: validation always rides the real
			// token; tool calls ride a stale token while `stale` is set — the
			// 401s below are genuine live kernel rejections.
			createClient: () =>
				new Proxy({} as SiYuanKernelClient, {
					get(_t, prop) {
						if (prop === "baseUrl") return BASE_URL;
						return async (...args: unknown[]) => {
							calls.push(String(prop));
							const target = stale
								? new SiYuanKernelClient(BASE_URL, "gnubrain-gate-bogus-token")
								: fixtures.client;
							const fn = Reflect.get(target as object, prop) as (
								...a: unknown[]
							) => unknown;
							return fn.apply(target, args);
						};
					},
				}),
		};
		register(pi, deps);
		const { ctx } = createFakeCtx({ cwd: "/project" });
		await fire("session_start", ctx);

		const read = async () =>
			(await runTool("kb_read", { kb: "fixture-a", docId }, ctx)).details as {
				status: string;
				message: string;
			};

		// Mid-session rotation: startup validated with the real token; from
		// here the client rides the stale token.
		stale = true;
		// Reads 1–2: genuine 401s surface as auth errors and feed the breaker.
		const first = await read();
		expect(first.status).toBe("error");
		expect(first.message).toMatch(/auth/i);
		const second = await read();
		expect(second.status).toBe("error");
		expect(second.message).toMatch(/auth/i);
		expect(calls.length).toBeGreaterThanOrEqual(2);

		// The tripping read returns the local refusal, not an auth error.
		const tripping = await read();
		expect(tripping.status).toBe("refused");
		expect(tripping.message).toContain("circuit breaker");

		// Post-trip: refused locally with zero kernel round-trips.
		calls.length = 0;
		const fourth = await read();
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
		const recovered = await read();
		expect(recovered.status).toBe("ok");
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});
});
