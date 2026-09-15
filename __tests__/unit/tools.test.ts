import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AST, type Binary, Parser } from "node-sql-parser";
import { CircuitBreaker } from "../../breaker.js";
import { EMPTY_SCOPE_MESSAGE } from "../../gate.js";
import { walkBlockTree } from "../../tools.js";
import { inlineOrSpill, PREVIEW_CHARS } from "../../spill.js";
import {
	certifySelect,
	postFilterRows,
	rebuildWithScope,
	verifyRebuilt,
	type KernelReadClient,
} from "../../tools.js";
import { RESULT_LIMIT, spillFile, spillFileName } from "../../spill.js";
import type { SessionValidation } from "../../validation.js";

function validation(): SessionValidation {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [
				{ name: "recipes", notebook: "nb-r" },
				{ name: "projects", notebook: "nb-p" },
			],
		},
		shapeErrors: [],
		probe: "ok",
		kernelVersion: "3.8.3",
		validKBs: new Map([
			["recipes", "nb-r"],
			["projects", "nb-p"],
		]),
		scope: ["recipes", "projects"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	};
}

/** Register the tools on a minimal fake pi and return the captured tool
 * definitions for direct execute() invocation. */
function fakePiWithTools() {
	const tools = new Map<string, { name: string; [k: string]: unknown }>();
	const pi = {
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	};
	const hooks = {
		getValidation: () => undefined,
		getKernel: () => undefined,
		breaker: new CircuitBreaker(),
	};
	return { tools, pi, hooks };
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
		);
		expect(result.post_filtered).toBe(true);
		expect(result.count).toBe(1);
	});

	it("a single active KB degenerates to the single-call shape", async () => {
		const { runSearchFanOut } = await import("../../tools.js");
		const { calls, client } = kernelStub();
		await runSearchFanOut("sess-1", client, validation(), ["recipes"], "q");
		expect(calls.filter((c) => c.method === "search")).toHaveLength(1);
	});

	it("aggregates the truncation marker across fan-out calls", async () => {
		const { runSearchFanOut } = await import("../../tools.js");
		const saturated: KernelReadClient = {
			...kernelStub().client,
			async search() {
				return {
					blocks: [],
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
		);
		expect(String(result.truncated)).toContain(`truncated in 2 of 2 KBs`);
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
		const all = await walkBlockTree(client, "d1", 1);
		expect(all.map((b) => b.id)).toEqual(["h1", "p1"]);
	});
});

// ---------------------------------------------------------------------------
// Toolset + tool descriptions + degraded-session clause
// ---------------------------------------------------------------------------

import {
	registerReadToolsAndToolset,
	READ_TOOLSET_ID,
	READ_TOOLSET_PERSIST_KEY,
} from "../../tools.js";
import { getRegisteredToolsets } from "pi-tool-masking";

describe("read toolset + descriptions", () => {
	it("registers the read toolset with the three kb_ members, default-enabled, pinned persist key", () => {
		const registered: { name: string }[] = [];
		const pi = {
			registerTool(tool: { name: string }) {
				registered.push({ name: tool.name });
			},
			on: () => {},
			events: { emit: () => {} },
		};
		registerReadToolsAndToolset(pi as never, {
			getValidation: () => undefined,
			getKernel: () => undefined,
			breaker: new CircuitBreaker(),
		});
		expect(registered.map((t) => t.name)).toEqual([
			"kb_query",
			"kb_search",
			"kb_read",
		]);
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
		expect(entry!.spec.persistKey).toBe(READ_TOOLSET_PERSIST_KEY);
	});

	it("the query tool description carries the pinned table schemas, semantics notes, and discovery pattern", () => {
		const registered: { name: string; description?: string }[] = [];
		const pi = {
			registerTool(tool: { name: string; description: string }) {
				registered.push(tool);
			},
			on: () => {},
			events: { emit: () => {} },
		};
		registerReadToolsAndToolset(pi as never, {
			getValidation: () => undefined,
			getKernel: () => undefined,
			breaker: new CircuitBreaker(),
		});
		const description = registered.find((t) => t.name === "kb_query")
			?.description as string;
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

	it("a typo'd kb with no docId gets the unknown-KB rejection, not the guidance", async () => {
		const kernelCalls: unknown[] = [];
		const read = registeredReadTool(validation(), kernelCalls);
		const envelope = parse(
			await read.execute!(
				"id",
				{ kb: "recipies" },
				undefined,
				undefined,
				ctx2("sess"),
			),
		);
		expect(envelope.status).toBe("refused");
		expect(String(envelope.message)).toContain("unknown KB 'recipies'");
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
