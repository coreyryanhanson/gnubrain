// The additive-only contract test (docs/roadmap.md, Stability promise):
// from v1 tool names, parameter names, and response fields do not break —
// new capability arrives as new optional parameters, new fields, or new
// tools. The frozen literals below are that contract; adding a param or
// field means a deliberate, reviewed edit to this file, and a rename or
// removal fails here.

import { describe, expect, it } from "vitest";
import { PINNED_SIYUAN_VERSION } from "siyuan-kb-primitives";
import register, { type GnubrainDeps } from "../../index.js";
import {
	createFakeCtx as fakeCtx,
	createFakePi as fakePi,
} from "../helpers/fakePi.js";
import { base as createBase, setup as writeSetup } from "./writeHarness.js";

// --- frozen contract -------------------------------------------------------

const CONTRACT_TOOLS = ["kb_read", "kb_query", "kb_search", "kb_write"];

const CONTRACT_PARAMS: Record<string, string[]> = {
	kb_read: ["kb", "docId"],
	kb_query: ["kb", "sql"],
	kb_search: ["kb", "query"],
	kb_write: [
		"kb",
		"mode",
		"topic",
		"parentId",
		"markdown",
		"markdownFile",
		"docId",
		"blockId",
		"headingId",
		"placement",
		"doc",
		"toDocId",
		"toHeadingId",
	],
};

// The response-field vocabulary, frozen as the exact key set of one
// representative envelope per arm. Adding a field means a deliberate edit
// here; a rename or removal fails.
const CONTRACT_ENVELOPES: Record<string, string[]> = {
	"kb_read discovery": ["kb", "message", "names", "status"],
	"kb_read ok": [
		"content",
		"docId",
		"hpath",
		"kb",
		"message",
		"outline",
		"status",
	],
	"kb_read error": ["message", "status"],
	"kb_read refused": ["message", "status"],
	"kb_search ok": ["count", "kb", "message", "rows", "status"],
	"kb_query ok": ["boxes", "count", "kb", "message", "rows", "status"],
	"kb_write ok": [
		"docId",
		"hpath",
		"kb",
		"message",
		"outline",
		"status",
		"title",
	],
	"kb_write refused": ["message", "status"],
};

// kb_search rows carry the frozen docId/blockId vocabulary (never the raw
// kernel names id/root_id) so a hit feeds straight back into kb_read/kb_write.
const CONTRACT_SEARCH_ROW = ["blockId", "docId", "hpath", "kb", "updated"];

// --- capture ---------------------------------------------------------------

const GLOBAL_SETTINGS = JSON.stringify({
	gnubrain: {
		baseUrl: "http://127.0.0.1:6806",
		apiToken: "token",
		kbs: [{ name: "dev", notebook: "nb-1" }],
		defaultKBs: ["dev"],
	},
});

function deps(): GnubrainDeps {
	return {
		readFile: async (path: string) => {
			if (path.startsWith("/project")) {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			}
			return GLOBAL_SETTINGS;
		},
		createClient: () =>
			({
				baseUrl: "http://127.0.0.1:6806",
				getVersion: async () => PINNED_SIYUAN_VERSION,
				listNotebooks: async () => ({
					notebooks: [
						{
							id: "nb-1",
							name: "dev",
							encrypted: false,
							unlocked: true,
							closed: false,
						},
					],
				}),
				query: async (stmt: string) =>
					stmt.includes("'d1'") ? [{ root_id: "d1" }] : [],
				fullTextSearch: async () => ({
					blocks: [
						{
							id: "s1",
							rootID: "d1",
							box: "nb-1",
							hPath: "/doc",
							updated: "20260101120000",
						},
					],
					matchedBlockCount: 1,
				}),
				exportMarkdown: async () => ({
					hPath: "/doc",
					content: "# doc\nbody",
				}),
				getChildBlocks: async () => [],
			}) as never,
	};
}

const keysOf = (value: unknown): string[] =>
	typeof value === "object" && value !== null
		? Object.keys(value as Record<string, unknown>).sort()
		: [];

describe("additive-only contract", () => {
	it("registers exactly the frozen tool set with the frozen parameter names", async () => {
		const { pi, fire, tools, toolDefs } = fakePi();
		register(pi, deps());
		const { ctx } = fakeCtx();
		await fire("session_start", ctx);
		expect(tools.map((t) => t.name).sort()).toEqual([...CONTRACT_TOOLS].sort());
		expect(Object.keys(CONTRACT_PARAMS).sort()).toEqual(
			[...CONTRACT_TOOLS].sort(),
		);
		for (const [name, expected] of Object.entries(CONTRACT_PARAMS)) {
			const def = toolDefs.get(name);
			expect(def, name).toBeDefined();
			const properties = ((
				def?.parameters as { properties?: Record<string, unknown> }
			)?.properties ?? {}) as Record<string, unknown>;
			expect(Object.keys(properties).sort(), name).toEqual(
				[...expected].sort(),
			);
		}
	});

	it("the write tool's registered schema matches the write harness's", async () => {
		const { pi, fire, toolDefs } = fakePi();
		register(pi, deps());
		const { ctx } = fakeCtx();
		await fire("session_start", ctx);
		const registered = toolDefs.get("kb_write");
		const harness = writeSetup();
		expect(harness.tool.parameters).toEqual(registered?.parameters);
	});

	it("envelope shapes match the frozen per-arm key sets", async () => {
		const { pi, fire, runToolDetails } = fakePi();
		register(pi, deps());
		const { ctx } = fakeCtx();
		await fire("session_start", ctx);
		const seen: Record<string, string[]> = {};

		// kb_read — discovery, ok, error, refused arms.
		seen["kb_read discovery"] = keysOf(
			await runToolDetails("kb_read", { kb: "kbs" }, ctx),
		);
		seen["kb_read ok"] = keysOf(
			await runToolDetails("kb_read", { kb: "dev", docId: "d1" }, ctx),
		);
		seen["kb_read error"] = keysOf(
			await runToolDetails("kb_read", { kb: "dev", docId: "missing" }, ctx),
		);
		seen["kb_read refused"] = keysOf(
			await runToolDetails("kb_read", { kb: "nope", docId: "d1" }, ctx),
		);

		// kb_search / kb_query — ok arms.
		const searchDetails = await runToolDetails(
			"kb_search",
			{ kb: ["dev"], query: "docker" },
			ctx,
		);
		seen["kb_search ok"] = keysOf(searchDetails);
		seen["kb_query ok"] = keysOf(
			await runToolDetails(
				"kb_query",
				{ kb: ["dev"], sql: "SELECT id, content FROM blocks LIMIT 5" },
				ctx,
			),
		);

		for (const [arm, actual] of Object.entries(seen)) {
			expect(actual, arm).toEqual(CONTRACT_ENVELOPES[arm]);
		}

		// The search row vocabulary is part of the frozen contract.
		const row = (searchDetails as { rows?: Record<string, unknown>[] })
			?.rows?.[0];
		expect(keysOf(row)).toEqual(CONTRACT_SEARCH_ROW);
	});

	it("write envelopes match the frozen per-arm key sets", async () => {
		const write = writeSetup();
		const seen: Record<string, string[]> = {};
		seen["kb_write ok"] = keysOf(await write.execute({ ...createBase }));
		seen["kb_write refused"] = keysOf(
			await write.execute({
				kb: createBase.kb,
				mode: "bogus",
			}),
		);
		for (const [arm, actual] of Object.entries(seen)) {
			expect(actual, arm).toEqual(CONTRACT_ENVELOPES[arm]);
		}
	});
});
