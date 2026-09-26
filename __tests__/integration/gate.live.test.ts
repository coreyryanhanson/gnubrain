// Scripted live checks for tool masking and scope persistence (the manual
// residuals — TTY write-grant, status-slot visibility — stay with the
// operator by design). The cases run real `pi -p` child sessions under a
// temp HOME seeded with the fixture settings: a probe extension dumps
// pi.getAllTools()/getActiveTools() to a file so the tool-registration and
// masking asserts are mechanical, never eyeballed; seeded session files
// (harness seedSession) put the resumed child through the real restore path.
//
// Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	REPO_ROOT,
	TOKEN,
	runHeadlessPi,
	scopeEntries,
	seedHome,
	seedSession,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

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
	// Tools callable from pi: registered, active, unshadowed;
	// /kb tools masking live; toolset state survives session resume.
	// ---------------------------------------------------------------
	it(
		"all four kb tools + unshadowed builtins; /kb tools read masks kb_write; state survives resume",
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
				const first = runHeadlessPi(["--no-session", "/tools-dump"], env, cwd);
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
				runHeadlessPi(["--session", readOffSeed, "/tools-dump"], env, cwd);
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

				runHeadlessPi(["--session", readOffSeed, "/tools-dump"], env, cwd);
				expect(readDump().active).not.toContain("kb_write");

				const cleanSeed = seedSession(home, cwd, []);
				runHeadlessPi(
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
	// Scope survives session restart: the resumed session
	// resolves scope from the persisted kb-scope entry (seeded in the
	// exact shape appendEntry writes — the headless test's stream evidence — and
	// restored by the real resume machinery). Discriminator: the
	// idempotent-toggle skip. Toggling an already-off KB must NOT append
	// a snapshot — which only happens if the resumed session read the
	// persisted entry; a fall back to defaultKBs (both fixtures) would
	// see the KB as active and append a fresh snapshot.
	// ---------------------------------------------------------------
	it(
		"scope survives session restart (resume reads the persisted entry)",
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
				const resumed = runHeadlessPi(
					["--session", seed, "/kb fixture-a off"],
					env,
					cwd,
				);
				expect(scopeEntries(resumed.events)).toEqual([]);

				// Control: the still-active KB toggles fine in the same resumed
				// session (proving the no-op above is scope-derived, not a dead
				// command path) and appends the full post-toggle snapshot.
				const toggled = runHeadlessPi(
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
	// /kb <name> on and /kb all off land mid-session: several
	// command dispatches inside ONE pi -p process (same live session, no
	// restart between), each appending its full post-toggle snapshot.
	// ---------------------------------------------------------------
	it(
		"/kb <name> on and /kb all off land mid-session",
		{ timeout: 300_000 },
		() => {
			const home = mkdtempSync(`${tmpdir()}/gnubrain-gate-home-`);
			const cwd = mkdtempSync(`${tmpdir()}/gnubrain-gate-cwd-`);
			try {
				seedHome(home, fixtures.settings, [REPO_ROOT]);
				const { events } = runHeadlessPi(
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
});
