import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePi as fakePi } from "../helpers/fakePi.js";
import { contentHash, type KernelReadClient } from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { EMPTY_SCOPE_MESSAGE, RATE_LIMIT_SKIP_MESSAGE } from "../../kbScope.js";
import { READ_TOOLSET_ID } from "../../toolsetIds.js";
import { PREVIEW_CHARS, RESULT_LIMIT } from "../../spill.js";
import {
	registerReadToolsAndToolset,
	registerSearchTool,
	runRead,
	runSearchFanOut,
} from "../../tools.js";
import { getRegisteredToolsets } from "pi-tool-masking";
import type { SessionValidation } from "../../validation.js";
import { validation as makeValidation } from "./fixtures.js";

/** Read a spill file back as JSONL — the unit suite's only byte-level check
 * that spills hold the full payload, never a capped slice. */
function readSpilledJsonl<T>(path: string): T[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as T);
}

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
// Tool surface — executed through the registered definitions
// ---------------------------------------------------------------------------

function kernelStub() {
	const calls: { method: string; args: unknown }[] = [];
	const client: KernelReadClient = {
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
		const { calls, client } = kernelStub();
		await runSearchFanOut("sess-1", client, validation(), ["recipes"], "q");
		expect(calls.filter((c) => c.method === "search")).toHaveLength(1);
	});

	it("aggregates the truncation marker across fan-out calls", async () => {
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
		);
		// 2 KBs × (RESULT_LIMIT + 10 − (RESULT_LIMIT − 1)) = 22 hidden rows.
		expect(String(result.truncated)).toContain(
			"22 rows — truncated in 2 of 2 KBs",
		);
		expect(String(result.truncated)).toContain("full result in");
	});

	it("rejects agent-supplied method/aux params at the tool schema", async () => {
		const { tools, pi, hooks } = fakePiWithTools();
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
		// though every returned row was in scope. The rows ride inline, so
		// the marker names no path — there is nothing the pointer could add.
		expect(String(envelope.truncated)).toBe(
			`${RESULT_LIMIT} rows — refine the query`,
		);
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

	it("an oversized payload spills the full rows: preview + path in the envelope, bytes in the file", async () => {
		const rows = Array.from({ length: 10 }, (_, i) => ({
			id: `b${i}`,
			root_id: "d1",
			box: "nb-r",
			content: "y".repeat(1000),
		}));
		const { run } = await executeQuery(rows);
		const envelope = await run("SELECT id, root_id, box, content FROM blocks");
		expect(envelope.rows).toBeUndefined();
		// Oversized but under the injected LIMIT: spilling fires, the
		// truncation marker does not — the two mechanisms stay independent.
		expect(envelope.truncated).toBeUndefined();
		expect(String(envelope.preview).length).toBeLessThanOrEqual(
			PREVIEW_CHARS + 1,
		);
		const path = String(envelope.fullResultPath);
		expect(path).toMatch(/kb_query-[0-9a-f]{16}\.jsonl$/);
		// The spill holds every row, untruncated — the mechanism's core promise.
		const spilled = readSpilledJsonl<{ id: string; content: string }>(path);
		expect(spilled).toHaveLength(10);
		expect(spilled[4]).toMatchObject({ id: "b4", content: "y".repeat(1000) });
	});

	it("oversized AND saturated: the truncation marker rides the spill path", async () => {
		const rows = Array.from({ length: RESULT_LIMIT }, (_, i) => ({
			id: `b${i}`,
			root_id: "d1",
			box: "nb-r",
			content: "y".repeat(1000),
		}));
		const { run } = await executeQuery(rows);
		const envelope = await run("SELECT id, root_id, box, content FROM blocks");
		expect(String(envelope.truncated)).toContain(
			`full result in ${String(envelope.fullResultPath)}`,
		);
	});
});

