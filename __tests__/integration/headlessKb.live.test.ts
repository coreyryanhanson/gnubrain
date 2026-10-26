// Headless /kb dispatch. `/kb all off` from a real `pi -p` process — proves
// the scope-activation source-read claim end to end. The child pi runs under
// a temp HOME seeded with .pi/agent/settings.json carrying the fixture
// settings (the same buildFixtureSettings object the in-memory seam injects),
// so the extension runs unmodified and reads its fixed global path by
// construction. Opt-in with SIYUAN_INTEGRATION=1, never in CI.

import { mkdtempSync, rmSync } from "node:fs";
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
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("headless /kb dispatch", () => {
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
				// shape the extension reads by construction.
				seedHome(home, fixtures.settings, [REPO_ROOT]);

				const events = runHeadlessPi(
					// One positional arg — pi treats each remaining argument as its
					// own prompt, so "/kb", "all", "off" would dispatch /kb and send
					// "all"/"off" to the model.
					["/kb all off"],
					{ HOME: home },
					cwd,
					{ timeoutMs: 90_000 },
				).events;

				// Command dispatch, not an LLM round-trip: a dispatched command
				// produces no assistant message; a missed dispatch would send the
				// prompt to the model (and fail on an unauthenticated temp HOME).
				expect(events.some((e) => e.message?.role === "assistant")).toBe(false);

				// The persistence evidence: the full post-toggle snapshot
				// appended to the session — scope went from both fixtures (the
				// fixture defaultKBs) to the empty set.
				expect(scopeEntries(events)).toEqual([{ active: [] }]);
			} finally {
				rmSync(home, { recursive: true, force: true });
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);
});
