// writeModes tests — the tool schema + mode-target shape, the write modes
// (edit/append/replace-section/delete/move), the write-result contract,
// stale-target verification, the fresh-content precondition, and the
// description doctrine lines — executed through the registered kb_write
// definition on a fake-pi harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
} from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import {
	createWriteConfirmState,
	type WriteConfirmFn,
} from "../../writeConfirm.js";
import {
	modeShapeProblem,
	BLOCK_IN_DOC_STMT_HEAD,
	PARENT_DOC_STMT_HEAD,
	type WriteParams,
} from "../../writeModes.js";
import { OWNERSHIP_STMT_HEAD } from "../../tools.js";
import {
	base,
	registerKbWrite,
	setup as schemaSetup,
	validation,
	walkBlock,
} from "./writeHarness.js";
import { type WriteToolHooks } from "../../write.js";
import {
	createContentBaselines,
	BASELINE_CONTENTS_STMT_HEAD,
	REFS_BACKLINK_STMT_HEAD,
	REFERRING_HPATHS_STMT_HEAD,
	ROOT_ECHO_STMT_HEAD,
	type ContentBaselines,
	type WriteKernelClient,
} from "../../writeResult.js";

interface StubConfig {
	blockRows?: Record<string, unknown>[];
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
	/** Captures a setter the test calls from a mutation callback: all
	 * subsequent query() calls throw — the network drop between a landed
	 * write and the post-write verification reads. */
	armQueryError?: (arm: (err: Error) => void) => void;
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
	let queryError: Error | undefined;
	config.armQueryError?.((err) => {
		queryError = err;
	});
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => "3.8.3",
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (queryError) throw queryError;
			// Route on the production SELECT heads — a SQL rewording updates
			// the head constant in the same diff, never a silent re-route.
			if (stmt.startsWith(REFS_BACKLINK_STMT_HEAD)) {
				return config.refRows ?? [];
			}
			if (stmt.startsWith(REFERRING_HPATHS_STMT_HEAD)) {
				return config.hpathRows ?? [];
			}
			// BASELINE_CONTENTS' head is a prefix-superset of BLOCK_IN_DOC's
			// ("... WHERE id IN" vs "... WHERE id"), so it must route first.
			if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) return [];
			if (stmt.startsWith(BLOCK_IN_DOC_STMT_HEAD)) {
				return config.blockRows ?? [];
			}
			if (stmt.startsWith(PARENT_DOC_STMT_HEAD)) {
				return config.parentDocRows ?? [];
			}
			if (
				stmt.startsWith(OWNERSHIP_STMT_HEAD) ||
				stmt.startsWith(ROOT_ECHO_STMT_HEAD)
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
	const kernel = writeKernelStub(config);
	const confirmCalls: { title: string; message: string }[] = [];
	const { execute: run } = registerKbWrite({
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
	} as WriteToolHooks);
	const execute: Exec = async (params) => (await run(params)).details;
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
	const kernel = writeKernelStub(config);
	const baselines = createContentBaselines();
	const { execute: run } = registerKbWrite({
		getValidation: () => validation(),
		getKernel: () => kernel.client,
		breaker: new CircuitBreaker(),
		confirmState: createWriteConfirmState(),
		baselines,
	} as WriteToolHooks);
	const execute: Exec = async (params) => (await run(params)).details;
	return { execute, calls: kernel.calls, baselines };
}

