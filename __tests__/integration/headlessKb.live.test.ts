// Sprint 5b-d item 11: headless /kb dispatch. `/kb all off` from a real
// `pi -p` process — converts the §5 scope-activation source-read claim into
// evidence before M4's recall harness depends on it. The child pi runs under
// a temp HOME seeded with .pi/agent/settings.json carrying the fixture
// settings (the same buildFixtureSettings object the in-memory seam injects),
// so the extension runs unmodified and reads its fixed global path by
// construction (§5). Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

/** The child pi loads the extension through the real install mechanism —
 * the repo listed under `packages` in the seeded settings.json — not a test
 * seam, so the extension runs unmodified and reads its fixed global path. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface HeadlessEvent {
	type: string;
	entry?: { type: string; customType?: string; data?: unknown };
	message?: { role?: string };
}

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"5b-d item 11: headless /kb",
	() => {
		let fixtures: IntegrationFixtures;

		beforeAll(async () => {
			fixtures = await setupFixtures();
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		it(
			"/kb all off from pi -p dispatches the command and persists the kb-scope entry",
			{ timeout: 120_000 },
			() => {
				const home = mkdtempSync(`${tmpdir()}/gnubrain-it-home-`);
				const cwd = mkdtempSync(`${tmpdir()}/gnubrain-it-cwd-`);
				try {
					// The pinned global path under the temp HOME — the exact file
					// shape the extension reads by construction (§5).
					mkdirSync(`${home}/.pi/agent`, { recursive: true });
					writeFileSync(
						`${home}/.pi/agent/settings.json`,
						JSON.stringify({
							packages: [REPO_ROOT],
							gnubrain: fixtures.settings,
						}),
					);

					const run = spawnSync(
						"pi",
						// One positional arg — pi treats each remaining argument as its
						// own prompt, so "/kb", "all", "off" would dispatch /kb and send
						// "all"/"off" to the model.
						["-p", "--mode", "json", "/kb all off"],
						{
							env: { ...process.env, HOME: home },
							cwd,
							encoding: "utf8",
							timeout: 90_000,
						},
					);
					expect(run.error).toBeUndefined();
					expect(run.status).toBe(0);
					expect(run.stderr).not.toMatch(/error/i);

					const events = run.stdout
						.split("\n")
						.filter((line) => line.startsWith("{"))
						.map((line) => JSON.parse(line) as HeadlessEvent);

					// Command dispatch, not an LLM round-trip: a dispatched command
					// produces no assistant message; a missed dispatch would send the
					// prompt to the model (and fail on an unauthenticated temp HOME).
					expect(events.some((e) => e.message?.role === "assistant")).toBe(
						false,
					);

					// The §5 persistence evidence: the full post-toggle snapshot
					// appended to the session — scope went from both fixtures (the
					// fixture defaultKBs) to the empty set.
					const scopeEntries = events.filter(
						(e) =>
							e.type === "entry_appended" &&
							e.entry?.type === "custom" &&
							e.entry.customType === "kb-scope",
					);
					expect(scopeEntries).toHaveLength(1);
					const first = scopeEntries[0]?.entry;
					expect(first?.data).toEqual({ active: [] });
				} finally {
					rmSync(home, { recursive: true, force: true });
					rmSync(cwd, { recursive: true, force: true });
				}
			},
		);
	},
);
