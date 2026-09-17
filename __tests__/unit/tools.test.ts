import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AST, type Binary, Parser } from "node-sql-parser";
import { createFakePi as fakePi } from "../helpers/fakePi.js";
import { SiYuanApiError } from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { EMPTY_SCOPE_MESSAGE } from "../../gate.js";
import { MAX_WALK_DEPTH, walkBlockTree } from "../../walk.js";
import {
	inlineOrSpill,
	PREVIEW_CHARS,
	RESULT_LIMIT,
	spillFile,
	spillFileName,
} from "../../spill.js";
import { registerReadToolsAndToolset, READ_TOOLSET_ID } from "../../tools.js";
import { getRegisteredToolsets } from "pi-tool-masking";
import {
	certifySelect,
	postFilterRows,
	rebuildWithScope,
	verifyRebuilt,
} from "../../sqlScope.js";
import type { KernelReadClient } from "../../kernel.js";
import type { SessionValidation } from "../../validation.js";
import { validation as makeValidation } from "./fixtures.js";

// These tests exercise the full scope, unlike the shared fixture's default.
const validation = () => makeValidation({ scope: ["recipes", "projects"] });

/** Register the tools on a fake pi and return the captured tool definitions
 * for direct execution. */
function fakePiWithTools() {
	const { pi, toolDefs } = fakePi();
	const hooks = {
		getValidation: () => undefined,
		getKernel: () => undefined,
		breaker: new CircuitBreaker(),
		baselines: ContentBaselines.create(),
	};
	return { tools: toolDefs, pi, hooks };
}

// ---------------------------------------------------------------------------
// Layer 1 — parser certification
// ---------------------------------------------------------------------------