describe("kb_write schema", () => {
	it("does not declare confirmNew (learned only from rejections)", () => {
		const { tool } = schemaSetup() as unknown as {
			tool: { parameters: unknown };
		};
		const props = Object.keys(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(props).toContain("kb");
		expect(props).toContain("mode");
		expect(props).not.toContain("confirmNew");
	});

	it("rejects kb: 'kbs' via the existing unknown-KB rejection — zero kernel calls", async () => {
		const { execute, kernel } = schemaSetup();
		const r = await execute({ ...base, kb: "kbs" });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("unknown KB 'kbs'");
		expect(kernel.calls).toHaveLength(0);
	});
});

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
	const kernel = writeKernelStub({
		blockRows: [{ id: "b-1", content: "stale paragraph" }],
	});
	const { execute: run } = registerKbWrite({
		getValidation: () => validation(),
		getKernel: () => kernel.client,
		breaker: new CircuitBreaker(),
		confirmState: createWriteConfirmState(),
		baselines: createContentBaselines(),
		confirm: async () => true,
	} as WriteToolHooks);
	// The re-check's content read (baseline SELECT) serves the rewritten
	// form — the kernel-side change landed after approval (the baseline was
	// established from the pre-dialog block read; the re-check re-reads NOW).
	const baseQuery = kernel.client.query.bind(kernel.client);
	let rechecked = false;
	kernel.client.query = async (stmt: string) => {
		const rows = await baseQuery(stmt);
		if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD) && !rechecked) {
			rechecked = true;
			return [{ id: "b-1", content: "concurrently rewritten" }];
		}
		return rows;
	};
	const execute: Exec = async (params) => (await run(params)).details;
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
		// The insert landed first (visible duplication), the failure surfaces
		// as a partial-replace envelope with the surviving state — not a bare
		// kernel message that invites a re-run (which would duplicate the body).
		expect(result.status).toBe("error");
		expect(result.message).toContain("kernel gone mid-sweep");
		expect(result.message).toContain("do NOT re-run");
		expect(result.partialReplace).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		expect(result.deletedBlockIds).toEqual(["p1"]);
		expect(result.remainingBlockIds).toEqual(["p2"]);
	});

	it("mid-sweep drop after landed deletes → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		let deletes = 0;
		const harness = setup({
			childrenFor: REPLACE_DOC,
			armQueryError: (set) => {
				arm = set;
			},
			onInsert: () => {
				harness.childrenFor["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 3),
					walkBlock("b-new", "p", "", "rewritten section"),
					...REPLACE_DOC["d-doc"].slice(3),
				];
			},
			onDelete: () => {
				deletes += 1;
				// One delete applied, then the connection drops mid-sweep.
				if (deletes === 2) arm?.(new SiYuanNetworkError());
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("post-write verification reads failed");
		expect(result.message).not.toContain("SiYuan unreachable");
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
		// Read 1 (baseline, pre-dialog) matches the walk; read 2 (the
		// post-approval re-check) serves the concurrently rewritten p1 — the
		// kernel-side change landed after approval.
		const harness = replaceQueryHarness((read) =>
			read === 1
				? [
						{ id: "p1", content: "old one" },
						{ id: "p2", content: "old two" },
					]
				: [
						{ id: "p1", content: "concurrently rewritten" },
						{ id: "p2", content: "old two" },
					],
		);
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

	it("walk/blocks representation drift does not false-positive stale_content", async () => {
		// The walk serves a plain form, blocks.content a rendered form —
		// baseline and re-check both ride blocks.content, so the replace
		// proceeds (the precondition stays representation-independent).
		const harness = replaceQueryHarness(
			() => [
				{ id: "p1", content: "old **one**" },
				{ id: "p2", content: "old **two**" },
			],
			(children) => {
				children["d-doc"] = [
					...REPLACE_DOC["d-doc"].slice(0, 3),
					walkBlock("b-new", "p", "", "rewritten section"),
					...REPLACE_DOC["d-doc"].slice(3),
				];
			},
		);
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("ok");
		expect(result.reason).toBeUndefined();
	});
});

/** replace-section harness with scripted `WHERE id IN` content reads —
 * read 1 is the pre-dialog baseline read, read 2 the post-approval
 * re-check (the two representation-matched reads the precondition rides). */
function replaceQueryHarness(
	respondIdIn: (read: number) => Record<string, unknown>[],
	applyInsert?: (children: Record<string, unknown[]>) => void,
): {
	execute: Exec;
	calls: { method: string; args: unknown }[];
	childrenFor: Record<string, unknown[]>;
} {
	const kernel = writeKernelStub({
		childrenFor: REPLACE_DOC,
		...(applyInsert
			? {
					onInsert: () => {
						applyInsert(kernel.childrenFor);
					},
				}
			: {}),
	});
	const { execute: run } = registerKbWrite({
		getValidation: () => validation(),
		getKernel: () => kernel.client,
		breaker: new CircuitBreaker(),
		confirmState: createWriteConfirmState(),
		baselines: createContentBaselines(),
		confirm: async () => true,
	} as WriteToolHooks);
	const baseQuery = kernel.client.query.bind(kernel.client);
	let idInReads = 0;
	kernel.client.query = async (stmt: string) => {
		if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) {
			idInReads += 1;
			return respondIdIn(idInReads);
		}
		return baseQuery(stmt);
	};
	const execute: Exec = async (params) => (await run(params)).details;
	return { execute, calls: kernel.calls, childrenFor: kernel.childrenFor };
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
// move — verification + doc-level record
// ---------------------------------------------------------------------------

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
		const { execute: run } = registerKbWrite({
			getValidation: () => validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: createContentBaselines(),
		} as WriteToolHooks);
		const execute: Exec = async (params) => (await run(params)).details;
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

	it("same-doc self-anchor: the block already ends the destination section → refusal, zero kernel moves", async () => {
		// MOVE_DOC's h1 section is [p1, p2] — moving p2 to its end would
		// issue moveBlock({previousID: p2}); the kernel no-ops and the walk
		// check would misreport a successful move.
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "p2", content: "stay" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p2",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("already the last member");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("same-doc doc-end self-anchor: block already last top-level of its own doc → refusal, zero kernel moves", async () => {
		// p2 is MOVE_DOC's last block; a move to doc end (toHeadingId
		// omitted → appendBlock-on-root anchor) would no-op on the kernel
		// and pass the walk-set checks as a successful move.
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "p2", content: "stay" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p2",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("already the last member");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
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
		const { tool } = registerKbWrite({
			getValidation: () => undefined,
			getKernel: () => undefined,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: createContentBaselines(),
		} as WriteToolHooks);
		return tool.description ?? "";
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

// Network drop between a landed write and its post-write verification
// reads: the result must never read as "SiYuan unreachable" — that
// invites the blind retry that duplicates or re-applies the write.
describe("network drop after a landed write", () => {
	it("edit: post-write echo-read drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
			armQueryError: (set) => {
				arm = set;
			},
			onUpdate: () => arm?.(new SiYuanNetworkError()),
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("post-write verification reads failed");
		expect(r.message).toContain("do NOT retry blindly");
		expect(r.message).not.toContain("SiYuan unreachable");
		// The mutation itself landed — the failure is in the reads.
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	it("edit: post-write read timeout classifies the same way", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute } = setup({
			blockRows: [{ id: "b-1", content: "stale paragraph" }],
			armQueryError: (set) => {
				arm = set;
			},
			onUpdate: () => arm?.(new SiYuanTimeoutError(30_000)),
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("post-write verification reads failed");
	});

	it("append: post-write verification drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			armQueryError: (set) => {
				arm = set;
			},
			onInsert: () => arm?.(new SiYuanNetworkError()),
		});
		const r = await execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new section",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(
			calls.filter(
				(c) => c.method === "insertBlock" || c.method === "appendBlock",
			),
		).toHaveLength(1);
	});
});
