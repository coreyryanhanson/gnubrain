// writeModes tests — the tool schema + mode-target shape, the write modes
// (edit/append/replace-section/delete/move), the write-result shape,
// stale-target verification, the fresh-content precondition, and the
// description doctrine lines — executed through the registered kb_write
// definition on a fake-pi harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import { headingInWalk } from "../../writeFlow.js";
import {
	BLOCK_IN_DOC_STMT_HEAD,
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	SiYuanTimeoutError,
	BLOCK_CONTENTS_STMT_HEAD,
	contentHash,
} from "siyuan-kb-primitives";
import { modeShapeProblem, type WriteParams } from "../../writeSchema.js";
import {
	base,
	registerKbWrite,
	setup,
	storedContentStub,
	walkBlock,
	writeKernelStub,
	type StubConfig,
} from "./writeHarness.js";
import { withVerifyWindow } from "siyuan-kb-primitives/testing";
import { ContentBaselines } from "../../baselines.js";
import { freshContentRefusal } from "../../writeResult.js";

describe("kb_write schema", () => {
	it("does not declare confirmNew (learned only from rejections)", () => {
		const { tool } = setup();
		const props = Object.keys(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(props).toContain("kb");
		expect(props).toContain("mode");
		expect(props).not.toContain("confirmNew");
	});

	it("rejects kb: 'kbs' via the existing unknown-KB rejection — zero kernel calls", async () => {
		const { execute, calls } = setup();
		const r = await execute({ ...base, kb: "kbs" });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("unknown KB 'kbs'");
		expect(calls).toHaveLength(0);
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
// freshContentRefusal — the per-arm session doctrine over the primitives'
// checkFreshContent judgment, driven directly on the stubbed kernel
// ---------------------------------------------------------------------------

describe("freshContentRefusal", () => {
	const ctx = { sessionId: "s1", docId: "d-doc" };

	it("unseen → adopt the live form and proceed (null)", async () => {
		// No baseline, no SQL row: the session never served the block, so
		// there is no stored value to launder — the live form becomes the
		// baseline and the caller proceeds.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "live body")] },
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("live body"));
	});

	it("seed-and-check fresh → remember (the baseline is seeded even when every arm is fresh)", async () => {
		// No baseline, but the SQL row matches the walk — the establish
		// side effect survives the promotion: the residual paths' later
		// checks compare like-for-like.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "index form")] },
			baselineRows: [{ id: "p1", content: "index form" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("index form"));
	});

	it("vanished → skipped (delete no-op class), no baseline remembered", async () => {
		// The classification (walk-absence before any SQL read, even with a
		// lingering blocks.content row inside the convergence window) is
		// falsified down-repo in the primitives' fresh.test.ts; this asserts
		// the wrapper's half — a `vanished` arm must not remember, so a
		// misclassification as `unseen` would fail the servedHash assertion.
		const stub = writeKernelStub({
			baselineRows: [{ id: "p1", content: "lingering index row" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBeUndefined();
	});

	it("stale → one refusal naming every stale target; re-baseline exactly the named set; retry proceeds", async () => {
		// Multi-stale doctrine: all stale arms in one envelope. The tool-side
		// half of the anti-laundering invariant: every re-baselined hash
		// equals the hash of the content the envelope carried — no stored
		// baseline moves without its content being visible.
		const stub = writeKernelStub({
			childrenFor: {
				"d-doc": [
					walkBlock("p1", "p", "", "rewritten one"),
					walkBlock("p2", "p", "", "rewritten two"),
					walkBlock("p3", "p", "", "untouched"),
				],
			},
		});
		const baselines = ContentBaselines.create();
		baselines.remember("p1", "old one");
		baselines.remember("p2", "old two");
		// Targets are rebuilt per call in the real flows (the served hash is
		// read at call time) — mirror that here.
		const targetsOf = () => [
			{ blockId: "p1", baselineHash: baselines.servedHash("p1") },
			{ blockId: "p2", baselineHash: baselines.servedHash("p2") },
			{ blockId: "p3", baselineHash: baselines.servedHash("p3") },
		];
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			targetsOf(),
			ctx,
		);
		expect(verdict).not.toBeNull();
		expect(verdict?.status).toBe("refused");
		expect(verdict?.reason).toBe("stale_content");
		expect(verdict?.blockId).toBe("p1");
		expect(verdict?.currentContent).toBe("rewritten one");
		expect(verdict?.staleTargets).toEqual([
			{ blockId: "p1", currentContent: "rewritten one" },
			{ blockId: "p2", currentContent: "rewritten two" },
		]);
		// The outline renders from the judged walk (headings-only — a stale
		// non-heading member's content is new information via staleTargets,
		// not the outline).
		expect(verdict?.outline).toBeDefined();
		// Re-baseline of exactly the named set — each stored hash equals the
		// content the envelope carried.
		expect(baselines.servedHash("p1")).toBe(contentHash("rewritten one"));
		expect(baselines.servedHash("p2")).toBe(contentHash("rewritten two"));
		// Refuse-loop escape: the same call now matches and returns null.
		const retry = await freshContentRefusal(
			stub.client,
			baselines,
			targetsOf(),
			ctx,
		);
		expect(retry).toBeNull();
	});

	it("empty target list → null with zero kernel calls", async () => {
		const stub = writeKernelStub({});
		const verdict = await freshContentRefusal(
			stub.client,
			ContentBaselines.create(),
			[],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(stub.calls).toHaveLength(0);
	});
});

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
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", confirmNew: true },
			"mode 'delete' does not take: confirmNew",
		],
		[
			{
				kb: "r",
				mode: "move",
				docId: "d",
				blockId: "b",
				toDocId: "t",
				placement: "section-start",
			},
			"mode 'move' does not take: placement",
		],
		[
			{ kb: "r", mode: "append", docId: "d", placement: "sideways" },
			'placement must be "section-end" or "section-start"',
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
				mode: "append",
				docId: "d",
				placement: "section-end",
			} as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "append",
				docId: "d",
				placement: "section-start",
			} as WriteParams),
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
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "create",
				topic: "t",
				confirmNew: true,
			} as WriteParams),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// edit — fresh-content precondition
// ---------------------------------------------------------------------------

describe("edit", () => {
	it("applies via updateBlock and echoes the contract fields", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
			},
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

	it("a block id passed as docId reads as no doc — rootEcho's type-'d' discrimination, zero kernel write calls", async () => {
		// b-1 exists as a block row but is not a doc root; the write path
		// refuses it instead of normalizing it to its containing doc.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
			},
		});
		const result = await execute({ ...editBase, docId: "b-1" });
		expect(result.status).toBe("error");
		expect(result.message).toContain("no doc 'b-1'");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("concurrent change → stale_content refusal with current content + fresh outline, zero kernel write calls", async () => {
		// The dialog served "stale paragraph" (the blocks index, baseline
		// seeded from it at check time); the live tree already holds the
		// kernel-side rewrite — exactly the index-lag case the tree-riding
		// precondition exists to catch.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				childrenFor: {
					"d-doc": [walkBlock("b-1", "p", "", "concurrently rewritten")],
				},
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("concurrently rewritten");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("matching re-check proceeds; kernel errors surface verbatim with the fresh outline", async () => {
		const failing = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				onUpdate: () => {
					throw new SiYuanApiError(500, -1, "block [b-1] not found");
				},
			},
		});
		const refused = await failing.execute(editBase);
		expect(refused.status).toBe("error");
		expect(refused.message).toContain("block [b-1] not found");
		expect(refused.outline).toBeDefined();
	});

	it("a missing blockId reaches the kernel — its synchronous not-found error surfaces verbatim", async () => {
		const { execute, calls } = setup({
			config: {
				// blockRows route returns [] — the target is already gone.
				onUpdate: () => {
					throw new SiYuanApiError(500, -1, "block [b-ghost] not found");
				},
			},
		});
		const orphan = await execute({ ...editBase, blockId: "b-ghost" });
		expect(orphan.status).toBe("error");
		expect(orphan.message).toContain("block [b-ghost] not found");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	it("a foreign blockId (another doc's block) is refused before any kernel write", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [
					{ id: "b-foreign", content: "other doc", root_id: "d-other" },
				],
			},
		});
		const result = await execute({ ...editBase, blockId: "b-foreign" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("belongs to another doc");
		expect(result.message).toContain("d-other");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("a document id in the blockId slot is refused before any kernel write", async () => {
		const { execute, calls } = setup({
			config: {
				// The doc's own 'd' row: root_id === docId, content is the title.
				blockRows: [
					{ id: "d-doc", content: "Doc Title", root_id: "d-doc", type: "d" },
				],
			},
		});
		const result = await execute({ ...editBase, blockId: "d-doc" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is a document id, not a block");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("verified-edit: an update tx without the target's op fails loud, not ok", async () => {
		const { execute } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				updateTx: [{ doOperations: [] }],
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("error");
		expect(result.message).toContain("verified-edit failed");
		expect(result.message).toContain("no update operation");
		expect(result.outline).toBeDefined();
	});

	it("verified-edit: a silent kernel no-op (ack ok, index never converges) does not read as ok", () =>
		// Collapse the convergence window: the index never serves the
		// submitted body, so the first retry exhausts the table instantly.
		// The swap rides the primitives' `withVerifyWindow` seam — restore
		// is structural, so no try/finally and no in-place mutation of a
		// production table.
		withVerifyWindow([0], async () => {
			const harness = setup({
				config: {
					blockRows: [{ id: "b-1", content: "stale paragraph" }],
				},
			});
			// HTTP success + a well-formed ack for the target — the exact
			// silent-rollback class the insert paths guard against.
			harness.client.updateBlock = async (p) => {
				harness.calls.push({ method: "updateBlock", args: p });
				return [{ doOperations: [{ id: "b-1" }] }];
			};
			const result = await harness.execute(editBase);
			expect(result.status).toBe("error");
			expect(result.message).toContain("verified-edit failed");
			expect(result.message).toContain("never moved off the pre-write content");
			expect(result.message).toContain("do NOT retry blindly");
			expect(result.outline).toBeDefined();
		}));

	it("verified-edit tolerates the async index: a stale first read retries inside the window", async () => {
		const harness = setup({
			config: { blockRows: [{ id: "b-1", content: "stale paragraph" }] },
		});
		const baseQuery = harness.client.query.bind(harness.client);
		let blockReads = 0;
		harness.client.query = async (stmt: string) => {
			if (stmt.startsWith(BLOCK_IN_DOC_STMT_HEAD)) {
				blockReads += 1;
				const rows = (await baseQuery(stmt)) as {
					id: string;
					content: string;
				}[];
				// Read 1 is the pre-write target read; read 2 the first
				// post-write verification read — the index has not converged
				// yet and still serves the pre-write form; read 3 has it.
				if (blockReads === 2) {
					return [{ ...rows[0]!, content: "stale paragraph" }];
				}
				return rows;
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
		expect(blockReads).toBe(3);
	});

	it("an identical resubmit lands after observed window stillness — the no-op reads as ok", () =>
		// The primitives judge a byte-equal resubmit through the convergence
		// window, never on the ack alone: stored content re-parses on
		// resubmit, so stillness — not the ack — is the no-op signal.
		// Collapsed table via the `withVerifyWindow` seam, same as the
		// silent-no-op case above: the first retry exhausts the window
		// instantly.
		withVerifyWindow([0], async () => {
			const { execute } = setup({
				config: {
					blockRows: [{ id: "b-1", content: "same body" }],
				},
			});
			const result = await execute({ ...editBase, markdown: "same body" });
			expect(result.status).toBe("ok");
		}));

	it("the successful edit baselines its own block from the verdict's carried pair", async () => {
		const harness = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				childrenFor: {
					"d-doc": [walkBlock("b-1", "p", "", "served body")],
				},
			},
		});
		// A prior serve seeds the baseline, so the pre-write fallback (which
		// only fills missing entries) cannot mask the refresh: only the
		// verdict-carried pair can move the hash off the original serve. The
		// tree holds the served form so the precondition matches.
		harness.baselines.remember("b-1", "served body");
		let blockReads = 0;
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (stmt.startsWith(BLOCK_IN_DOC_STMT_HEAD)) {
				blockReads += 1;
				// Read 1 is the pre-write target read; read 2 the post-write
				// verification read, serving a kernel-normalized stored form
				// distinct from the submitted markdown.
				return blockReads === 1
					? baseQuery(stmt)
					: [
							{
								id: "b-1",
								root_id: "d-doc",
								type: "p",
								content: "correctd body",
							},
						];
			}
			if (stmt.startsWith(BLOCK_CONTENTS_STMT_HEAD)) {
				// No baseline-content refresh rides the edit's success path —
				// the landed verdict carries the stored pair it judged. A
				// broad refresh here would launder a concurrent change into
				// the baseline.
				throw new Error("unexpected blocks.content refresh");
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
		// The verdict carried the post-write stored (index) form — a
		// follow-up edit compares against it, not the submitted markdown
		// and not the pre-write serve.
		expect(harness.baselines.servedHash("b-1")).toBe(
			contentHash("correctd body"),
		);
	});
});

// ---------------------------------------------------------------------------
// append — tool-derived nextID anchor + walk-set verification
// ---------------------------------------------------------------------------

const SECTION_DOC = {
	// Heading sections are seeded as the kernel returns them (a heading's
	// getChildBlocks answer is its section: following siblings up to the next
	// heading of same-or-higher level). The walk never recurses into `h` — it
	// reaches these blocks through the `d-doc` loop — so these entries are here
	// to fail the suite if heading recursion is ever reintroduced.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
	h1: [
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
	h2: [walkBlock("p2", "p", "", "body two")],
};

// A same-or-shallower sibling heading after the section: the boundary the
// insert anchors on (deeper headings belong to the section and never do).
const BOUNDED_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
		walkBlock("h1b", "h", "h1", "Next"),
		walkBlock("p3", "p", "", "tail"),
	],
	h1: [
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
	h2: [walkBlock("p2", "p", "", "body two")],
	h1b: [walkBlock("p3", "p", "", "tail")],
};

describe("append", () => {
	const appendParams = (headingId?: string) => ({
		kb: "recipes",
		mode: "append",
		docId: "d-doc",
		...(headingId !== undefined ? { headingId } : {}),
		markdown: "new fact",
	});

	it("anchors nextID at the next same-or-shallower sibling heading; echoes anchor + newBlockId", async () => {
		// The kernel applies the insert at insert time: the minted block
		// appears in the post-write tree only (never in the pre-write walk).
		const { execute, calls, childrenFor } = setup({
			config: {
				childrenFor: BOUNDED_DOC,
				onInsert: () => {
					childrenFor["d-doc"] = [
						...BOUNDED_DOC["d-doc"].slice(0, 4),
						walkBlock("b-new", "p", "", "new fact"),
						...BOUNDED_DOC["d-doc"].slice(4),
					];
				},
			},
		});
		const result = await execute(appendParams("h1"));
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("nextID=h1b (next heading)");
		expect(result.newBlockId).toBe("b-new");
		const insert = calls.find((c) => c.method === "insertBlock");
		const insertArgs =
			insert === undefined ? undefined : (insert.args as { nextID?: string });
		expect(insertArgs?.nextID).toBe("h1b");
	});

	it("placement section-start inserts before the first subsection, after the leading run", async () => {
		// BOUNDED_DOC's h1 section: p1, h2, p2 — section-start lands between
		// p1 and h2, where the default lands before h1b past the whole run.
		const { execute, calls, childrenFor } = setup({
			config: {
				childrenFor: BOUNDED_DOC,
				onInsert: () => {
					childrenFor["d-doc"] = [
						...BOUNDED_DOC["d-doc"].slice(0, 2),
						walkBlock("b-new", "p", "", "new fact"),
						...BOUNDED_DOC["d-doc"].slice(2),
					];
				},
			},
		});
		const result = await execute({
			...appendParams("h1"),
			placement: "section-start",
		});
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		const insert = calls.find((c) => c.method === "insertBlock");
		const insertArgs =
			insert === undefined ? undefined : (insert.args as { nextID?: string });
		expect(insertArgs?.nextID).toBe("h2");
	});

	it("a deeper trailing heading never bounds the section — final-section and omitted headingId both appendBlock on the doc root", async () => {
		const docEnd = setup({
			config: {
				childrenFor: SECTION_DOC,
				onInsert: () => {
					docEnd.childrenFor["d-doc"] = [
						...SECTION_DOC["d-doc"],
						walkBlock("b-new", "p", "", "new fact"),
					];
				},
			},
		});
		const result = await docEnd.execute(appendParams());
		expect(result.anchor).toBe("appendBlock(root) — doc end");
		const docEndInsert = docEnd.calls.find((c) => c.method === "appendBlock");
		expect(docEndInsert?.args).toEqual({ data: "new fact", parentID: "d-doc" });

		const trailing = setup({
			config: {
				childrenFor: SECTION_DOC,
				onInsert: () => {
					trailing.childrenFor["d-doc"] = [
						...SECTION_DOC["d-doc"],
						walkBlock("b-new", "p", "", "new fact"),
					];
				},
			},
		});
		// h2 is the last heading, and a deeper one — it never bounds h1's
		// section, so h1 appends to the doc root too.
		const lastHeading = await trailing.execute(appendParams("h1"));
		expect(lastHeading.anchor).toBe("appendBlock(root) — doc end");
		const trailingInsert = trailing.calls.find(
			(c) => c.method === "appendBlock",
		);
		expect(trailingInsert?.args).toEqual({
			data: "new fact",
			parentID: "d-doc",
		});
	});

	it("a heading inside a tabs container is refused before any kernel write — the kernel takes no write-parent there", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: {
					"d-doc": [walkBlock("tabs1", "tabs", "", "tabs")],
					tabs1: [walkBlock("h1", "h", "h1", "In tabs", "tabs1", "tabs")],
				},
			},
		});
		const result = await execute(appendParams("h1"));
		expect(result.status).toBe("refused");
		expect(result.message).toContain("'tabs' container");
		expect(result.message).toContain("(not targetable)");
		expect(
			calls.filter(
				(c) => c.method === "insertBlock" || c.method === "appendBlock",
			),
		).toHaveLength(0);
	});

	it("a heading inside an unnamed container (a footnote definition) is refused too", () => {
		// No mintable live tree produces a containerless wire type, so this
		// arm rides the fixture walk directly (headingInWalk is the tool-side
		// wording map over the primitives' resolveHeadingTarget).
		const walk = [
			walkBlock("fn1", "", "", "fn"),
			walkBlock("h2", "h", "h2", "In footnote", "fn1", ""),
		];
		const result = headingInWalk(walk, { title: "Doc", rootId: "d-doc" }, "h2");
		expect("message" in result && result.message).toContain(
			"an unnamed container",
		);
	});

	it("walk-set diff: a returned id absent from the post-write tree → error (silent rollback)", async () => {
		const appended = setup({ config: { childrenFor: SECTION_DOC } }); // the tree never changes
		const result = await appended.execute(appendParams());
		expect(result.status).toBe("error");
		expect(result.message).toContain("rolled back silently");
		expect(result.outline).toBeDefined();
	});

	it("a stale anchor's synchronous kernel error surfaces verbatim with the fresh outline and the anchor echo", async () => {
		const failing = setup({
			config: {
				childrenFor: BOUNDED_DOC,
				onInsert: () => {
					throw new SiYuanApiError(500, -1, "block [h1b] not found");
				},
			},
		});
		const result = await failing.execute(appendParams("h1"));
		expect(result.status).toBe("error");
		expect(result.message).toContain("block [h1b] not found");
		expect(result.outline).toBeDefined();
		expect(result.anchor).toBe("nextID=h1b (next heading)");
	});
});

// ---------------------------------------------------------------------------
// replace-section — insert-before-delete, invalidRefs
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
	// Kernel-shaped heading sections (see SECTION_DOC): the delete set must
	// stay the enumerated section, never the heading's answer re-emitted.
	h1: [
		walkBlock("p1", "p", "", "old one"),
		walkBlock("p2", "p", "", "old two"),
	],
	h2: [walkBlock("p3", "p", "", "tail")],
};