describe("read tool", () => {
	it("the ownership query doubles as the scope check — a docId from another KB returns no rows", async () => {
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
			ContentBaselines.create(),
		);
		expect(result.status).toBe("error");
		expect(result.message).toContain("no doc 'foreign-doc'");
	});

	it("caps the outline at OUTLINE_HEADINGS inline lines with a spill pointer", async () => {
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
			ContentBaselines.create(),
		);
		const lines = String(result.outline).split("\n");
		expect(lines).toHaveLength(201); // 200 + the pointer line
		expect(lines.at(-1)).toContain("50 more");
		expect(result.fullOutlinePath).toBeDefined();
		// The spill holds every heading, not the capped 200.
		const spilled = readSpilledJsonl<{ id: string }>(
			String(result.fullOutlinePath),
		);
		expect(spilled).toHaveLength(250);
		expect(spilled[0]?.id).toBe("h0");
		expect(spilled.at(-1)?.id).toBe("h249");
		// The served lines ride the canonical renderer — same notation a
		// write flow's outline echo shows.
		expect(lines[0]).toBe("## Heading 0 → h0");
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

	it("the read tool description carries the pinned outline-notation markers", () => {
		const { pi, tools: toolDefs, hooks } = fakePiWithTools();
		registerReadToolsAndToolset(pi, hooks);
		const description = (
			toolDefs.get("kb_read") as { description?: string } | undefined
		)?.description as string;
		// the anchor payload + the kernel write-parent wording
		expect(description).toContain("→ <blockID>");
		expect(description).toContain("(not targetable)");
		expect(description).toContain("[unnamed]");
	});
});

