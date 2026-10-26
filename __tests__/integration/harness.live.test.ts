// Harness self-check: proves the fixture wiring (fixture minting, in-memory
// settings injection, version pin, teardown assertion) against the live
// kernel before any case rides on it. Opt-in with SIYUAN_INTEGRATION=1.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Binary } from "node-sql-parser";
import {
	certifySelect,
	rebuildWithScope,
	reparse,
	verifyRebuilt,
} from "../../sqlScope.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("harness self-check", () => {
	let fixtures: IntegrationFixtures;

	beforeAll(async () => {
		fixtures = await setupFixtures();
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	it(
		"validates both fixtures and scopes a query to them",
		async () => {
			const { client, validation, notebookIds } = fixtures;
			// Version-pin + settings-seam + scope pins asserted in setupFixtures;
			// here the observable surface for later cases.
			expect(validation.probe.verdict).toBe("ok");
			expect([...validation.validKBs.keys()].sort()).toEqual([
				"fixture-a",
				"fixture-b",
			]);

			// Scoped through the extension's own AST splice (box IN (...)), the same
			// path the kb_query tool takes — no string interpolation of the box set.
			const certified = certifySelect("SELECT id, root_id, box FROM blocks");
			if (!certified.ok) throw new Error(certified.reason);
			const originalWhere = certified.ast.where as Binary | null;
			const rebuilt = rebuildWithScope(certified.ast, [
				notebookIds.fixtureA,
				notebookIds.fixtureB,
			]);
			// The tool flow's full verify leg: the executed statement is the
			// re-parsed one and still carries the injected box predicate.
			const problem = verifyRebuilt(
				reparse(rebuilt.stmt),
				[notebookIds.fixtureA, notebookIds.fixtureB],
				originalWhere,
				rebuilt.limit,
			);
			if (problem !== undefined) throw new Error(problem);
			const rows = await client.query(rebuilt.stmt);
			expect(Array.isArray(rows)).toBe(true);
			for (const row of rows) {
				expect([notebookIds.fixtureA, notebookIds.fixtureB]).toContain(row.box);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"runs a full-text search against a fixture notebook",
		async () => {
			const { client, notebookIds } = fixtures;
			const result = await client.fullTextSearch({
				query: "a",
				paths: [notebookIds.fixtureA],
				pageSize: 64,
			});
			expect(Array.isArray(result.blocks)).toBe(true);
		},
		LIVE_TIMEOUT,
	);
});