const REPLACE_LIST_DOC = {
	// A section containing a container: the members are [p1, l1] (the
	// items are l1's descendants, not members) — the sweep deletes the
	// members only, the kernel cascade removes the descendants with the
	// container, and sweeping them explicitly would error (tree not found)
	// behind a fully-successful replace.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "old one"),
		walkBlock("l1", "l", "", "list"),
		walkBlock("h2", "h", "h1", "Details"),
	],
	l1: [
		walkBlock("i1", "i", "", "item one"),
		walkBlock("i2", "i", "", "item two"),
	],
};

// A heading nested inside a callout: the section is container-bounded —
// the sibling run of h2 inside c1 is [p2] only. l2 (a sibling of the
// CALLOUT, not of h2) and its items sit outside the section and survive.
const REPLACE_NESTED_HEADING_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "Top"),
		walkBlock("c1", "callout", "", "callout"),
		walkBlock("l2", "l", "", "after list"),
		walkBlock("h3", "h", "h1", "Next"),
	],
	c1: [
		walkBlock("h2", "h", "h2", "Nested"),
		walkBlock("p2", "p", "", "callout body"),
	],
	l2: [
		walkBlock("i3", "i", "", "item three"),
		walkBlock("i4", "i", "", "item four"),
	],
};

// The target heading sits inside a list item: its section is the sibling
// run inside the item ([p3]) — i2 is a sibling of the list, never of h2,
// and survives the sweep (a doc-order slice would have swept it).
const REPLACE_ITEM_HEADING_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "Top"),
		walkBlock("l1", "l", "", "outer list"),
		walkBlock("h3", "h", "h1", "Next"),
	],
	l1: [
		walkBlock("i1", "i", "", "item one"),
		walkBlock("i2", "i", "", "item two"),
	],
	i1: [
		walkBlock("h2", "h", "h2", "Deep heading"),
		walkBlock("p3", "p", "", "deep body"),
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
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_DOC,
				// A referring doc survives the replace — pins the orphaned-refs
				// count wording (doc(s), not ref(s): backlinkCheck counts roots).
				refRows: [{ id: "ref-1", root_id: "r1" }],
				hpathRows: [{ hpath: "/lab/notebook" }],
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
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
		// The orphaned-refs wording is agent-visible and pinned here: the
		// count is of distinct referring docs, not refs.
		expect(result.message).toContain("1 doc(s) with orphaned refs");
		expect(result.invalidRefs).toEqual({
			count: 1,
			hpaths: ["/lab/notebook"],
		});
		// Outline freshness: the result outline reflects the post-write
		// tree — the swept blocks are gone from it.
		expect(result.outline).not.toContain("old one");
		expect(result.outline).not.toContain("old two");
	});

	it("a stale anchor's synchronous insert error is not a partial replace: error with the fresh outline, nothing deleted", async () => {
		const failing = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					throw new SiYuanApiError(500, -1, "block [h2] not found");
				},
			},
		});
		const result = await failing.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("block [h2] not found");
		expect(result.outline).toBeDefined();
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		// The insert is the first mutation — no partial state to report.
		expect(result.partialReplace).toBeUndefined();
		expect(
			failing.calls.filter((c) => c.method === "deleteBlock"),
		).toHaveLength(0);
	});

	it("a container-carrying section sweeps only the forest roots — descendants ride the kernel cascade", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_LIST_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_LIST_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_LIST_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		const result = await harness.execute(replaceParams);
		// A descendant sweep would hit the kernel's cascaded-away ids and
		// false-report a partial replace — the ok status IS the pin.
		expect(result.status).toBe("ok");
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p1", "l1"]);
		// The cascade reached the tree: the list and its items are gone, the
		// replacement and the boundary survive.
		expect(
			(harness.childrenFor["d-doc"] ?? []).map((b) => (b as { id: string }).id),
		).toEqual(["h1", "b-new", "h2"]);
	});

	it("a heading nested in a container sweeps its container-local sibling run — blocks after the container survive", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_NESTED_HEADING_DOC,
				onInsert: () => {
					harness.childrenFor["c1"] = [
						...REPLACE_NESTED_HEADING_DOC.c1,
						walkBlock("b-new", "p", "", "rewritten section"),
					];
				},
			},
		});
		const result = await harness.execute({ ...replaceParams, headingId: "h2" });
		// h2's section is container-bounded: the sibling run inside the
		// callout is [p2] — l2 (a sibling of the CALLOUT, after it) and its
		// items are outside the section and survive. The anchor appends to
		// the callout itself, never past it.
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("appendBlock(c1) — end of section");
		const insert = harness.calls.find((c) => c.method === "appendBlock");
		expect(insert?.args).toEqual({
			data: "rewritten section",
			parentID: "c1",
		});
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p2"]);
		expect(
			(harness.childrenFor["d-doc"] ?? []).map((b) => (b as { id: string }).id),
		).toEqual(["h1", "c1", "l2", "h3"]);
		expect(
			((harness.childrenFor["c1"] ?? []) as { id: string }[]).map((b) => b.id),
		).toEqual(["h2", "b-new"]);
	});

	it("a heading inside a list item sweeps only its sibling run — the item's siblings survive", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_ITEM_HEADING_DOC,
				onInsert: () => {
					harness.childrenFor["i1"] = [
						...REPLACE_ITEM_HEADING_DOC.i1,
						walkBlock("b-new", "p", "", "rewritten section"),
					];
				},
			},
		});
		const result = await harness.execute({ ...replaceParams, headingId: "h2" });
		// h2's section inside item i1 is [p3] — i2 is a sibling of i1, never
		// of h2, so it survives (a doc-order slice would have swept it).
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("appendBlock(i1) — end of section");
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p3"]);
		expect(
			(harness.childrenFor["d-doc"] ?? []).map((b) => (b as { id: string }).id),
		).toEqual(["h1", "l1", "h3"]);
		expect(
			((harness.childrenFor["l1"] ?? []) as { id: string }[]).map((b) => b.id),
		).toEqual(["i1", "i2"]);
		expect(
			((harness.childrenFor["i1"] ?? []) as { id: string }[]).map((b) => b.id),
		).toEqual(["h2", "b-new"]);
	});

	it("a deeper heading member at doc level replaces cleanly — the insert lands before the boundary as its sibling", async () => {
		// h_sub (a deeper doc-level heading) is a section member — deeper
		// headings never bound the section — so the sweep deletes it and p1,
		// while the insert lands BEFORE the boundary h2 as a doc-level
		// sibling, never inside a member.
		const harness = setup({
			config: {
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "Top"),
						walkBlock("h_sub", "h", "h2", "Sub"),
						walkBlock("p1", "p", "", "old body"),
						walkBlock("h2", "h", "h1", "Next"),
					],
				},
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						{ id: "h1" },
						walkBlock("b-new", "p", "", "rewritten section"),
						{ id: "h_sub" },
						{ id: "p1" },
						{ id: "h2" },
					];
				},
				onDelete: () => {
					harness.childrenFor["d-doc"] = (
						harness.childrenFor["d-doc"] ?? []
					).filter((b) => !["h_sub", "p1"].includes((b as { id: string }).id));
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("ok");
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["h_sub", "p1"]);
		expect(
			(harness.childrenFor["d-doc"] ?? []).map((b) => (b as { id: string }).id),
		).toEqual(["h1", "b-new", "h2"]);
	});

	it("a boundary heading nested inside a swept container replaces cleanly — the anchor is a sibling, never inside a member", async () => {
		// The old next-heading-at-any-level rule anchored h1's replace on h2
		// (nested inside b2, a swept member): the insert landed inside the
		// doomed container and the cascade consumed the replacement. The
		// section rule anchors on the boundary h1b (a sibling), so the
		// replace sweeps [p1, b2] and h2's container dies with the section.
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "p", "", "old body"),
						walkBlock("b2", "b", "", "quote"),
						walkBlock("h1b", "h", "h1", "B"),
					],
					b2: [
						walkBlock("pA", "p", "", "quoted body"),
						walkBlock("h2", "h", "h2", "Inside quote"),
					],
				},
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						{ id: "h1" },
						{ id: "p1" },
						{ id: "b2" },
						walkBlock("b-new", "p", "", "rewritten section"),
						{ id: "h1b" },
					];
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("nextID=h1b (next heading)");
		const insert = harness.calls.find((c) => c.method === "insertBlock");
		expect(insert?.args).toEqual({
			data: "rewritten section",
			nextID: "h1b",
		});
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p1", "b2"]);
		expect(
			(harness.childrenFor["d-doc"] ?? []).map((b) => (b as { id: string }).id),
		).toEqual(["h1", "b-new", "h1b"]);
	});

	it("the post-sweep walk must still hold the replacement — a cascade-consumed replacement fails loud, never ok", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				// Simulate kernel misbehavior: the delete's cascade consumed
				// the replacement the insert just landed.
				onDelete: () => {
					harness.childrenFor["d-doc"] = (
						harness.childrenFor["d-doc"] ?? []
					).filter((b) => (b as { id: string }).id !== "b-new");
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("cascade consumed the replacement");
		expect(result.message).toContain("do not retry");
		// The certified post-sweep walk rides the refusal as the inline
		// outline — recovery evidence without a re-fetch round trip.
		expect(result.outline).toBeDefined();
	});

	it("a success-reported delete that left the block in the tree fails loud (members-survived), never ok", async () => {
		// The default stub's deleteBlock resolves without touching the live
		// tree — the 3.8.3 success-no-op generation. The judgment reads the
		// post-sweep walk, so the lying ok receipt the old flow would have
		// rendered is now the members-survived refusal with the survivors
		// itemized.
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"reported success but the block(s) are still present",
		);
		expect(result.message).toContain("do not retry blindly");
		// The verdict's postWalk is served inline, not pointed at kb_read.
		expect(result.message).not.toContain("re-fetch the outline");
		expect(result.outline).toBeDefined();
		expect(result.partialReplace).toBe(true);
		expect(result.deletedBlockIds).toEqual([]);
		expect(result.remainingBlockIds).toEqual(["p1", "p2"]);
	});

	it("a mid-sweep failure's remaining list is an antichain — any delete order finishes the job", async () => {
		let deletes = 0;
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_LIST_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_LIST_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_LIST_DOC["d-doc"].slice(3),
					];
				},
				onDelete: () => {
					deletes += 1;
					if (deletes === 2) {
						throw new SiYuanApiError(500, -1, "kernel gone mid-sweep");
					}
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.partialReplace).toBe(true);
		expect(result.deletedBlockIds).toEqual(["p1"]);
		// The sweep stopped before its verification walk, so no certified
		// snapshot exists to serve — the partial arm carries no outline.
		expect(result.outline).toBeUndefined();
		// Roots only: no container paired with its descendants, so the
		// recovery deletes can run in any order without cascading errors.
		expect(result.remainingBlockIds).toEqual(["l1"]);
	});

	it("a failed delete after a successful insert leaves duplication, never loss", async () => {
		let deletes = 0;
		const harness = setup({
			config: {
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

	it("mid-sweep drop after landed deletes → verificationFailed carrying the partial state", async () => {
		let arm: ((err: Error) => void) | undefined;
		let deletes = 0;
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				armDeleteError: (set) => {
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
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		// The sweep failure is a mid-write step, not a verification read — the
		// envelope must carry the partial-apply state, or a re-run duplicates
		// the replacement.
		expect(result.partialReplace).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.deletedBlockIds).toEqual(["p1"]);
		expect(result.remainingBlockIds).toEqual(["p2"]);
		expect(result.message).toContain("partially applied");
		expect(result.message).toContain("do NOT re-run");
		expect(result.message).not.toContain("SiYuan unreachable");
	});

	it("post-sweep walk drop after landed deletes → verificationFailed carrying the fully-swept set", async () => {
		let arm: ((err: Error) => void) | undefined;
		let deletes = 0;
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				armWalkError: (set) => {
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
					// Both deletes acked — the next walk is the sweep's own
					// verification read, after the sweep is complete.
					if (deletes === 2) arm?.(new SiYuanNetworkError());
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		// A fully-applied write must never read as "unreachable" — the
		// receipt rides the envelope, and nothing remains pending.
		expect(result.partialReplace).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.deletedBlockIds).toEqual(["p1", "p2"]);
		expect(result.remainingBlockIds).toEqual([]);
		expect(result.message).toContain("partially applied");
		expect(result.message).not.toContain("SiYuan unreachable");
	});

	it("429 mid-sweep → cooldown refusal carrying the partial state", async () => {
		let deletes = 0;
		const harness = setup({
			config: {
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
					if (deletes === 2) throw new SiYuanRateLimitError(429, 30);
				},
			},
		});
		const result = await harness.execute(replaceParams);
		// The 429 still classifies (cooldown refusal — the lock is armed), but
		// the partial-apply state rides the envelope so the post-lock recovery
		// knows the sweep is half-done.
		expect(result.status).toBe("refused");
		expect(result.message).toContain("rate-limit lockout");
		expect(result.message).toContain("partially applied");
		expect(result.partialReplace).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.deletedBlockIds).toEqual(["p1"]);
		expect(result.remainingBlockIds).toEqual(["p2"]);
	});

	it("delete-bearing results carry invalidRefs", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
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
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.invalidRefs).toEqual({ count: 1, hpaths: ["/Other doc"] });
		// The receipt: the section's closure (members + descendants, the
		// heading survives) with the walk content verbatim.
		expect(result.deletedBlocks).toEqual([
			{ id: "p1", content: "old one" },
			{ id: "p2", content: "old two" },
		]);
	});

	it("final section: the sweep runs to end of doc (trailing content deleted), anchor is appendBlock(root)", async () => {
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 4),
						walkBlock("b-new", "p", "", "rewritten section"),
					];
				},
			},
		});
		const result = await harness.execute({ ...replaceParams, headingId: "h2" });
		expect(result.anchor).toBe("appendBlock(root) — doc end");
		expect(
			harness.calls
				.filter((c) => c.method === "deleteBlock")
				.map((c) => c.args),
		).toEqual(["p3"]);
		expect(harness.calls.find((c) => c.method === "appendBlock")).toBeDefined();
	});

	it("an unresolvable insert (silent rollback) refuses the deletes — the old section is untouched", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: REPLACE_DOC,
			},
		}); // the tree never shows the minted block
		const result = await execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("the old section is untouched");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("stale delete-set content → stale_content refusal before any kernel write", async () => {
		// The dialog served an older p1 (baseline seeded from it); the live
		// tree holds the concurrently rewritten form — the precondition reads
		// the tree, so the kernel-side change lands even inside the index's
		// convergence window.
		const harness = setup({ config: { childrenFor: REPLACE_DOC } });
		harness.baselines.remember("p1", "an even older one");
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("old one");
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

	it("multi-stale delete set → one refusal naming every stale member, each re-baselined from its named content", async () => {
		// Two concurrently-rewritten members: the wrapper judges every target
		// (no early stop), so one refusal carries both — each extra round-
		// trip today's stop-at-first bought nothing the all-arms shape
		// doesn't give in one turn. The re-baselined hash of each named
		// member equals contentHash(its named currentContent) — the tool-side
		// half of the anti-laundering invariant.
		const harness = setup({ config: { childrenFor: REPLACE_DOC } });
		harness.baselines.remember("p1", "an even older one");
		harness.baselines.remember("p2", "an even older two");
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.staleTargets).toEqual([
			{ blockId: "p1", currentContent: "old one" },
			{ blockId: "p2", currentContent: "old two" },
		]);
		expect(harness.baselines.servedHash("p1")).toBe(contentHash("old one"));
		expect(harness.baselines.servedHash("p2")).toBe(contentHash("old two"));
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock",
			),
		).toHaveLength(0);
	});

	it("walk/blocks representation drift fails closed — the refusal re-baselines from the tree and the retry proceeds", async () => {
		// The precondition's NOW rides the live tree; a baseline seeded from
		// a divergently-rendered blocks.content form must refuse (fail
		// closed), never launder the mismatch. The refusal re-baselines the
		// target from the tree, so the retried write compares like-for-like
		// and applies.
		const harness = setup({
			config: {
				cascadeDelete: true,
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		harness.baselines.remember("p1", "old **one**");
		const refused = await harness.execute(replaceParams);
		expect(refused.status).toBe("refused");
		expect(refused.reason).toBe("stale_content");
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "updateBlock" ||
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock",
			),
		).toHaveLength(0);
		const retry = await harness.execute(replaceParams);
		expect(retry.status).toBe("ok");
		expect(retry.reason).toBeUndefined();
	});

	it("write results re-seed outline baselines from blocks.content — follow-up writes compare like-for-like", async () => {
		// The blocks index and the walk serve the same representation on the
		// pinned kernel, so a baseline seeded from either source compares
		// clean against the tree-riding re-check — the replace applies, and
		// the result-carried outline re-baselines the follow-up edit against
		// the refreshed form instead of the pre-write serve.
		const harness = setup({
			config: {
				cascadeDelete: true,
				blockRows: [{ id: "p2", content: "old two" }],
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		harness.baselines.remember("p2", "old two");
		const first = await harness.execute(replaceParams);
		expect(first.status).toBe("ok");
		const second = await harness.execute({
			kb: "recipes",
			mode: "edit",
			docId: "d-doc",
			blockId: "p2",
			markdown: "old two, corrected",
		});
		expect(second.status).toBe("ok");
	});

	it("an intervening write refreshes only blocks its result carried — a concurrently-changed unserved block still refuses", async () => {
		// p1 was served earlier this session (baseline = "served body"); the
		// kernel's stored copy has since been changed concurrently. The
		// intervening append's tail refreshes only the blocks its result
		// carried (the outline headings + the new block) — a whole-doc
		// refresh would launder the concurrent change into p1's baseline and
		// the follow-up edit would hash-match the laundered content and
		// apply. The stub answers the baseline read with rows for exactly
		// the requested IDs, so the assertion fails on any request that
		// reaches for p1.
		const stored: Record<string, string> = {
			h1: "Goals",
			p1: "changed body",
			h2: "Details",
			p2: "body two",
			"b-new": "new fact",
		};
		const harness = setup({
			config: {
				blockRows: [{ id: "p1", content: "changed body" }],
				childrenFor: SECTION_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...SECTION_DOC["d-doc"],
						walkBlock("b-new", "p", "", stored["b-new"] as string),
					];
				},
			},
		});
		storedContentStub(harness, stored);
		harness.baselines.remember("p1", "served body");
		const intervention = await harness.execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new fact",
		});
		expect(intervention.status).toBe("ok");
		// p1 was not in the append's result — its served baseline survives.
		expect(harness.baselines.servedHash("p1")).toBe(contentHash("served body"));
		const edit = await harness.execute({
			kb: "recipes",
			mode: "edit",
			docId: "d-doc",
			blockId: "p1",
			markdown: "overwrite",
		});
		expect(edit.status).toBe("refused");
		expect(edit.reason).toBe("stale_content");
	});
});