describe("degraded session (shape clause, asserted with the registered tools)", () => {
	it("a shape failure keeps the tools registered and rejects calls with the problem named", async () => {
		const { pi, toolDefs } = fakePi();
		const degraded = validation();
		degraded.shapeErrors = ["defaultKBs must be an array of KB name strings"];
		const kernelCalls: unknown[] = [];
		const toolset = registerReadToolsAndToolset(pi, {
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
		expect([...toolDefs.keys()]).toEqual(["kb_query", "kb_search", "kb_read"]);
		// Tools stay registered — masking never happened; the gate refuses.
		const query = toolDefs.get("kb_query") as unknown as {
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

/** Register the read tools on a bare fake pi and return the requested tool
 * definition plus the baselines instance the tools were wired with. `kernel`
 * defaults to a query-only stub that records every SQL statement into
 * `kernelCalls`; tests needing richer kernels pass their own. */
function registeredReadTool(
	opts: {
		validation?: SessionValidation;
		breaker?: CircuitBreaker;
		tool?: string;
		kernel?: unknown;
	} = {},
) {
	const { pi, toolDefs } = fakePi();
	const kernelCalls: unknown[] = [];
	const baselines = ContentBaselines.create();
	registerReadToolsAndToolset(pi, {
		getValidation: () => opts.validation ?? validation(),
		getKernel: () =>
			(opts.kernel ?? {
				baseUrl: "http://127.0.0.1:6806",
				query: async (stmt: string) => {
					kernelCalls.push(stmt);
					return [];
				},
			}) as never,
		breaker: opts.breaker ?? new CircuitBreaker(),
		baselines,
	});
	return {
		baselines,
		kernelCalls,
		tool: toolDefs.get(opts.tool ?? "kb_read") as unknown as {
			description?: string;
			parameters?: unknown;
			execute?: (
				id: string,
				params: unknown,
				signal: undefined,
				onUpdate: undefined,
				ctx: unknown,
			) => Promise<{ content: { text: string }[] }>;
		},
	};
}

// ---------------------------------------------------------------------------
// Served-content baselines (fresh-content precondition, read-side serve leg)
// ---------------------------------------------------------------------------

describe("read tools seed served-content baselines", () => {
	const type = (r: { content: { text: string }[] }) =>
		JSON.parse(r.content[0]!.text) as Record<string, unknown>;

	it("kb_read records a baseline for each heading the outline serves", async () => {
		const { baselines, tool } = registeredReadTool({
			kernel: {
				...kernelStub().client,
				async query(_stmt: string) {
					// ownership route
					return [{ root_id: "d1" }];
				},
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
		expect(baselines.servedHash("h1")).toBe(contentHash("Heading"));
	});

	it("kb_query records baselines for rows that selected id + content", async () => {
		const { baselines, tool } = registeredReadTool({
			tool: "kb_query",
			kernel: {
				baseUrl: "http://127.0.0.1:6806",
				async query(_stmt: string) {
					return [
						{ id: "p1", content: "first paragraph", box: "nb-r" },
						// A content-less projection (refs-table row shape) — skipped.
						{ id: "r1", def_block_id: "p1", box: "nb-r" },
					];
				},
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
	const parse = (r: { content: { text: string }[] }) =>
		JSON.parse(r.content[0]!.text) as Record<string, unknown>;

	// docId is meaningless to discovery — the scope branch ignores it.
	it.each([
		{
			name: "returns the active set with zero kernel calls",
			params: { kb: "kbs" },
		},
		{
			name: "a discovery call carrying a docId still returns the scope branch (docId ignored)",
			params: { kb: "kbs", docId: "20260101-x" },
		},
	])("$name", async ({ params }) => {
		const { tool: read, kernelCalls } = registeredReadTool({
			validation: validation(),
		});
		const envelope = parse(
			await read.execute!("id", params, undefined, undefined, ctx2("sess")),
		);
		expect(envelope.status).toBe("ok");
		expect(envelope.kb).toBe("kbs");
		expect(envelope.message).toBe("recipes, projects");
		expect(envelope.names).toEqual(["recipes", "projects"]);
		expect(kernelCalls).toHaveLength(0);
	});

	it("empty scope uses EMPTY_SCOPE_MESSAGE verbatim with the same marker shape", async () => {
		const v = validation();
		v.scope = [];
		const { tool: read } = registeredReadTool({ validation: v });
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

	it("a rate-limit-skipped validation names the skip, not an empty scope", async () => {
		// The scope is also empty in this state, but "no KBs in scope" would
		// misstate it — the set is unknown, not empty.
		const v = validation();
		v.skippedDueToRateLimit = true;
		const { tool: read, kernelCalls } = registeredReadTool({ validation: v });
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
		expect(envelope.message).toBe(RATE_LIMIT_SKIP_MESSAGE);
		expect(envelope.names).toEqual([]);
		expect(kernelCalls).toHaveLength(0);
	});

	it("a shape-degraded session still refuses discovery (the short-circuit sits after the shape check)", async () => {
		const v = validation();
		v.shapeErrors = ["kbs must be an array"];
		const { tool: read, kernelCalls } = registeredReadTool({ validation: v });
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
		const breaker = new CircuitBreaker();
		// Trip the breaker.
		for (let i = 0; i < 3; i++) breaker.recordAuthFailure();
		expect(breaker.tripped).toBe(true);
		const { tool: read, kernelCalls } = registeredReadTool({
			validation: validation(),
			breaker,
		});
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
		const breaker = new CircuitBreaker();
		breaker.recordRateLimitFromVerdict(60, Date.now());
		const { tool: read, kernelCalls } = registeredReadTool({
			validation: validation(),
			breaker,
		});
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

	// One refusal path for a missing docId — the tool normalizes "" to
	// missing (tools.ts `docId === undefined || docId === ""`) — so both
	// shapes get the three-exit guidance inside the gated op.
	it.each([
		{
			name: "valid kb with docId absent is refused with the three-exit guidance inside the gated op",
			params: { kb: "recipes" },
		},
		{
			name: "empty-string docId counts as missing",
			params: { kb: "recipes", docId: "" },
		},
	])("$name", async ({ params }) => {
		const { tool: read, kernelCalls } = registeredReadTool({
			validation: validation(),
		});
		const envelope = parse(
			await read.execute!("id", params, undefined, undefined, ctx2("sess")),
		);
		expect(envelope.status).toBe("refused");
		const message = String(envelope.message);
		expect(message).toContain("docId is required");
		expect(message).toContain("kb_query");
		expect(message).toContain('kb: "kbs"');
		expect(message).not.toContain("rows"); // never a doc listing or metrics
		expect(kernelCalls).toHaveLength(0);
	});

	it("a near-miss kb name (separator guess) gets the unknown-KB rejection, not the guidance", async () => {
		const { tool: read } = registeredReadTool({
			validation: validation(),
		});
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
		const { tool: read } = registeredReadTool({ validation: validation() });
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
		const { tool: read } = registeredReadTool({ validation: validation() });
		expect(read.description).toContain('kb: "kbs"');
	});

	it('kb_query rejects kb: ["kbs"] via the existing unknown-KB rejection (no special case)', async () => {
		const { tool: query, kernelCalls } = registeredReadTool({
			validation: validation(),
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
