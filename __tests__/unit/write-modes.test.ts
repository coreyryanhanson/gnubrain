// Write-mode tests — remaining write modes (edit/append/replace-section/
// delete/move), the write-result contract, stale-target verification, the
// fresh-content precondition, anchor derivation, and the description
// doctrine lines — executed through the registered kb_write definition
// on a fake-pi harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import { SiYuanApiError } from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import type { SessionValidation } from "../../validation.js";
import {
	createContentBaselines,
	createWriteConfirmState,
	deriveAppendAnchor,
	deriveMoveAnchor,
	modeShapeProblem,
	registerWriteTool,
	sectionDeleteSet,
	type ContentBaselines,
	type WriteConfirmFn,
	type WriteKernelClient,
	type WriteParams,
	type WriteToolHooks,
} from "../../write.js";
import type { WalkedBlock } from "../../tools.js";

function validation() {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "recipes", notebook: "nb-r" }],
		},
		shapeErrors: [],
		probe: "ok",
		kernelVersion: "3.8.3",
		validKBs: new Map([["recipes", "nb-r"]]),
		scope: ["recipes"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	} satisfies SessionValidation;
}

function walkBlock(
	id: string,
	type: string,
	subType: string,
	content: string,
	depth = 1,
): WalkedBlock {
	return { id, type, subType, content, depth };
}

interface StubConfig {
	blockRows?: Record<string, unknown>[];
	contentRows?: Record<string, unknown>[];
	refRows?: Record<string, unknown>[];
	hpathRows?: Record<string, unknown>[];
	parentDocRows?: Record<string, unknown>[];
	/** docId → root row (ownership + echo routes discriminate by id). */
	docRoots?: Record<string, { content: string; hpath: string } | undefined>;
	/** docId → child-block rows (walks discriminate by doc). */
	childrenFor?: Record<string, unknown[]>;
	onInsert?: () => void;
	onDelete?: () => void;
	onMove?: () => void;
	onUpdate?: () => void;
}

/** Kernel stub with a SQL router over the mode-flow routes (ownership, root
 * echo, block-in-doc, content re-check, refs) and the block-write methods.
 * The returned `childrenFor` map is live — tests mutate it inside the
 * write-callbacks to simulate the kernel applying (or rolling back) an op. */
function writeKernelStub(config: StubConfig = {}) {
	const calls: { method: string; args: unknown }[] = [];
	const tx = [{ doOperations: [{ id: "b-new" }] }];
	const docRoots = config.docRoots ?? {
		"d-doc": { content: "Docker Networking", hpath: "/Docker Networking" },
	};
	const childrenFor: Record<string, unknown[]> = {
		"d-doc": [],
		...JSON.parse(JSON.stringify(config.childrenFor ?? {})),
	};
	const stmtDocId = (stmt: string): string | undefined =>
		/id = '([^']+)'/.exec(stmt)?.[1];
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => "3.8.3",
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (stmt.includes("FROM refs")) return config.refRows ?? [];
			if (stmt.includes("root_id IN")) return config.hpathRows ?? [];
			if (stmt.includes("WHERE id IN")) return config.contentRows ?? [];
			if (stmt.includes("AND root_id =")) return config.blockRows ?? [];
			if (stmt.includes("SELECT parent_id")) return config.parentDocRows ?? [];
			if (
				stmt.includes("SELECT root_id, content, hpath") ||
				stmt.includes("SELECT root_id FROM blocks")
			) {
				const docId = stmtDocId(stmt);
				const root = docId === undefined ? undefined : docRoots[docId];
				return root === undefined
					? []
					: [{ root_id: docId, content: root.content, hpath: root.hpath }];
			}
			throw new Error(`stub has no route for: ${stmt}`);
		},
		async search() {
			throw new Error("write flow never searches");
		},
		async exportMarkdown(id) {
			calls.push({ method: "exportMarkdown", args: id });
			return { hPath: "/doc", content: `# markdown of ${id}\nbody` };
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			return (childrenFor[id] ?? []) as Record<string, unknown>[];
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			return "d-new";
		},
		async updateBlock(params) {
			calls.push({ method: "updateBlock", args: params });
			config.onUpdate?.();
			return tx;
		},
		async insertBlock(params) {
			calls.push({ method: "insertBlock", args: params });
			config.onInsert?.();
			return tx;
		},
		async appendBlock(params) {
			calls.push({ method: "appendBlock", args: params });
			config.onInsert?.();
			return tx;
		},
		async deleteBlock(id) {
			calls.push({ method: "deleteBlock", args: id });
			config.onDelete?.();
			return tx;
		},
		async moveBlock(params) {
			calls.push({ method: "moveBlock", args: params });
			config.onMove?.();
			return null;
		},
		async removeDocByID(id) {
			calls.push({ method: "removeDocByID", args: id });
			return null;
		},
		async moveDocsByID(params) {
			calls.push({ method: "moveDocsByID", args: params });
			config.onMove?.();
			return null;
		},
	};
	return { calls, client, childrenFor };
}