// ---------------------------------------------------------------------------
// delete — walk-set evidence + the doc-level pinned shape
// ---------------------------------------------------------------------------

describe("delete", () => {
	it("block-level: targetGone from the post-write walk set, invalidRefs echo", async () => {
		const { execute, calls, childrenFor } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				// The kernel applies the delete: p1 vanishes from the tree.
				onDelete: () => {
					childrenFor["d-doc"] = [];
				},
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
		// Wording pin: the orphaned-refs count is agent-visible (0 here —
		// no refRows configured).
		expect(result.message).toContain("0 doc(s) with orphaned refs");
		expect(result.invalidRefs).toEqual({ count: 0, hpaths: [] });
		// The receipt rides the judged arm's content (the primitive's
		// membership read): id + content verbatim.
		expect(result.deletedBlocks).toEqual([{ id: "p1", content: "doomed" }]);
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1"]);
	});

	it("a kernel success no-op still reports ok — with the walk-set evidence naming it (3.8.3 kernel)", async () => {
		// childrenFor keeps the block post-delete: the kernel "deleted"
		// nothing (ErrBlockNotFound → nil, a success no-op). 3.8.4
		// instead answers a synchronous error — the pin below.
		const { execute } = setup({
			config: {
				blockRows: [{ id: "p1", content: "survivor" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "survivor")] },
			},
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
		// A no-op deleted nothing — no receipt next to a STILL PRESENT verdict.
		expect(result.deletedBlocks).toBeUndefined();
	});

	it("3.8.4 delete of a missing block: synchronous error surfaced verbatim with the fresh outline", async () => {
		// 3.8.4's PerformBlockOperation requires an existing node — the same
		// synchronous not-found treatment as edit/move, one error class over.
		const { execute, calls } = setup({
			config: {
				onDelete: () => {
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.outline).toBeDefined(); // fresh evidence rides the error
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1"]);
	});

	it("3.8.4 delete with a simultaneous echo failure: the kernel's error still surfaces verbatim, not 'unreachable'", async () => {
		// The outline re-read rides the walk route; arm it to drop at the same
		// moment the kernel answers the delete with a synchronous error. The
		// verdict is the kernel's error — the echo is garnish — and an
		// unwrapped echo throw would make runKbCall reclassify this call as
		// "SiYuan unreachable" even though the kernel answered.
		let arm: ((err: Error) => void) | undefined;
		const { execute } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => {
					arm?.(new SiYuanNetworkError());
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.message).not.toContain("unreachable");
	});

	it("a foreign blockId (another doc's block) is refused before any kernel delete", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [
					{ id: "p-other", content: "other doc", root_id: "d-other" },
				],
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p-other",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("belongs to another doc");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("a pre-deleted target: kernel no-op → ok with the absent-target evidence", async () => {
		// blockRows [] — the target vanished before the call; nothing to
		// protect, the kernel no-op still reports ok.
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [] },
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
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a kernel rejection mid-verification (SiYuanApiError) → verificationFailed, never a false ok", async () => {
		// The client throws SiYuanApiError for unknown/locked ids on
		// getChildBlocks; a strict walk must not let that read as "target
		// gone" behind a successful HTTP delete.
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => arm?.(new SiYuanApiError(500, -1, "block locked")),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("post-write verification reads failed");
		expect(result.targetGone).toBeUndefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a verification-phase 429 keeps the may-already-be-applied fact the rethrow erased", async () => {
		// The mutation acked, the post-delete walk hit the per-IP lock: the
		// verdict must word the lock (every authed call re-arms it), keep the
		// applied fact, and carry the authEvent marker runKbCall's breaker
		// accounting consumes.
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => arm?.(new SiYuanRateLimitError(429, 90)),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("may already be applied");
		expect(result.message).toContain("re-arms the");
		expect(result.authEvent).toEqual({
			kind: "rate-limit",
			retryAfterSeconds: 90,
		});
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a transport drop mid-delete reads as outcome-unverified with the outline attached, never a blind-retry invitation", async () => {
		// The delete may already be applied when the transport fails — the
		// primitive's transport-unverified arm, not runKbCall's retry
		// invitation. The error-path echo reads run best-effort.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armDeleteError: (arm) => arm(new SiYuanNetworkError()),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("transport layer");
		// The verdict is the transport-unverified envelope, not runKbCall's
		// "SiYuan unreachable" shape (the stub's own network-error text
		// legitimately rides the detail interpolation).
		expect(result.blockId).toBe("p1");
		expect(result.targetGone).toBeUndefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("doc-level: a synchronous kernel rejection surfaces verbatim with the fresh outline", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [walkBlock("h1", "h", "h1", "Heading")] },
				onRemoveDoc: () => {
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.outline).toContain("Heading");
		expect(
			calls.filter((c) => c.method === "removeDocByID").map((c) => c.args),
		).toEqual(["d-doc"]);
	});

	it("doc-level: removeDocByID fires and the result carries invalidRefs plus the delete receipt (pinned shape)", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "body")] },
				refRows: [{ root_id: "d-other" }],
				hpathRows: [{ hpath: "/Other doc" }],
			},
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
			"deletedBlocks",
			"invalidRefs",
			"kb",
			"message",
			"status",
		]);
		expect(result.invalidRefs).toEqual({ count: 1, hpaths: ["/Other doc"] });
		// The receipt rides the pre-delete walk set — the doc is gone.
		expect(result.deletedBlocks).toEqual([{ id: "p1", content: "body" }]);
	});

	it("a delete receipt over the preview budget spills: the pointer rides, the inline field goes", async () => {
		const { execute } = setup({
			config: {
				childrenFor: {
					"d-doc": [walkBlock("p1", "p", "", "x".repeat(9000))],
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		expect(result.deletedBlocks).toBeUndefined();
		expect(result.deletedBlocksPreview).toContain('"id":"p1"');
		expect(result.deletedBlocksPath).toMatch(
			/kb_write-deleted-blocks-[0-9a-f]{16}\.jsonl$/,
		);
	});
});

// ---------------------------------------------------------------------------
// move — verification + doc-level record
// ---------------------------------------------------------------------------

describe("block-level move", () => {
	const MOVE_DOC = {
		"d-doc": [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "l", "u", "mover"),
			walkBlock("p2", "p", "", "stay"),
		],
		// Kernel-shaped heading section (see SECTION_DOC).
		h1: [walkBlock("p1", "l", "u", "mover"), walkBlock("p2", "p", "", "stay")],
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
		return setup({
			config: {
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
			},
		});
	}

	it("a foreign blockId (a block of another doc) is refused via the verified move's not-in-source arm", async () => {
		// The scoping judgment rides moveBlockVerified (the same raw-id fact
		// blockInDoc refuses edit/delete targets on); cross-doc the primitive
		// fetches the source walk itself. This path pins only the wording.
		const harness = moveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "b-foreign",
			toDocId: "d-other",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is not a block of source doc");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("a pre-deleted source block: moveBlock's synchronous not-found error surfaces verbatim", async () => {
		const { execute, calls } = moveHarness(() => {
			throw new SiYuanApiError(-1, -1, "block not found");
		});
		const result = await execute(moveParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("block not found");
		expect(result.kb).toBe("recipes");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "moveBlock")).toHaveLength(1);
	});

	it("a toHeadingId absent from the destination walk is refused via the shared headingInWalk pin, before any kernel move", async () => {
		const harness = moveHarness();
		const result = await harness.execute({
			...moveParams,
			toHeadingId: "oh-gone",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"headingId 'oh-gone' is not a heading of doc 'Other doc' (d-other) — stale or foreign target",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

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
		// Doc end with a populated destination: previousID = the last
		// root-level block (parentID would prepend — the defect).
		expect(result.anchor).toBe("previousID=p2 (doc end)");
		const move = harness.calls.find((c) => c.method === "moveBlock");
		expect(move?.args).toEqual({ id: "p1", previousID: "p2" });
		// Same-doc: the in-hand source walk serves as the destination —
		// exactly one pre-write and one post-write source walk.
		const walks = harness.calls.filter(
			(c) => c.method === "getChildBlocks" && c.args === "d-doc",
		);
		expect(walks).toHaveLength(2);
	});

	it("cross-doc doc-end move into an EMPTY destination: moveBlock rides parentID (the prepend IS the end)", async () => {
		// The only reach of the `append` anchor kind: an empty destination has
		// no block to anchor after. The live kernel never leaves a doc
		// childless, so this leg is unit-only by construction.
		const harness = moveHarness(
			() => {
				harness.childrenFor["d-doc"] = MOVE_DOC["d-doc"].filter(
					(b) => b.id !== "p1",
				);
				harness.childrenFor["d-other"] = [walkBlock("p1", "p", "", "mover")];
			},
			{
				childrenFor: JSON.parse(JSON.stringify({ ...MOVE_DOC, "d-other": [] })),
			},
		);
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-other",
		});
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.anchor).toBe("appendBlock(root) — doc end");
		const move = harness.calls.find((c) => c.method === "moveBlock");
		expect(move?.args).toEqual({ id: "p1", parentID: "d-other" });
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

	it("section ending in a list container: the move lands after the container's subtree and verifies", async () => {
		// The kernel places previousID=list's next SIBLING, but the flattened
		// walk interleaves the list's items between the container and that
		// sibling — next-entry verification read the first item and reported
		// a silent rollback for a move that landed. landingId (subtree end)
		// is the placement model both checks share.
		const harness = moveHarness(
			() => {
				// The kernel applies: p1 lands as the list's next sibling — the
				// items stay inside the container (childrenFor["list"]).
				harness.childrenFor["d-doc"] = [
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("list", "l", "", "list"),
					walkBlock("p1", "p", "", "mover"),
					walkBlock("h2", "h", "h1", "B"),
				];
			},
			{
				blockRows: [{ id: "p1", content: "mover" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "p", "", "mover"),
						walkBlock("list", "l", "", "list"),
						walkBlock("h2", "h", "h1", "B"),
						walkBlock("p9", "p", "", "tail"),
					],
					list: [
						walkBlock("i1", "i", "", "one"),
						walkBlock("i2", "i", "", "two"),
					],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
			},
		);
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		const move = harness.calls.find((c) => c.method === "moveBlock");
		// The section's last top-level member is the container itself.
		expect(move?.args).toEqual({ id: "p1", previousID: "list" });
	});

	// The "already there" refusal class: the destination already contains
	// the block at the position the anchor would produce, so the kernel
	// would no-op behind HTTP success and the walk-set check would misreport
	// the move as landed — the pre-check refuses before any moveBlock.
	type MoveRefusalCase = {
		name: string;
		stub: Partial<StubConfig>;
		params: Record<string, unknown>;
	};
	const alreadyThereCases: MoveRefusalCase[] = [
		// MOVE_DOC's h1 section is [p1, p2] — moving p2 to its end would
		// issue moveBlock({previousID: p2}).
		{
			name: "same-doc self-anchor: the block already ends the destination section",
			stub: { blockRows: [{ id: "p2", content: "stay" }] },
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "p2",
				toDocId: "d-doc",
				toHeadingId: "h1",
			},
		},
		// p2 is MOVE_DOC's last block; a move to doc end (toHeadingId
		// omitted → appendBlock-on-root anchor) would no-op on the kernel
		// and pass the walk-set checks as a successful move.
		{
			name: "same-doc doc-end self-anchor: block already last top-level of its own doc",
			stub: { blockRows: [{ id: "p2", content: "stay" }] },
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "p2",
				toDocId: "d-doc",
			},
		},
		// p2's child c1 is the walk's literal last element; the doc-end
		// shape is "last top-level block", not "last element". Nested depth
		// comes from the walk's recursion (childrenFor[p2]; a container).
		{
			name: "doc-end pre-check survives trailing children: block with a child already at doc end",
			stub: {
				blockRows: [{ id: "p2", content: "stay" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "p", "", "first"),
						walkBlock("p2", "l", "u", "stay"),
					],
					p2: [walkBlock("c1", "i", "u", "kid")],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "p2",
				toDocId: "d-doc",
			},
		},
		// c1 already follows p1, h1's section anchor. The kernel
		// moveBlock({id: c1, previousID: p1}) would no-op while the walk-set
		// check ("c1 present") reports a successful move — the generalized
		// pre-check refuses instead.
		{
			name: "same-doc no-op target: block already immediately after the anchor",
			stub: {
				blockRows: [{ id: "c1", content: "nested" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "p", "", "first"),
						walkBlock("c1", "p", "", "nested", "p1", "p"),
					],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "c1",
				toDocId: "d-doc",
				toHeadingId: "h1",
			},
		},
	];
	it.each(alreadyThereCases)(
		"$name → refusal, zero kernel moves",
		async ({ stub, params }) => {
			const harness = moveHarness(undefined, stub);
			const result = await harness.execute(params);
			expect(result.status).toBe("refused");
			expect(result.message).toContain(
				"already sits at the destination position",
			);
			expect(
				harness.calls.filter((c) => c.method === "moveBlock"),
			).toHaveLength(0);
		},
	);

	it("same-doc doc-end move: a silent kernel no-op is caught by the position check", async () => {
		// p1 is mid-doc; the kernel no-ops behind HTTP success — same-doc
		// walk presence can't distinguish, only the doc-end position can.
		const { execute, calls } = moveHarness(); // the tree never changes
		const result = await execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"present but not at its landing position after the anchor",
		);
		expect(calls.filter((c) => c.method === "moveBlock")).toHaveLength(1);
	});

	// The own-subtree guard keys on the anchor the kernel receives: c1's
	// child section anchors after p-kid (re-parenting the container into
	// itself), and the empty-section arm anchors on the heading itself —
	// which still sits inside c1. headingInWalk accepts h2 (it IS a heading
	// of the doc); the guard fires on the anchor shape.
	it.each([
		{
			name: "same-doc move into the block's own subtree",
			stub: {
				blockRows: [{ id: "c1", content: "container" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("c1", "callout", "", "container"),
					],
					c1: [
						walkBlock("h2", "h", "h2", "Nested", "c1", "callout"),
						walkBlock("p-kid", "p", "", "kid", "c1", "callout"),
					],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "c1",
				toDocId: "d-doc",
				toHeadingId: "h2",
			},
		},
		{
			name: "same-doc move to an empty-section heading inside the block",
			stub: {
				blockRows: [{ id: "c1", content: "container" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("c1", "callout", "", "container"),
					],
					c1: [walkBlock("h2", "h", "h2", "Nested", "c1", "callout")],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "c1",
				toDocId: "d-doc",
				toHeadingId: "h2",
			},
		},
	])("$name is refused with zero kernel moves", async ({ stub, params }) => {
		const harness = moveHarness(undefined, stub);
		const result = await harness.execute(params);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("inside the block's own subtree");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("the own-subtree guard is directional: deep destinations outside the moved block proceed", async () => {
		// h2 lives inside container c1; moving root-level h1 there is a
		// legal deep move — the guard must not fire. The stub applies
		// nothing, so the flow's position check reports the miss: proof the
		// move reached the kernel instead of a false-positive refusal.
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "h1", content: "A" }],
			childrenFor: {
				"d-doc": [
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("c1", "callout", "", "container"),
				],
				c1: [
					walkBlock("h2", "h", "h2", "Nested", "c1", "callout"),
					walkBlock("p1", "p", "", "kid", "c1", "callout"),
				],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "h1",
			toDocId: "d-doc",
			toHeadingId: "h2",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("landing position");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			1,
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
		// The doc-level echo's hpath rides the verdict's own evidence — the
		// live-tree read the landed judgment ran on (the kernel rebuilds the
		// blocks.hpath column asynchronously after moveDocsByID, so the SQL
		// column is never the source). The stub routes exportMarkdown through
		// the docRoots table.
		expect(result.hpath).toBe("/Docker Networking");
		expect(result.anchor).toBeUndefined();
		expect(result.newBlockId).toBeUndefined();
		expect(result.movedBlockId).toBeUndefined();
		expect(result.destOutline).toBeUndefined();
	});

	it("doc-level: the kernel rejects an identity move synchronously — surfaces verbatim", async () => {
		// No pre-mutation self-check in the flow: the kernel owns the whole
		// synchronous-rejection class (the identity member included, live-pinned
		// primitives-side, move.live), and the kernel-refused arm surfaces it
		// verbatim — the same shape as the ancestor and depth-cap rejections.
		const harness = moveHarness(() => {
			throw new SiYuanApiError(200, -1, "Cannot move to this location");
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-doc",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("Cannot move to this location");
		expect(result.verificationFailed).toBeUndefined();
		// Bare doc-level record on the kernel-refused arm: no echo tail.
		expect(result.outline).toBeUndefined();
		expect(result.hpath).toBeUndefined();
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(1);
	});

	it("doc-level: silent rollback behind HTTP success → verified-move failed, never ok", async () => {
		// moveDocsByID applies nothing in the stub — the tree still reports
		// the pre-move hpath, which is exactly the silent-rollback shape the
		// primitive's hpath judgment exists to catch.
		const harness = moveHarness();
		const r = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-other",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBeUndefined();
		// Bare doc-level record: no echo tail — a garnish read here could
		// mask the verdict (the errorTail rule; siblings carry no tail).
		expect(r.outline).toBeUndefined();
		expect(r.hpath).toBeUndefined();
		expect(r.message).toContain("verified-move failed");
		expect(r.message).toContain("did not land at the destination");
		expect(r.message).toContain("/Docker Networking");
	});

	it("doc-level: evidence-read drop (exportMarkdown) after moveDocsByID → verificationFailed, not a false ok", async () => {
		let arm: ((err: Error) => void) | undefined;
		const harness = moveHarness(undefined, {
			armExportError: (set) => {
				arm = set;
			},
			onMove: () => arm?.(new SiYuanNetworkError()),
		});
		const r = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		// The mutation's transport succeeded — the move may already be
		// applied. Never the retry invitation, never "unreachable".
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(r.message).toContain("post-write verification reads failed");
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(1);
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
		} as never);
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
	// Both transport classes: a timeout is a response that never arrived,
	// a fetch reject can fire after the request was sent. Neither answers
	// the edit, so the verdict is the same verificationFailed envelope.
	it.each([
		["network drop", () => new SiYuanNetworkError()],
		["read timeout", () => new SiYuanTimeoutError(30_000)],
	])(
		"edit: post-write echo-read %s → verificationFailed, not 'unreachable'",
		async (_label, make) => {
			let arm: ((err: Error) => void) | undefined;
			const { execute, calls } = setup({
				config: {
					blockRows: [{ id: "b-1", content: "stale paragraph" }],
					armQueryError: (set) => {
						arm = set;
					},
					onUpdate: () => arm?.(make()),
				},
			});
			const r = await execute(editBase);
			expect(r.status).toBe("error");
			expect(r.verificationFailed).toBe(true);
			expect(r.message).toContain("post-write verification reads failed");
			expect(r.message).toContain("do NOT retry blindly");
			expect(r.message).not.toContain("SiYuan unreachable");
			// The mutation itself landed — the failure is in the reads.
			expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
		},
	);

	it("append: post-write verification drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				armQueryError: (set) => {
					arm = set;
				},
				onInsert: () => arm?.(new SiYuanNetworkError()),
			},
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

	it("append: post-write WALK drop (getChildBlocks) → verificationFailed, not the 'rolled back silently' retry invitation", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				armWalkError: (set) => {
					arm = set;
				},
				onInsert: () => arm?.(new SiYuanNetworkError()),
			},
		});
		const r = await execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new section",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		// The dangerous message: the write LANDED — a silent-rollback reading
		// invites the blind retry that duplicates it.
		expect(r.message).not.toContain("rolled back silently");
		expect(r.message).toContain("post-write verification reads failed");
		expect(
			calls.filter(
				(c) => c.method === "insertBlock" || c.method === "appendBlock",
			),
		).toHaveLength(1);
	});
});

