// Live smoke for the read tools (posture: opt-in, never in CI).
// Run with SIYUAN_INTEGRATION=1 against the pinned kernel; self-skips
// otherwise. Exercises certification + rebuild + the typed client's readonly
// query/search paths end to end.

import { beforeAll, describe, expect, it } from "vitest";
import { type AST, type Binary, Parser } from "node-sql-parser";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { BASE_URL, INTEGRATION, TOKEN } from "./harness.js";
import {
	certifySelect,
	rebuildWithScope,
	verifyRebuilt,
} from "../../sqlScope.js";

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"live kernel smoke (read tools)",
	() => {
		// Built lazily: a describe body runs during collection even when the suite
		// is skipped, and BASE_URL/TOKEN are only present in a live run.
		let client: SiYuanKernelClient;

		beforeAll(() => {
			client = new SiYuanKernelClient(BASE_URL, TOKEN);
		});

		it("certifies, rebuilds, and executes a scoped query against the live kernel", async () => {
			const certified = certifySelect(
				"SELECT id, root_id, box, hpath, updated FROM blocks LIMIT 5",
			);
			if (!certified.ok) throw new Error(certified.reason);
			const originalWhere = certified.ast.where as Binary | null;
			const rebuilt = rebuildWithScope(
				certified.ast,
				// Smoke scope: any box — scoping itself is pinned by the unit suite.
				["*"],
			);
			const parser = new Parser();
			const re = parser.astify(rebuilt.stmt, { type: "sqlite" }) as AST;
			expect(
				verifyRebuilt(re, ["*"], originalWhere, rebuilt.limit),
			).toBeUndefined();
			const rows = await client.query(rebuilt.stmt);
			expect(Array.isArray(rows)).toBe(true);
		});

		it("runs a full-text search fan-out call", async () => {
			const notebooks = await client.listNotebooks();
			const box = notebooks?.notebooks[0]?.id;
			expect(box).toBeTruthy();
			const result = await client.search({
				query: "a",
				paths: [box as string],
				pageSize: 64,
			});
			expect(Array.isArray(result.blocks)).toBe(true);
		});
	},
);