type Details = Record<string, unknown> & { status: string; message: string };
type Exec = (params: Record<string, unknown>) => Promise<Details>;

/** Register kb_write on a fake pi and return an execute() bound to an
 * interactive ctx (confirm always true unless `confirm` overrides). The
 * optional `mutate` runs inside the confirm callback — the mid-flow
 * kernel-side change the fresh-content legs exercise. */
function setup(
	config: StubConfig = {},
	confirm: WriteConfirmFn = async () => true,
	mutate?: () => void,
): {
	execute: Exec;
	calls: { method: string; args: unknown }[];
	confirmCalls: { title: string; message: string }[];
	childrenFor: Record<string, unknown[]>;
} {
	let registered: { execute: unknown } | undefined;
	const pi = {
		registerTool(tool: { name: string; execute: unknown }) {
			registered = tool;
		},
	};
	const kernel = writeKernelStub(config);
	const confirmCalls: { title: string; message: string }[] = [];
	registerWriteTool(
		pi as never,
		{
			getValidation: () => validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: createContentBaselines(),
			confirm: async (title: string, message: string, opts) => {
				confirmCalls.push({ title, message });
				mutate?.();
				return confirm(title, message, opts);
			},
		} as WriteToolHooks,
	);
	const ctx = {
		sessionManager: { getSessionId: () => "sess-5" },
		hasUI: true,
		ui: { confirm: async () => true },
	};
	const tool = registered as unknown as {
		execute: (
			id: string,
			params: WriteParams,
			s: undefined,
			o: undefined,
			c: unknown,
		) => Promise<{ details: Details }>;
	};
	const execute: Exec = async (params) =>
		(await tool.execute("id", params as WriteParams, undefined, undefined, ctx))
			.details;
	return {
		execute,
		calls: kernel.calls,
		confirmCalls,
		childrenFor: kernel.childrenFor,
	};
}

/** setup() variant exposing the hooks' baselines map for direct assertions. */
function setupWithBaselines(config: StubConfig = {}): {
	execute: Exec;
	calls: { method: string; args: unknown }[];
	baselines: ContentBaselines;
} {
	let registered: { execute: unknown } | undefined;
	const pi = {
		registerTool(tool: { name: string; execute: unknown }) {
			registered = tool;
		},
	};
	const kernel = writeKernelStub(config);
	const baselines = createContentBaselines();
	registerWriteTool(
		pi as never,
		{
			getValidation: () => validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines,
		} as WriteToolHooks,
	);
	const ctx = {
		sessionManager: { getSessionId: () => "sess-5" },
		hasUI: true,
		ui: { confirm: async () => true },
	};
	const tool = registered as unknown as {
		execute: (...a: unknown[]) => Promise<{ details: Details }>;
	};
	const execute: Exec = async (params) =>
		(await tool.execute("id", params as WriteParams, undefined, undefined, ctx))
			.details;
	return { execute, calls: kernel.calls, baselines };
}

const editBase = {
	kb: "recipes",
	mode: "edit",
	docId: "d-doc",
	blockId: "b-1",
	markdown: "corrected body",
};

// ---------------------------------------------------------------------------
// Mode-target shape (schema table) — zero kernel calls
// ---------------------------------------------------------------------------