// Transport-class failure ON the mutation call itself — the kernel's
// response never arrived, so the write may or may not have landed. The
// result must carry the outcome-unverified contract (never runKbCall's
// "SiYuan unreachable", whose retry invitation would duplicate an applied
// write), and auth-class failures must still propagate for the breaker.
describe("transport failure on the mutation call itself", () => {
	/** Shared assertions: unverified-outcome envelope, no unreachable text. */
	function expectUnverified(r: Record<string, unknown>): void {
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("outcome is unverified");
		expect(r.message).toContain("do NOT retry blindly");
		expect(r.message).not.toContain("SiYuan unreachable");
	}

	// Timeout vs fetch reject — same unverified contract either way: a
	// timeout means the response never arrived, and a network drop can
	// reject after the request was sent.
	it.each([
		["timeout", () => new SiYuanTimeoutError(30_000)],
		["network drop", () => new SiYuanNetworkError()],
	])(
		"edit: %s on updateBlock → outcome unverified, never 'unreachable'",
		async (_label, make) => {
			const { execute, calls } = setup({
				config: {
					blockRows: [{ id: "b-1", content: "stale paragraph" }],
					onUpdate: () => {
						throw make();
					},
				},
			});
			const r = await execute(editBase);
			expectUnverified(r);
			expect(r.message).toContain("may already be applied");
			expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
		},
	);

	// One unverified contract per mutation method: the kernel's response
	// never arrived, so the write may or may not have landed. replace-
	// section's timeout fires on the insert, before the sweep, so no
	// partial-replace payload may exist and no delete ran.
	type TimeoutCase = {
		name: string;
		config: StubConfig;
		params: Record<string, unknown>;
		methods: string[];
		noSweep?: boolean;
	};
	const timeoutCases: TimeoutCase[] = [
		{
			name: "append: timeout on insertBlock",
			config: {
				onInsert: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: {
				kb: "recipes",
				mode: "append",
				docId: "d-doc",
				markdown: "new section",
			},
			methods: ["insertBlock", "appendBlock"],
		},
		{
			name: "replace-section: timeout on the insert — the sweep never ran",
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: replaceParams,
			methods: ["insertBlock", "appendBlock"],
			noSweep: true,
		},
		{
			name: "delete: timeout on deleteBlock",
			config: {
				blockRows: [{ id: "b-1", content: "soon gone" }],
				onDelete: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: {
				kb: "recipes",
				mode: "delete",
				docId: "d-doc",
				blockId: "b-1",
			},
			methods: ["deleteBlock"],
		},
		{
			name: "doc delete: timeout on removeDocByID",
			config: {
				onRemoveDoc: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: { kb: "recipes", mode: "delete", docId: "d-doc", doc: true },
			methods: ["removeDocByID"],
		},
		{
			name: "move: timeout on moveBlock",
			config: {
				blockRows: [{ id: "p1", content: "mover" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "l", "u", "mover"),
						walkBlock("p2", "p", "", "stay"),
					],
					h1: [walkBlock("p1", "l", "u", "mover")],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
				docRoots: {
					"d-doc": {
						content: "Docker Networking",
						hpath: "/Docker Networking",
					},
					"d-other": { content: "Other doc", hpath: "/Other doc" },
				},
				onMove: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "p1",
				toDocId: "d-other",
			},
			methods: ["moveBlock"],
		},
		{
			name: "doc move: timeout on moveDocsByID",
			config: {
				childrenFor: { "d-doc": [walkBlock("h1", "h", "h1", "A")] },
				docRoots: {
					"d-doc": {
						content: "Docker Networking",
						hpath: "/Docker Networking",
					},
				},
				onMove: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: { kb: "recipes", mode: "move", docId: "d-doc", doc: true },
			methods: ["moveDocsByID"],
		},
	];
	it.each(timeoutCases)(
		"$name → outcome unverified, never 'unreachable'",
		async ({ config, params, methods, noSweep }) => {
			const { execute, calls } = setup({ config });
			const r = await execute(params);
			expectUnverified(r);
			expect(calls.filter((c) => methods.includes(c.method))).toHaveLength(1);
			if (noSweep) {
				expect(r.partialReplace).toBeUndefined();
				expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
			}
		},
	);

	it("auth failures on a mutation still propagate for breaker counting", async () => {
		const { execute } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				onUpdate: () => {
					throw new SiYuanAuthError(401);
				},
			},
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBeUndefined();
		expect(r.message).toContain("auth rejected");
		expect(r.message).not.toContain("outcome is unverified");
	});
});