describe("parser certification", () => {
	it("rejects DML", () => {
		expect(certifySelect("UPDATE blocks SET content = 'x'").ok).toBe(false);
		expect(certifySelect("DELETE FROM blocks").ok).toBe(false);
		expect(certifySelect("INSERT INTO blocks (id) VALUES ('x')").ok).toBe(
			false,
		);
	});

	it("rejects multi-statement input (astify returns an array — spike pin)", () => {
		const result = certifySelect("SELECT 1; SELECT 2");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("multiple statements");
	});

	it("rejects a plain wrong table (FROM-allowlist violation)", () => {
		const result = certifySelect("SELECT * FROM sqlite_master");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("only blocks and refs");
	});

	it("rejects a comma cross-join", () => {
		const result = certifySelect("SELECT * FROM blocks, refs");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("single-table FROM");
	});

	it("rejects a CTE shadowing an allowlisted table (the kernel permits WITH)", () => {
		const result = certifySelect(
			"WITH blocks AS (SELECT 1 AS box) SELECT * FROM blocks",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("CTEs");
	});

	it("rejects subqueries", () => {
		const result = certifySelect("SELECT * FROM (SELECT id FROM blocks) AS t");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("subqueries");
	});

	it("rejects subqueries in WHERE (the rebuild only scopes the outer WHERE)", () => {
		const inClause = certifySelect(
			"SELECT id FROM blocks WHERE id IN (SELECT id FROM refs)",
		);
		expect(inClause.ok).toBe(false);
		expect(!inClause.ok && inClause.reason).toContain("subqueries");
		const exists = certifySelect(
			"SELECT id FROM blocks WHERE EXISTS (SELECT 1 FROM refs)",
		);
		expect(exists.ok).toBe(false);
		expect(!exists.ok && exists.reason).toContain("subqueries");
	});

	it("rejects subqueries in the SELECT list", () => {
		const column = certifySelect(
			"SELECT (SELECT content FROM blocks LIMIT 1) AS leaked FROM blocks",
		);
		expect(column.ok).toBe(false);
		expect(!column.ok && column.reason).toContain("subqueries");
	});

	it("rejects UNION (parses as type 'select' with the second arm in _next/set_op — spike pin)", () => {
		const result = certifySelect(
			"SELECT id FROM blocks UNION SELECT id FROM refs",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("UNION");
	});

	it("rejects JOINs (single-table-FROM policy)", () => {
		const result = certifySelect(
			"SELECT * FROM blocks JOIN refs ON blocks.id = refs.block_id",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("JOINs");
	});

	it("rejects bare HAVING (v1 policy)", () => {
		const result = certifySelect(
			"SELECT box, COUNT(*) FROM blocks GROUP BY box HAVING COUNT(*) > 1",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("HAVING");
	});

	it("accepts a certified SELECT over blocks", () => {
		const result = certifySelect(
			"SELECT id, root_id, box, hpath, updated FROM blocks WHERE content LIKE '%foo%'",
		);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Layer 1 — AST rebuild + re-parse verification
// ---------------------------------------------------------------------------

describe("injected-predicate rebuild + re-parse", () => {
	// The executed statement is the re-parsed one, so verification runs on a
	// fresh parse of the serialized statement — the same flow the tool runs.
	const parser = new Parser();
	function rebuildAndVerify(sql: string, boxes = ["nb-r"]) {
		const certified = certifySelect(sql);
		if (!certified.ok) throw new Error(certified.reason);
		const originalWhere = certified.ast.where as Binary | null;
		const rebuilt = rebuildWithScope(certified.ast, boxes);
		const re = parser.astify(rebuilt.stmt, { type: "sqlite" }) as AST;
		const problem = verifyRebuilt(re, boxes, originalWhere, rebuilt.limit);
		return { rebuilt, problem };
	}

	it("OR precedence: the original expression stays grouped under AND", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE box = 'x' OR content LIKE '%y%'",
		);
		expect(problem).toBeUndefined();
		// Without the parens the serializer would render
		// `box = 'x' OR content LIKE '%y%' AND box IN (...)`.
		expect(rebuilt.stmt).toContain("(`box` = 'x' OR `content` LIKE '%y%')");
	});

	it("round-trips escaped quotes", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'O''Brien'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips LIKE backslash escapes", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content LIKE 'a\\\\_%'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips clause keywords inside strings", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'select where union having'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips non-ASCII literals", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = '日本語テスト'",
		);
		expect(problem).toBeUndefined();
	});

	it("keeps the injected LIMIT on an ||-containing statement (the kernel's vitess path rejects ||)", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'a' || 'b'",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.stmt).toContain("LIMIT 64");
	});

	it("injects LIMIT iff the AST shows none", () => {
		const without = certifySelect("SELECT id FROM blocks");
		if (!without.ok) throw new Error(without.reason);
		const rebuilt = rebuildWithScope(without.ast, ["nb-r"]);
		expect(rebuilt.limitInjected).toBe(true);
		expect(rebuilt.limit).toBe(RESULT_LIMIT);

		const withLimit = certifySelect("SELECT id FROM blocks LIMIT 5");
		if (!withLimit.ok) throw new Error(withLimit.reason);
		const kept = rebuildWithScope(withLimit.ast, ["nb-r"]);
		expect(kept.limitInjected).toBe(false);
		expect(kept.limit).toBe(5);
		expect(kept.stmt).toContain("LIMIT 5");
	});

	it("an agent-supplied LIMIT passes through uncapped", () => {
		const withBigLimit = certifySelect("SELECT id FROM blocks LIMIT 100000");
		if (!withBigLimit.ok) throw new Error(withBigLimit.reason);
		const rebuilt = rebuildWithScope(withBigLimit.ast, ["nb-r"]);
		expect(rebuilt.limit).toBe(100000);
		expect(rebuilt.stmt).toContain("LIMIT 100000");
		expect(rebuilt.stmt).toContain("`box` IN");
	});

	// Parser-shape pins for the non-plain LIMIT forms the sqlite grammar
	// admits: they parse into the same limit node, so a parser upgrade that
	// reshuffles slots turns these red instead of silently corrupting the
	// truncation marker.
	it("LIMIT m, n: the limit is the second number (the first is the OFFSET)", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT 2, 10",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(10);
		expect(rebuilt.stmt).toContain("LIMIT 2, 10");
	});

	it("LIMIT n OFFSET m: the limit is the first number", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT 5 OFFSET 2",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(5);
	});

	it("LIMIT -1 (sqlite's no-limit) verifies with the limit passed through", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT -1",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// Layer 3 — post-filter backstop
// ---------------------------------------------------------------------------

describe("post-filter backstop", () => {
	it("drops rows whose box is out of scope and flags post_filtered", () => {
		const { kept, dropped } = postFilterRows(
			[
				{ box: "nb-r", id: "1" },
				{ box: "nb-other", id: "2" },
			],
			["nb-r"],
		);
		expect(kept).toEqual([{ box: "nb-r", id: "1" }]);
		expect(dropped).toBe(1);
	});

	it("box-less aggregate rows are exempt (they carry no box column)", () => {
		const { kept, dropped } = postFilterRows([{ "COUNT(*)": 42 }], ["nb-r"]);
		expect(kept).toEqual([{ "COUNT(*)": 42 }]);
		expect(dropped).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Spill + budgets
// ---------------------------------------------------------------------------

describe("spill budgets", () => {
	it("names spill files {tool}-{sha256-16hex} in the per-session dir", () => {
		const path = spillFile("sess-1", "kb_query", '[{"id":1}]', "jsonl");
		expect(path.startsWith(join(tmpdir(), "gnubrain", "sess-1"))).toBe(true);
		expect(spillFileName("kb_query", '[{"id":1}]', "jsonl")).toMatch(
			/^kb_query-[0-9a-f]{16}\.jsonl$/,
		);
		// Identical payloads dedupe to the same hash-named file.
		const again = spillFile("sess-1", "kb_query", '[{"id":1}]', "jsonl");
		expect(again).toBe(path);
	});
});

// ---------------------------------------------------------------------------
// Tool surface — executed through the registered definitions
// ---------------------------------------------------------------------------

function kernelStub() {
	const calls: { method: string; args: unknown }[] = [];
	const client: KernelReadClient = {
		baseUrl: "http://127.0.0.1:6806",
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			return [{ id: "b1", root_id: "d1", box: "nb-r" }];
		},
		async search(params) {
			calls.push({ method: "search", args: params });
			// The kernel echoes the called box — the post-filter keys on it.
			return {
				blocks: [
					{
						id: "s1",
						rootID: "d1",
						box: params.paths[0] as string,
						hPath: "/doc",
						updated: "20260101120000",
					},
				],
				matchedBlockCount: 1,
			};
		},
		async exportMarkdown(id) {
			calls.push({ method: "exportMarkdown", args: id });
			return { hPath: "/doc", content: "# doc\nbody" };
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			return [
				{
					id: "h1",
					type: "h",
					subType: "h1",
					content: "Heading",
				},
			];
		},
	};
	return { calls, client };
}

describe("search tool", () => {
	it("fans out one call per resolved KB with per-call pageSize", async () => {
		// registered via registerSearchTool — see the toolset test below for the
		// wiring; here we exercise the fan-out through the same helper the tool
		// uses.
		const { runSearchFanOut } = await import("../../tools.js");
		const { calls, client } = kernelStub();
		const result = await runSearchFanOut(
			"sess-1",
			client,
			validation(),
			["recipes", "projects"],
			"docker",
			() => {},
		);
		const searches = calls.filter((c) => c.method === "search");
		expect(searches).toHaveLength(2);
		expect(searches[0]?.args).toEqual({
			query: "docker",
			paths: ["nb-r"],
			pageSize: RESULT_LIMIT,
		});
		expect(searches[1]?.args).toEqual({
			query: "docker",
			paths: ["nb-p"],
			pageSize: RESULT_LIMIT,
		});
		expect(result.kb).toEqual(["recipes", "projects"]);
		expect(result.rows).toEqual([
			{
				id: "s1",
				root_id: "d1",
				hpath: "/doc",
				box: "recipes",
				updated: "20260101120000",
			},
			{
				id: "s1",
				root_id: "d1",
				hpath: "/doc",
				box: "projects",
				updated: "20260101120000",
			},
		]);
	});

	it("drops out-of-scope rows with post_filtered: true (mocked-only contamination)", async () => {
		const { runSearchFanOut } = await import("../../tools.js");
		const { client } = kernelStub();
		const contaminated: KernelReadClient = {
			...client,
			async search() {
				return {
					blocks: [
						{
							id: "s1",
							rootID: "d1",
							box: "nb-r",
							hPath: "/doc",
							updated: "20260101120000",
						},
						{
							id: "s2",
							rootID: "d2",
							box: "nb-foreign",
							hPath: "/elsewhere",
							updated: "20260101120001",
						},
					],
					matchedBlockCount: 2,
				};
			},
		};
		const result = await runSearchFanOut(
			"sess-1",
			contaminated,
			validation(),
			["recipes"],
			"docker",
			() => {},
		);
		expect(result.post_filtered).toBe(true);
		expect(result.count).toBe(1);
	});

	it("a single active KB degenerates to the single-call shape", async () => {
		const { runSearchFanOut } = await import("../../tools.js");
		const { calls, client } = kernelStub();
		await runSearchFanOut(
			"sess-1",
			client,
			validation(),
			["recipes"],
			"q",
			() => {},
		);
		expect(calls.filter((c) => c.method === "search")).toHaveLength(1);
	});

	it("aggregates the truncation marker across fan-out calls", async () => {
		const { runSearchFanOut } = await import("../../tools.js");
		const saturated: KernelReadClient = {
			...kernelStub().client,
			async search(params) {
				// Deliberately short window plus a match count beyond it —
				// pins the surplus arithmetic in the truncation marker. Echo
				// the called box so the post-filter keeps every row.
				return {
					blocks: Array.from({ length: RESULT_LIMIT - 1 }, () => ({
						id: "s1",
						rootID: "d1",
						box: params.paths[0] as string,
						hPath: "/doc",
						updated: "20260101120000",
					})),
					matchedBlockCount: RESULT_LIMIT + 10,
				};
			},
		};
		const result = await runSearchFanOut(
			"sess-1",
			saturated,
			validation(),
			["recipes", "projects"],
			"q",
			() => {},
		);
		// 2 KBs × (RESULT_LIMIT + 10 − (RESULT_LIMIT − 1)) = 22 hidden rows.
		expect(String(result.truncated)).toContain(
			"22 rows — truncated in 2 of 2 KBs",
		);
		expect(String(result.truncated)).toContain("full result in");
	});

	it("rejects agent-supplied method/aux params at the tool schema", async () => {
		const { tools, pi, hooks } = fakePiWithTools();
		const { registerSearchTool } = await import("../../tools.js");
		registerSearchTool(pi as never, hooks);
		const schema = tools.get("kb_search") as unknown as {
			parameters: Record<string, unknown>;
		};
		expect(schema.parameters).toMatchObject({ additionalProperties: false });
	});
});

// ---------------------------------------------------------------------------
// Query tool — happy path through the registered kb_query definition
// ---------------------------------------------------------------------------

describe("query tool", () => {
	/** Register the read tools on a fake pi with a query-only kernel stub
	 * returning `rows`; execute kb_query through the registered definition. */
	async function executeQuery(rows: Record<string, unknown>[]) {
		const { pi, toolDefs } = fakePi();
		const kernelCalls: string[] = [];
		registerReadToolsAndToolset(pi, {
			getValidation: () => validation(),
			getKernel: () =>
				({
					baseUrl: "http://127.0.0.1:6806",
					query: async (stmt: string) => {
						kernelCalls.push(stmt);
						return rows;
					},
				}) as never,
			breaker: new CircuitBreaker(),
			baselines: ContentBaselines.create(),
		});
		const tool = toolDefs.get("kb_query") as unknown as {
			execute: (...a: unknown[]) => Promise<{ details: unknown }>;
		};
		return {
			run: async (sql: string) =>
				(
					await tool.execute(
						"id",
						{ kb: ["recipes"], sql },
						undefined,
						undefined,
						ctx2("sess-query"),
					)
				).details as Record<string, unknown>,
			kernelCalls,
		};
	}

	it("happy path through the tool: scope splice, injected LIMIT, and the truncation marker on a saturated result", async () => {
		const rows = Array.from({ length: RESULT_LIMIT }, (_, i) => ({
			id: `b${i}`,
			root_id: "d1",
			box: "nb-r",
		}));
		const { run, kernelCalls } = await executeQuery(rows);
		const envelope = await run("SELECT id, root_id FROM blocks");
		expect(envelope.status).toBe("ok");
		expect(envelope.count).toBe(RESULT_LIMIT);
		expect(envelope.kb).toEqual(["recipes"]);
		expect(envelope.boxes).toEqual(["nb-r"]);
		expect(Array.isArray(envelope.rows)).toBe(true);
		// kept + dropped reaches the injected limit → the marker fires even
		// though every returned row was in scope.
		expect(String(envelope.truncated)).toContain("full result in");
		// One kernel call carrying the spliced scope and the injected LIMIT.
		expect(kernelCalls).toHaveLength(1);
		expect(kernelCalls[0]).toContain("IN ('nb-r')");
		expect(kernelCalls[0]).toContain("LIMIT 64");
	});

	it("LIMIT -1 (sqlite's no-limit) is unbounded: a saturated result never truncate-flags", async () => {
		const rows = Array.from({ length: RESULT_LIMIT }, (_, i) => ({
			id: `b${i}`,
			root_id: "d1",
			box: "nb-r",
		}));
		const { run } = await executeQuery(rows);
		const envelope = await run("SELECT id FROM blocks LIMIT -1");
		expect(envelope.status).toBe("ok");
		expect(envelope.truncated).toBeUndefined();
	});

	it("drops kernel-side contamination with post_filtered: true", async () => {
		const { run } = await executeQuery([
			{ id: "b1", root_id: "d1", box: "nb-r" },
			{ id: "b2", root_id: "d2", box: "nb-foreign" },
		]);
		const envelope = await run("SELECT id FROM blocks");
		expect(envelope.status).toBe("ok");
		expect(envelope.post_filtered).toBe(true);
		expect(envelope.count).toBe(1);
	});
});

describe("read tool", () => {
	it("the ownership query doubles as the scope check — a docId from another KB returns no rows", async () => {
		const { runRead } = await import("../../tools.js");
		const { client } = kernelStub();
		const result = await runRead(
			"sess-1",
			// The kernel answers the ownership query with zero rows for a doc
			// from another KB — no second scope branch exists.
			{
				...client,
				async query() {
					return [];
				},
			},
			validation(),
			"recipes",
			"foreign-doc",
			() => {},
			ContentBaselines.create(),
		);
		expect(result.status).toBe("error");
		expect(result.message).toContain("no doc 'foreign-doc'");
	});

	it("caps the outline at OUTLINE_HEADINGS inline lines with a spill pointer", async () => {
		const { runRead } = await import("../../tools.js");
		const headings = Array.from({ length: 250 }, (_, i) => ({
			id: `h${i}`,
			type: "h",
			subType: "h2",
			content: `Heading ${i}`,
		}));
		const client: KernelReadClient = {
			...kernelStub().client,
			async getChildBlocks(id) {
				return id === "d1" ? headings : [];
			},
		};
		const result = await runRead(
			"sess-1",
			client,
			validation(),
			"recipes",
			"d1",
			() => {},
			ContentBaselines.create(),
		);
		const lines = String(result.outline).split("\n");
		expect(lines).toHaveLength(201); // 200 + the pointer line
		expect(lines.at(-1)).toContain("50 more");
		expect(result.fullOutlinePath).toBeDefined();
	});

	it("verification runs on the full walk set, not the capped outline", async () => {
		// The walk helper itself — the heading filter is rendering-only.
		const headings = [
			{ id: "h1", type: "h", subType: "h1", content: "A" },
			{ id: "p1", type: "p", subType: "", content: "para" },
		];
		const client: KernelReadClient = {
			...kernelStub().client,
			async getChildBlocks(id) {
				return id === "d1" ? headings : [];
			},
		};
		const all = await walkBlockTree(client, "d1");
		expect(all.map((b) => b.id)).toEqual(["h1", "p1"]);
	});

	it("never walks a heading id: the section rides the owning container's loop (no duplicate entries, container depth)", async () => {
		// The kernel answers getChildBlocks(headingId) with the heading's
		// SECTION, and those blocks are already returned by the loop over the
		// container that owns the heading — recursing into `h` would re-emit
		// each one at the heading's depth and out of document order. The stub
		// throws if the walk ever asks, which is the guard.
		const client: KernelReadClient = {
			...kernelStub().client,
			async getChildBlocks(id) {
				if (id === "d1")
					return [
						{ id: "h1", type: "h", subType: "h1", content: "A" },
						{ id: "p1", type: "p", subType: "", content: "under A" },
						{ id: "h2", type: "h", subType: "h2", content: "B" },
						{ id: "p2", type: "p", subType: "", content: "under B" },
					];
				throw new Error(`walk recursed into '${id}'`);
			},
		};
		const walk = await walkBlockTree(client, "d1");
		expect(walk.map((b) => b.id)).toEqual(["h1", "p1", "h2", "p2"]);
		expect(walk.map((b) => b.depth)).toEqual([1, 1, 1, 1]);
	});

	it("read walk tolerates a vanished container (SiYuanApiError ends that branch); strict default propagates", async () => {
		const boom = new SiYuanApiError(500, -1, "locked");
		const client: KernelReadClient = {
			...kernelStub().client,
			async getChildBlocks(id) {
				if (id === "gone") throw boom;
				return id === "d1"
					? [{ id: "gone", type: "l", subType: "", content: "" }]
					: [];
			},
		};
		// Read path: the concurrent-deleted container shortens the outline.
		const tolerant = await walkBlockTree(client, "d1", {
			tolerateVanished: true,
		});
		expect(tolerant.map((b) => b.id)).toEqual(["gone"]);
		// Default (write verification): the same error propagates.
		await expect(walkBlockTree(client, "d1")).rejects.toBe(boom);
	});

	it("walk renders a container chain exactly to the recursion bound (no off-by-one truncation)", async () => {
		// A chain of containers ending in a heading leaf; the walk must
		// render every level up to the bound and cut cleanly past it.
		const chainClient = (leafAfter: number): KernelReadClient => ({
			...kernelStub().client,
			async getChildBlocks(id) {
				if (id === "d1")
					return [{ id: "c1", type: "l", subType: "", content: "" }];
				const m = /^c(\d+)$/.exec(id);
				if (m === null) return [];
				const d = Number(m[1]);
				return d < leafAfter
					? [{ id: `c${d + 1}`, type: "l", subType: "", content: "" }]
					: [{ id: "leaf", type: "h", subType: "h1", content: "deep" }];
			},
		});
		// Exactly the bound: c1..c{N-1} containers, the leaf lands at depth N.
		const full = await walkBlockTree(chainClient(MAX_WALK_DEPTH - 1), "d1");
		expect(full.map((b) => b.id)).toEqual([
			...Array.from({ length: MAX_WALK_DEPTH - 1 }, (_, i) => `c${i + 1}`),
			"leaf",
		]);
		expect(full.at(-1)?.depth).toBe(MAX_WALK_DEPTH);
		// One level deeper: the leaf would sit past the bound and is cut,
		// with the deepest in-bound container level intact.
		const over = await walkBlockTree(chainClient(MAX_WALK_DEPTH), "d1");
		expect(over.map((b) => b.id)).toEqual(
			Array.from({ length: MAX_WALK_DEPTH }, (_, i) => `c${i + 1}`),
		);
		expect(over.at(-1)?.depth).toBe(MAX_WALK_DEPTH);
	});
});

// ---------------------------------------------------------------------------
// Toolset + tool descriptions + degraded-session clause
// ---------------------------------------------------------------------------

describe("read toolset + descriptions", () => {
	it("registers the read toolset with the three kb_ members, default-enabled, pinned persist key", () => {
		const { pi, tools: toolDefs, hooks } = fakePiWithTools();
		registerReadToolsAndToolset(pi, hooks);
		expect([...toolDefs.keys()]).toEqual(["kb_query", "kb_search", "kb_read"]);
		const entry = getRegisteredToolsets().find(
			(t) => t.spec.id === READ_TOOLSET_ID,
		);
		expect(entry).toBeDefined();
		expect([...entry!.spec.names].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
		]);
		expect(entry!.spec.defaultEnabled).toBe(true);
		expect(entry!.spec.persistKey).toBe("toolset-state:gnubrain.read");
	});

	it("the query tool description carries the pinned table schemas, semantics notes, and discovery pattern", () => {
		const { pi, tools: toolDefs, hooks } = fakePiWithTools();
		registerReadToolsAndToolset(pi, hooks);
		const description = (
			toolDefs.get("kb_query") as { description?: string } | undefined
		)?.description as string;
		// blocks schema + refs schema (pin)
		expect(description).toContain(
			"blocks: id, parent_id, root_id, hpath, box, type, content, updated, sort",
		);
		expect(description).toContain(
			"refs: id, def_block_id, def_block_root_id, block_id, root_id, box",
		);
		// the two semantics notes agents demonstrably misread
		expect(description).toContain("block-type weight");
		expect(description).toContain("never an address");
		// the include-hpath discovery pattern
		expect(description).toContain(
			"SELECT id, root_id, box, hpath, updated FROM blocks",
		);
	});
});

describe("degraded session (shape clause, asserted with the registered tools)", () => {
	it("a shape failure keeps the tools registered and rejects calls with the problem named", async () => {
		const registered: {
			name: string;
			execute?: (
				...args: unknown[]
			) => Promise<{ content: { text: string }[] }>;
		}[] = [];
		const pi = {
			registerTool(tool: { name: string; execute?: never }) {
				registered.push(tool as never);
			},
			on: () => {},
			events: { emit: () => {} },
		};
		const degraded = validation();
		degraded.shapeErrors = ["defaultKBs must be an array of KB name strings"];
		const kernelCalls: unknown[] = [];
		const toolset = registerReadToolsAndToolset(pi as never, {
			getValidation: () => degraded,
			getKernel: () =>
				({
					baseUrl: "http://127.0.0.1:6806",
					query: async (stmt: string) => {
						kernelCalls.push(stmt);
						return [];
					},
				}) as never,
			breaker: new CircuitBreaker(),
			baselines: ContentBaselines.create(),
		});
		expect(registered.map((t) => t.name)).toEqual([
			"kb_query",
			"kb_search",
			"kb_read",
		]);
		// Tools stay registered — masking never happened; the gate refuses.
		const query = registered.find((t) => t.name === "kb_query") as unknown as {
			execute: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { text: string }[] }>;
		};
		const result = await query.execute(
			"id",
			{ kb: ["recipes"], sql: "SELECT id FROM blocks" },
			undefined,
			undefined,
			ctx2("sess"),
		);
		const envelope = JSON.parse(result.content[0]!.text);
		expect(envelope.status).toBe("refused");
		expect(envelope.message).toContain(
			"defaultKBs must be an array of KB name strings",
		);
		expect(kernelCalls).toHaveLength(0); // zero kernel calls
		expect(toolset).toBeDefined();
	});
});

function ctx2(sessionId: string) {
	return { sessionManager: { getSessionId: () => sessionId } };
}

// ---------------------------------------------------------------------------
// Served-content baselines (fresh-content precondition, read-side serve leg)
// ---------------------------------------------------------------------------

describe("read tools seed served-content baselines", () => {
	const type = (r: { content: { text: string }[] }) =>
		JSON.parse(r.content[0]!.text) as Record<string, unknown>;

	function registered(tool: string, kernel: unknown) {
		const registered: {
			name: string;
			execute?: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { text: string }[] }>;
		}[] = [];
		const pi = {
			registerTool(t: never) {
				registered.push(t as never);
			},
			on: () => {},
			events: { emit: () => {} },
		};
		const baselines = ContentBaselines.create();
		registerReadToolsAndToolset(pi as never, {
			getValidation: () => validation(),
			getKernel: () => kernel as never,
			breaker: new CircuitBreaker(),
			baselines,
		});
		return { baselines, tool: registered.find((t) => t.name === tool)! };
	}

	it("kb_read records a baseline for each heading the outline serves (§10 outline-sourced pin)", async () => {
		const { baselines, tool } = registered("kb_read", {
			...kernelStub().client,
			async query(_stmt: string) {
				// ownership route
				return [{ root_id: "d1" }];
			},
		});
		const envelope = type(
			await tool.execute!(
				"id",
				{ kb: "recipes", docId: "d1" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		// The walk's heading (id h1, content "Heading") was served → hashed.
		expect(baselines.servedHash("h1")).toBeDefined();
		// Same representation the re-check hashes: blocks.content.
		expect(baselines.servedHash("h1")).toBe(
			createHash("sha256").update("Heading").digest("hex").slice(0, 16),
		);
	});

	it("kb_query records baselines for rows that selected id + content", async () => {
		const { baselines, tool } = registered("kb_query", {
			baseUrl: "http://127.0.0.1:6806",
			async query(_stmt: string) {
				return [
					{ id: "p1", content: "first paragraph", box: "nb-r" },
					// A content-less projection (refs-table row shape) — skipped.
					{ id: "r1", def_block_id: "p1", box: "nb-r" },
				];
			},
		});
		const envelope = type(
			await tool.execute!(
				"id",
				{ kb: ["recipes"], sql: "SELECT id, content FROM blocks" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(baselines.servedHash("p1")).toBeDefined();
		expect(baselines.servedHash("r1")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// `kbs` discovery name
// ---------------------------------------------------------------------------

describe('kbs discovery (kb_read kb: "kbs")', () => {
	function registeredReadTool(
		validation: SessionValidation,
		kernelCalls: unknown[],
		opts: { breaker?: CircuitBreaker; tool?: string } = {},
	) {
		const registered: {
			name: string;
			description?: string;
			parameters?: unknown;
			execute?: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { text: string }[] }>;
		}[] = [];
		const pi = {
			registerTool(tool: never) {
				registered.push(tool as never);
			},
			on: () => {},
			events: { emit: () => {} },
		};
		registerReadToolsAndToolset(pi as never, {
			getValidation: () => validation,
			getKernel: () =>
				({
					baseUrl: "http://127.0.0.1:6806",
					query: async (stmt: string) => {
						kernelCalls.push(stmt);
						return [];
					},
				}) as never,
			breaker: opts.breaker ?? new CircuitBreaker(),
			baselines: ContentBaselines.create(),
		});
		return registered.find((t) => t.name === (opts.tool ?? "kb_read"))!;
	}

	const parse = (r: { content: { text: string }[] }) =>
		JSON.parse(r.content[0]!.text) as Record<string, unknown>;

	it("returns the active set with zero kernel calls", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(envelope.kb).toBe("kbs");
		expect(envelope.message).toBe("recipes, projects");
		expect(envelope.names).toEqual(["recipes", "projects"]);
		expect(kernelCalls).toHaveLength(0);
	});

	it("empty scope uses EMPTY_SCOPE_MESSAGE verbatim with the same marker shape", async () => {
		const kernelCalls: unknown[] = [];
		const v = validation();
		v.scope = [];
		const read = registeredReadTool(v, kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(envelope.kb).toBe("kbs");
		expect(envelope.message).toBe(EMPTY_SCOPE_MESSAGE);
		expect(envelope.names).toEqual([]);
	});

	it("a shape-degraded session still refuses discovery (the short-circuit sits after the shape check)", async () => {
		const kernelCalls: unknown[] = [];
		const v = validation();
		v.shapeErrors = ["kbs must be an array"];
		const read = registeredReadTool(v, kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		expect(envelope.message).toContain("kbs must be an array");
		expect(kernelCalls).toHaveLength(0);
	});

	it("discovery succeeds while the breaker is tripped and leaves it untouched (no recordSuccess)", async () => {
		const kernelCalls: unknown[] = [];
		const breaker = new CircuitBreaker();
		// Trip the breaker.
		for (let i = 0; i < 3; i++) breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
		const read = registeredReadTool(validation(), kernelCalls, { breaker });
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(envelope.names).toEqual(["recipes", "projects"]);
		expect(kernelCalls).toHaveLength(0);
		// The breaker stays tripped — a discovery call is neither a success nor
		// an auth failure (the short-circuit bypasses the gate entirely).
		expect(breaker.tripped).toBe(true);
	});

	it("discovery succeeds while a 429 cooldown is armed", async () => {
		const kernelCalls: unknown[] = [];
		const breaker = new CircuitBreaker();
		breaker.recordRateLimit({ retryAfterSeconds: 60 } as never, Date.now());
		const read = registeredReadTool(validation(), kernelCalls, { breaker });
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(kernelCalls).toHaveLength(0);
	});

	it("a discovery call carrying a docId still returns the scope branch (docId ignored)", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "kbs", docId: "20260101-x" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("ok");
		expect(envelope.kb).toBe("kbs");
		expect(envelope.names).toEqual(["recipes", "projects"]);
		expect(kernelCalls).toHaveLength(0);
	});

	it("valid kb with docId absent is refused with the three-exit guidance inside the gated op", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "recipes" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		const message = String(envelope.message);
		expect(message).toContain("kb_query");
		expect(message).toContain('kb: "kbs"');
		expect(message).not.toContain("rows"); // never a doc listing or metrics
		expect(kernelCalls).toHaveLength(0);
	});

	it("empty-string docId counts as missing", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "recipes", docId: "" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		expect(kernelCalls).toHaveLength(0);
	});

	it("a near-miss kb name (separator guess) gets the unknown-KB rejection, not the guidance", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "recipes_projects" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		expect(String(envelope.message)).toContain("unknown KB 'recipes_projects'");
		expect(String(envelope.message)).not.toContain("docId is required");
	});

	it("docId is optional in the kb_read schema", () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const props = (read.parameters as { properties: Record<string, unknown> })
			.properties;
		expect(props["docId"]).toBeDefined();
		// TypeBox marks optional properties by omitting them from `required`.
		const required =
			(read.parameters as { required?: string[] }).required ?? [];
		expect(required).toContain("kb");
		expect(required).not.toContain("docId");
	});

	it("the kb_read description carries the discovery line", () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		expect(read.description).toContain('kb: "kbs"');
	});

	it('kb_query rejects kb: ["kbs"] via the existing unknown-KB rejection (no special case)', async () => {
		const kernelCalls: unknown[] = [];
		const query = registeredReadTool(validation(), kernelCalls, {
			tool: "kb_query",
		});
		const envelope = parse(
			await query.execute!(
				"id",
				{ kb: ["kbs"], sql: "SELECT id FROM blocks" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		expect(String(envelope.message)).toContain("unknown KB 'kbs'");
		expect(String(envelope.message)).toContain("Active: recipes, projects");
		expect(kernelCalls).toHaveLength(0);
	});
});

describe("inline-cut preview", () => {
	it("returns short content directly with no spill", () => {
		const result = inlineOrSpill("s", "kb_read", "short", "md");
		expect(result.inline).toBe("short");
		expect(result.spillPath).toBeUndefined();
	});

	it("falls back to a hard cut when the overflow has no newline within PREVIEW_CHARS", () => {
		const content = "x".repeat(PREVIEW_CHARS + 10);
		const { inline, spillPath } = inlineOrSpill("s", "kb_read", content, "md");
		expect(inline).toBe(content.slice(0, PREVIEW_CHARS));
		expect(inline).not.toContain("\n");
		expect(spillPath).toMatch(/kb_read-[0-9a-f]{16}\.md$/);
	});

	it("cuts long content at a newline boundary within PREVIEW_CHARS and spills the full text", () => {
		const line = "x".repeat(1000);
		const content = Array.from({ length: 12 }, () => line).join("\n");
		const { inline, spillPath } = inlineOrSpill("s", "kb_read", content, "md");
		expect(inline.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
		// The cut lands on the newline boundary, not mid-line.
		expect(content.startsWith(inline)).toBe(true);
		expect(content.slice(inline.length, inline.length + 1)).toBe("\n");
		expect(spillPath).toMatch(/kb_read-[0-9a-f]{16}\.md$/);
	});
});