describe("mode-target shape (schema table)", () => {
	const cases: [WriteParams, string][] = [
		[{ kb: "r", mode: "junk" } as WriteParams, "mode 'junk' is not supported"],
		[
			{ kb: "r", mode: "edit", docId: "d" } as WriteParams,
			"mode 'edit' requires blockId",
		],
		[
			{ kb: "r", mode: "replace-section", docId: "d" } as WriteParams,
			"mode 'replace-section' requires headingId",
		],
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", doc: true },
			"exactly one of blockId or doc: true",
		],
		[
			{ kb: "r", mode: "move", docId: "d", doc: true, toHeadingId: "h" },
			"toHeadingId is block-level only",
		],
		[
			{ kb: "r", mode: "move", docId: "d", blockId: "b" },
			"block-level move requires toDocId",
		],
		[
			{ kb: "r", mode: "edit", docId: "d", blockId: "b", topic: "x" },
			"mode 'edit' does not take: topic",
		],
		[
			{ kb: "r", mode: "move", docId: "d", blockId: "b", markdown: "x" },
			"mode 'move' does not take: markdown",
		],
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", markdownFile: "/x" },
			"mode 'delete' does not take: markdownFile",
		],
	];
	it.each(cases)("rejects %# with the reason named", (params, expected) => {
		expect(modeShapeProblem(params as WriteParams)).toContain(expected);
	});

	it("accepts every declared shape", () => {
		expect(modeShapeProblem(editBase as WriteParams)).toBeUndefined();
		expect(
			modeShapeProblem({ kb: "r", mode: "append", docId: "d" } as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "move",
				docId: "d",
				blockId: "b",
				toDocId: "t",
			} as WriteParams),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// edit — fresh-content precondition (decision record)
// ---------------------------------------------------------------------------

describe("edit", () => {
	it("applies via updateBlock and echoes the contract fields", async () => {
		const { execute, calls } = setup({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
		});
		const result = await execute(editBase);
		expect(result.status).toBe("ok");
		expect(result.docId).toBe("d-doc");
		expect(result.title).toBe("Docker Networking");
		expect(result.hpath).toBe("/Docker Networking");
		expect(result.outline).toBeDefined();
		expect(
			calls.filter((c) => c.method === "updateBlock").map((c) => c.args),
		).toEqual([{ id: "b-1", data: "corrected body" }]);
	});

	it("no-baseline fallback: the dialog displays the block's current content; approval establishes the baseline", async () => {
		const { execute, confirmCalls, calls } = setup({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
		});
		const result = await execute(editBase);
		expect(result.status).toBe("ok");
		expect(confirmCalls[0]?.message).toContain("current content");
		expect(confirmCalls[0]?.message).toContain("stale paragraph");
		// The re-check ran and matched — the write fired exactly once.
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	it("post-approval change → stale_content refusal with current content + fresh outline, zero kernel write calls", async () => {
		const harness = setupWithEditMutation();
		const result = await harness.execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("concurrently rewritten");
		expect(result.outline).toBeDefined();
		expect(
			harness.calls.filter((c) => c.method === "updateBlock"),
		).toHaveLength(0);
	});

	it("matching re-check proceeds; kernel errors surface verbatim with the fresh outline", async () => {
		const failing = setup({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
			onUpdate: () => {
				throw new SiYuanApiError(500, -1, "block [b-1] not found");
			},
		});
		const refused = await failing.execute(editBase);
		expect(refused.status).toBe("error");
		expect(refused.message).toContain("block [b-1] not found");
		expect(refused.outline).toBeDefined();
	});

	it("a missing/foreign blockId errors with zero kernel writes", async () => {
		const { execute, calls } = setup(); // blockRows route returns []
		const orphan = await execute({ ...editBase, blockId: "b-ghost" });
		expect(orphan.status).toBe("error");
		expect(orphan.message).toContain("b-ghost");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("the successful write result refreshes the served-content baseline", async () => {
		const { execute, baselines } = setupWithBaselines({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
		});
		await execute(editBase);
		// The post-write walk's content became the baseline — a follow-up
		// edit on the same block rides it instead of the fallback.
		expect(baselines.servedHash("b-1")).toBeDefined();
	});
});

/** edit harness whose kernel-side content flips between the baseline read
 * and the post-approval re-check (the race the precondition exists for). */
function setupWithEditMutation(): {
	execute: Exec;
	calls: { method: string; args: unknown }[];
} {
	let registered: { execute: unknown } | undefined;
	const pi = {
		registerTool(tool: { name: string; execute: unknown }) {
			registered = tool;
		},
	};
	const kernel = writeKernelStub({
		blockRows: [{ id: "b-1", content: "stale paragraph" }],
	});
	registerWriteTool(
		pi as never,
		{
			getValidation: () => validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: createContentBaselines(),
			confirm: async () => true,
		} as WriteToolHooks,
	);
	// The re-check's content read (`WHERE id IN`) serves the rewritten form —
	// the kernel-side change landed after approval (the baseline was
	// established from the pre-dialog block read; the re-check re-reads NOW).
	const baseQuery = kernel.client.query.bind(kernel.client);
	let rechecked = false;
	kernel.client.query = async (stmt: string) => {
		const rows = await baseQuery(stmt);
		if (stmt.includes("WHERE id IN") && !rechecked) {
			rechecked = true;
			return [{ id: "b-1", content: "concurrently rewritten" }];
		}
		return rows;
	};
	const ctx = {
		sessionManager: { getSessionId: () => "sess-5" },
		hasUI: true,
		ui: { confirm: async () => true },
	};
	const tool = registered as unknown as {
		execute: (...a: unknown[]) => Promise<{ details: Details }>;
	};
	const execute: Exec = async (params) =>
		(await tool.execute("id", params as WriteParams, undefined, undefined, ctx))
			.details;
	return { execute, calls: kernel.calls };
}

// ---------------------------------------------------------------------------
// append — tool-derived nextID anchor + walk-set verification
// ---------------------------------------------------------------------------

const SECTION_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
};

describe("append", () => {
	const appendParams = (headingId?: string) => ({
		kb: "recipes",
		mode: "append",
		docId: "d-doc",
		...(headingId !== undefined ? { headingId } : {}),
		markdown: "new fact",
	});

	it("anchors nextID at the next heading; echoes anchor + newBlockId", async () => {
		// The kernel applies the insert at insert time: the minted block
		// appears in the post-write tree only (never in the pre-write walk).
		const { execute, calls, childrenFor } = setup({
			childrenFor: SECTION_DOC,
			onInsert: () => {
				childrenFor["d-doc"] = [
					...SECTION_DOC["d-doc"],
					walkBlock("b-new", "p", "", "new fact"),
				];
			},
		});
		const result = await execute(appendParams("h1"));
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		expect(result.newBlockId).toBe("b-new");
		const insert = calls.find((c) => c.method === "insertBlock");
		const insertArgs =
			insert === undefined ? undefined : (insert.args as { nextID?: string });
		expect(insertArgs?.nextID).toBe("h2");
	});

	it("omitted headingId and final-section heading → appendBlock on the doc root", async () => {
		const docEnd = setup({
			childrenFor: SECTION_DOC,
			onInsert: () => {
				docEnd.childrenFor["d-doc"] = [
					...SECTION_DOC["d-doc"],
					walkBlock("b-new", "p", "", "new fact"),
				];
			},
		});
		const result = await docEnd.execute(appendParams());
		expect(result.anchor).toBe("appendBlock(root) — no next heading");
		const insert = docEnd.calls.find((c) => c.method === "appendBlock");
		expect(insert?.args).toEqual({ data: "new fact", parentID: "d-doc" });

		const trailing = setup({
			childrenFor: SECTION_DOC,
			onInsert: () => {
				trailing.childrenFor["d-doc"] = [
					...SECTION_DOC["d-doc"],
					walkBlock("b-new", "p", "", "new fact"),
				];
			},
		});
		const lastHeading = await trailing.execute(appendParams("h2"));
		expect(lastHeading.anchor).toBe("appendBlock(root) — no next heading");
	});

	it("walk-set diff: a returned id absent from the post-write tree → error (silent rollback)", async () => {
		const appended = setup({ childrenFor: SECTION_DOC }); // the tree never changes
		const result = await appended.execute(appendParams());
		expect(result.status).toBe("error");
		expect(result.message).toContain("rolled back silently");
		expect(result.outline).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// replace-section — delete-set display, insert-before-delete, invalidRefs
// ---------------------------------------------------------------------------

const REPLACE_DOC = {
	// The boundary heading is same-level (h1): the section is [p1, p2] — the
	// same-or-shallower pin (deeper headings would belong to the section).
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "old one"),
		walkBlock("p2", "p", "", "old two"),
		walkBlock("h2", "h", "h1", "Details"),
		walkBlock("p3", "p", "", "tail"),
	],
};

const replaceParams = {
	kb: "recipes",
	mode: "replace-section",
	docId: "d-doc",
	headingId: "h1",
	markdown: "rewritten section",
};

describe("replace-section", () => {
	it("enumerates the delete set by walk, inserts BEFORE deleting, preserves the boundary", async () => {
		const harness = setup({
			childrenFor: REPLACE_DOC,
			onInsert: () => {
				harness.childrenFor["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 3),
					walkBlock("b-new", "p", "", "rewritten section"),
					...REPLACE_DOC["d-doc"].slice(3),
				];
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("ok");
		const insertIndex = harness.calls.findIndex(
			(c) => c.method === "insertBlock",
		);
		const deleteIndexes = harness.calls
			.map((c, i) => (c.method === "deleteBlock" ? i : -1))
			.filter((i) => i >= 0);
		expect(deleteIndexes.length).toBe(2);
		expect(insertIndex).toBeLessThan(deleteIndexes[0] as number);
		// Only the section's blocks deleted — the boundary heading and the
		// following section survive.
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p1", "p2"]);
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		expect(result.newBlockId).toBe("b-new");
		// Outline freshness: the result outline reflects the post-write
		// tree — the swept blocks are gone from it.
		expect(result.outline).not.toContain("old one");
		expect(result.outline).not.toContain("old two");
	});

	it("a failed delete after a successful insert leaves duplication, never loss", async () => {
		let deletes = 0;
		const harness = setup({
			childrenFor: REPLACE_DOC,
			onInsert: () => {
				harness.childrenFor["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 3),
					walkBlock("b-new", "p", "", "rewritten section"),
					...REPLACE_DOC["d-doc"].slice(3),
				];
			},
			onDelete: () => {
				deletes += 1;
				if (deletes === 2) {
					throw new SiYuanApiError(500, -1, "kernel gone mid-sweep");
				}
			},
		});
		const result = await harness.execute(replaceParams);
		// The insert landed first (visible duplication), the failure surfaces.
		expect(result.status).toBe("error");
		expect(result.message).toContain("kernel gone mid-sweep");
	});

	it("the confirmation displays the delete set: count, content, inbound refs + referring hpaths", async () => {
		const { execute, confirmCalls } = setup({
			childrenFor: REPLACE_DOC,
			refRows: [{ root_id: "d-other" }],
			hpathRows: [{ hpath: "/Other doc" }],
		});
		await execute(replaceParams);
		const message = confirmCalls[0]?.message ?? "";
		expect(message).toContain("delete set: 2 block(s)");
		expect(message).toContain("old one");
		expect(message).toContain("old two");
		expect(message).toContain("inbound refs: 1");
		expect(message).toContain("/Other doc");
		expect(message).toContain("the heading ID survives");
	});

	it("delete-bearing results carry invalidRefs (write-result contract)", async () => {
		const harness = setup({
			childrenFor: REPLACE_DOC,
			refRows: [{ root_id: "d-other" }],
			hpathRows: [{ hpath: "/Other doc" }],
			onInsert: () => {
				harness.childrenFor["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 3),
					walkBlock("b-new", "p", "", "rewritten section"),
					...REPLACE_DOC["d-doc"].slice(3),
				];
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.invalidRefs).toEqual({ count: 1, hpaths: ["/Other doc"] });
	});

	it("final section: the sweep runs to end of doc (trailing content deleted), anchor is appendBlock(root)", async () => {
		const harness = setup({
			childrenFor: REPLACE_DOC,
			onInsert: () => {
				harness.childrenFor["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 4),
					walkBlock("b-new", "p", "", "rewritten section"),
				];
			},
		});
		const result = await harness.execute({ ...replaceParams, headingId: "h2" });
		expect(result.anchor).toBe("appendBlock(root) — no next heading");
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p3"]);
		expect(harness.calls.find((c) => c.method === "appendBlock")).toBeDefined();
	});

	it("an unresolvable insert (silent rollback) refuses the deletes — the old section is untouched", async () => {
		const { execute, calls } = setup({
			childrenFor: REPLACE_DOC,
		}); // the tree never shows the minted block
		const result = await execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("the old section is untouched");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("stale delete-set content → stale_content refusal before any kernel write", async () => {
		const harness = setupWithReplaceMutation();
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "updateBlock" ||
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock",
			),
		).toHaveLength(0);
	});
});

/** replace-section harness whose kernel-side delete-set content flips
 * between the walk-served baseline and the post-approval re-check. */
function setupWithReplaceMutation(): {
	execute: Exec;
	calls: { method: string; args: unknown }[];
} {
	let registered: { execute: unknown } | undefined;
	const pi = {
		registerTool(tool: { name: string; execute: unknown }) {
			registered = tool;
		},
	};
	const kernel = writeKernelStub({ childrenFor: REPLACE_DOC });
	registerWriteTool(
		pi as never,
		{
			getValidation: () => validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: createContentBaselines(),
			confirm: async () => true,
		} as WriteToolHooks,
	);
	// Every content read (`WHERE id IN` — the post-approval re-check; no
	// id-IN reads happen before the dialog in this flow) serves the
	// rewritten p1.
	const baseQuery = kernel.client.query.bind(kernel.client);
	kernel.client.query = async (stmt: string) => {
		if (stmt.includes("WHERE id IN")) {
			return [
				{ id: "p1", content: "concurrently rewritten" },
				{ id: "p2", content: "old two" },
			];
		}
		return baseQuery(stmt);
	};
	const ctx = {
		sessionManager: { getSessionId: () => "sess-5" },
		hasUI: true,
		ui: { confirm: async () => true },
	};
	const tool = registered as unknown as {
		execute: (...a: unknown[]) => Promise<{ details: Details }>;
	};
	const execute: Exec = async (params) =>
		(await tool.execute("id", params as WriteParams, undefined, undefined, ctx))
			.details;
	return { execute, calls: kernel.calls };
}

// ---------------------------------------------------------------------------
// delete — walk-set evidence + the doc-level pinned shape
// ---------------------------------------------------------------------------

describe("delete", () => {
	it("block-level: targetGone from the post-write walk set, invalidRefs echo", async () => {
		const { execute, calls, childrenFor } = setup({
			blockRows: [{ id: "p1", content: "doomed" }],
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
			// The kernel applies the delete: p1 vanishes from the tree.
			onDelete: () => {
				childrenFor["d-doc"] = [];
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("ok");
		expect(result.targetGone).toBe(true);
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1"]);
	});

	it("a kernel success no-op still reports ok — with the walk-set evidence naming it", async () => {
		// childrenFor keeps the block post-delete: the kernel "deleted"
		// nothing (ErrBlockNotFound → nil, stale-target record).
		const { execute } = setup({
			blockRows: [{ id: "p1", content: "survivor" }],
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "survivor")] },
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("ok");
		expect(result.targetGone).toBe(false);
		expect(result.message).toContain("STILL PRESENT");
	});

	it("doc-level: removeDocByID fires and the result carries only invalidRefs (pinned shape)", async () => {
		const { execute, calls } = setup({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "body")] },
			refRows: [{ root_id: "d-other" }],
			hpathRows: [{ hpath: "/Other doc" }],
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		expect(
			calls.filter((c) => c.method === "removeDocByID").map((c) => c.args),
		).toEqual(["d-doc"]);
		expect(Object.keys(result).sort()).toEqual([
			"invalidRefs",
			"kb",
			"message",
			"status",
		]);
		expect(result.invalidRefs).toEqual({ count: 1, hpaths: ["/Other doc"] });
	});
});

// ---------------------------------------------------------------------------
// move — anchor derivation + verification + doc-level record
// ---------------------------------------------------------------------------

describe("move-anchor derivation", () => {
	it("end-of-section anchor on a plain section", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("p2", "p", "", "two"),
		];
		expect(deriveMoveAnchor(walk, "h1")).toEqual({
			kind: "move",
			previousID: "p2",
			anchor: "previousID=p2 (end of section)",
		});
	});

	it("nested-heading recursion: section ending in a subheading → after the subsection, not inside it", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("h2", "h", "h2", "A.b"),
			walkBlock("p2", "p", "", "sub body"),
		];
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("p2");
	});

	it("trailing list container anchors at section level, never nested into the container", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("list", "l", "", "list container"),
			walkBlock("item", "i", "", "item", 2),
		];
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("list");
	});

	it("fold-state independence: the anchor derives from walk order, never fold state", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
		];
		// The walk carries no fold flag — the same data derives the same
		// anchor whether or not the kernel renders the heading folded.
		expect(deriveMoveAnchor(walk, "h1")).toEqual({
			kind: "move",
			previousID: "p1",
			anchor: "previousID=p1 (end of section)",
		});
	});

	it("omitted toHeadingId → doc end (appendBlock-on-root fallback)", () => {
		const anchor = deriveMoveAnchor(
			[walkBlock("h1", "h", "h1", "A")],
			undefined,
		);
		expect(anchor.kind).toBe("appendRoot");
	});

	it("empty section anchors on the heading itself (fold branch has nothing to jump past)", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("h2", "h", "h2", "B"),
		];
		// h2 (deeper) is h1's last section member → step into it; its empty
		// section makes h2 itself the anchor (after-heading = end-of-section).
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("h2");
	});
});

describe("sectionDeleteSet (boundary + final-section sweep)", () => {
	const walk = [
		walkBlock("h1", "h", "h1", "Top"),
		walkBlock("p1", "p", "", "one"),
		walkBlock("h2", "h", "h2", "Sub"),
		walkBlock("p2", "p", "", "two"),
		walkBlock("p3", "p", "", "three"),
	];
	it("runs to the next same-or-shallower heading; deeper headings belong to the section", () => {
		expect(sectionDeleteSet(walk, "h1").map((b) => b.id)).toEqual([
			"p1",
			"h2",
			"p2",
			"p3",
		]);
	});
	it("final section sweeps trailing content to end of doc", () => {
		expect(sectionDeleteSet(walk, "h2").map((b) => b.id)).toEqual(["p2", "p3"]);
	});
	it("an unresolvable heading yields an empty set (the flow refuses)", () => {
		expect(sectionDeleteSet(walk, "ghost")).toEqual([]);
	});
});

describe("deriveAppendAnchor", () => {
	it("nextID = the next heading in document order", () => {
		expect(
			deriveAppendAnchor(
				[
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("p1", "p", "", "x"),
					walkBlock("h2", "h", "h2", "B"),
				],
				"h1",
			),
		).toEqual({
			kind: "insert",
			nextID: "h2",
			anchor: "nextID=h2 (next heading)",
		});
	});

	it("no next heading → appendBlock(root)", () => {
		const anchor = deriveAppendAnchor([walkBlock("h1", "h", "h1", "A")], "h1");
		expect(anchor.kind).toBe("appendRoot");
	});

	it("no headingId → appendBlock(root)", () => {
		const anchor = deriveAppendAnchor(
			[walkBlock("h1", "h", "h1", "A")],
			undefined,
		);
		expect(anchor.kind).toBe("appendRoot");
	});
});

describe("block-level move", () => {
	const MOVE_DOC = {
		"d-doc": [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "mover"),
			walkBlock("p2", "p", "", "stay"),
		],
		"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
	};

	const moveParams = {
		kb: "recipes",
		mode: "move",
		docId: "d-doc",
		blockId: "p1",
		toDocId: "d-other",
		toHeadingId: "oh1",
	};

	/** move harness where `apply` mutates the children map kernel-side. */
	function moveHarness(apply?: () => void, stub?: Partial<StubConfig>) {
		let registered: { execute: unknown } | undefined;
		const pi = {
			registerTool(tool: { name: string; execute: unknown }) {
				registered = tool;
			},
		};
		const kernel = writeKernelStub({
			blockRows: [{ id: "p1", content: "mover" }],
			childrenFor: JSON.parse(JSON.stringify(MOVE_DOC)),
			docRoots: {
				"d-doc": {
					content: "Docker Networking",
					hpath: "/Docker Networking",
				},
				"d-other": { content: "Other doc", hpath: "/Other doc" },
			},
			...(apply ? { onMove: apply } : {}),
			...stub,
		});
		registerWriteTool(
			pi as never,
			{
				getValidation: () => validation(),
				getKernel: () => kernel.client,
				breaker: new CircuitBreaker(),
				confirmState: createWriteConfirmState(),
				baselines: createContentBaselines(),
			} as WriteToolHooks,
		);
		const ctx = {
			sessionManager: { getSessionId: () => "sess-5" },
			hasUI: true,
			ui: { confirm: async () => true },
		};
		const tool = registered as unknown as {
			execute: (...a: unknown[]) => Promise<{ details: Details }>;
		};
		const execute: Exec = async (params) =>
			(
				await tool.execute(
					"id",
					params as WriteParams,
					undefined,
					undefined,
					ctx,
				)
			).details;
		return { execute, calls: kernel.calls, childrenFor: kernel.childrenFor };
	}

	it("cross-doc: destination anchor, move via previousID, both outlines + movedBlockId", async () => {
		const harness = moveHarness(() => {
			harness.childrenFor["d-doc"] = MOVE_DOC["d-doc"].filter(
				(b) => b.id !== "p1",
			);
			harness.childrenFor["d-other"] = [
				walkBlock("oh1", "h", "h1", "Dest"),
				walkBlock("p1", "p", "", "mover"),
			];
		});
		const result = await harness.execute(moveParams);
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.outline).toBeDefined();
		expect(result.destOutline).toContain("Dest");
		const move = harness.calls.find((c) => c.method === "moveBlock");
		expect(move?.args).toEqual({ id: "p1", previousID: "oh1" });
	});

	it("same-doc move collapses to outline + anchor with movedBlockId, no destOutline", async () => {
		const harness = moveHarness(() => {
			// The kernel applies: p1 lands at doc end (no toHeadingId here —
			// the pure anchor derivation is covered by the tests above).
			harness.childrenFor["d-doc"] = [
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p2", "p", "", "stay"),
				walkBlock("p1", "p", "", "mover"),
			];
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.destOutline).toBeUndefined();
		const move = harness.calls.find((c) => c.method === "moveBlock");
		expect(move?.args).toEqual({ id: "p1", parentID: "d-doc" });
		// Same-doc: the in-hand source walk serves as the destination —
		// exactly one pre-write and one post-write source walk.
		const walks = harness.calls.filter(
			(c) => c.method === "getChildBlocks" && c.args === "d-doc",
		);
		expect(walks).toHaveLength(2);
	});

	it("a tree-level miss rolls back silently → verified-move error", async () => {
		const harness = moveHarness(); // the tree never changes
		const result = await harness.execute(moveParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("absent from the destination tree");
		expect(result.outline).toBeDefined();
		expect(result.destOutline).toBeDefined();
	});

	it("an empty-section destination anchors on the destination heading", async () => {
		const harness = moveHarness();
		await harness.execute({
			...moveParams,
			toHeadingId: "oh1",
		});
		const move = harness.calls.find((c) => c.method === "moveBlock");
		// The dest section of oh1 is empty → the heading itself is the anchor.
		expect(move?.args).toEqual({ id: "p1", previousID: "oh1" });
	});

	it("doc-level: moveDocsByID with the notebook id on un-nest; pinned result shape", async () => {
		const harness = moveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		const move = harness.calls.find((c) => c.method === "moveDocsByID");
		expect(move?.args).toEqual({ fromIDs: ["d-doc"], toID: "nb-r" });
		expect(result.outline).toBeDefined();
		expect(result.title).toBe("Docker Networking");
		expect(result.hpath).toBe("/Docker Networking");
		expect(result.anchor).toBeUndefined();
		expect(result.newBlockId).toBeUndefined();
		expect(result.movedBlockId).toBeUndefined();
		expect(result.destOutline).toBeUndefined();
	});

	it("doc-level: self-descendant pre-check rejects before the kernel (silent-filter class)", async () => {
		const harness = moveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-doc",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("own subtree");
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(0);
	});

	it("doc-level: destination nested inside the source's subtree walks the parent chain and refuses", async () => {
		const harness = moveHarness(undefined, {
			docRoots: {
				"d-doc": {
					content: "Docker Networking",
					hpath: "/Docker Networking",
				},
				"d-child": {
					content: "Child",
					hpath: "/Docker Networking/Child",
				},
			},
			parentDocRows: [{ parent_id: "d-doc" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-child",
		});
		expect(result.status).toBe("refused");
		// "silently filters" is unique to the descendant arm — the self-move
		// branch (same-KB refusal) also says "own subtree".
		expect(result.message).toContain("silently filters");
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(0);
	});

	it("doc-level: kernel rejections (the depth cap) surface verbatim", async () => {
		const harness = moveHarness(() => {
			throw new SiYuanApiError(500, -1, "depth level exceeded");
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-other",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("depth level exceeded");
	});
});

// ---------------------------------------------------------------------------
// Write-tool descriptions carry the pinned doctrine lines
// ---------------------------------------------------------------------------

describe("write-tool doctrine lines", () => {
	function registeredDescription(): string {
		let description: string | undefined;
		const pi = {
			registerTool: (t: { name: string; description: string }) => {
				if (t.name === "kb_write") description = t.description;
			},
		};
		registerWriteTool(
			pi as never,
			{
				getValidation: () => undefined,
				getKernel: () => undefined,
				breaker: new CircuitBreaker(),
				confirmState: createWriteConfirmState(),
				baselines: createContentBaselines(),
			} as WriteToolHooks,
		);
		return description ?? "";
	}

	it("pins mint-by-title / consume-by-ID, echoed targets, tool-derived anchors, replace-first, and the kbs mirror", () => {
		const description = registeredDescription();
		expect(description).toContain("mint by title");
		expect(description).toContain("consume by ID");
		expect(description).toContain("never invented");
		expect(description).toContain("always tool-derived");
		expect(description).toContain("prefer edit/replace-section over append");
		expect(description).toContain("'kbs' is read-only");
	});
});
