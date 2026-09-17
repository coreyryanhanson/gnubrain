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
import { modeShapeProblem, type WriteParams } from "../../writeSchema.js";
import {
	base,
	registerKbWrite,
	setup,
	walkBlock,
	type StubConfig,
	type WriteExec,
} from "./writeHarness.js";
import { BASELINE_CONTENTS_STMT_HEAD } from "../../writeResult.js";
import { contentHash } from "../../baselines.js";

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
// edit — fresh-content precondition (decision record)
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

	it("no-baseline fallback: the dialog displays the block's current content; approval establishes the baseline", async () => {
		const { execute, confirmCalls, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("ok");
		expect(confirmCalls[0]?.message).toContain("current content");
		expect(confirmCalls[0]?.message).toContain("stale paragraph");
		// The re-check ran and matched — the write fired exactly once.
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	it("post-approval change → stale_content refusal with current content + fresh outline, zero kernel write calls", async () => {
		const harness = await setupWithEditMutation();
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

	it("a missing blockId reaches the kernel — its synchronous not-found error surfaces verbatim (stale-target record)", async () => {
		const { execute, calls, confirmCalls } = setup({
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
		// No confirmation: nothing exists to show or protect.
		expect(confirmCalls).toHaveLength(0);
	});

	it("a foreign blockId (another doc's block) is refused before any dialog or kernel write", async () => {
		const { execute, calls, confirmCalls } = setup({
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
		expect(confirmCalls).toHaveLength(0);
	});

	it("the successful write result refreshes the served-content baseline", async () => {
		const { execute, baselines } = setup({
			config: { blockRows: [{ id: "b-1", content: "stale paragraph" }] },
		});
		await execute(editBase);
		// The post-write walk's content became the baseline — a follow-up
		// edit on the same block rides it instead of the fallback.
		expect(baselines.servedHash("b-1")).toBeDefined();
	});
});

/** edit harness whose kernel-side content flips between the baseline read
 * and the post-approval re-check (the race the precondition exists for). */
async function setupWithEditMutation(): Promise<{
	execute: WriteExec;
	calls: { method: string; args: unknown }[];
}> {
	const harness = setup({
		config: { blockRows: [{ id: "b-1", content: "stale paragraph" }] },
	});
	// The re-check's content read (baseline SELECT) serves the rewritten
	// form — the kernel-side change landed after approval (the baseline was
	// established from the pre-dialog block read; the re-check re-reads NOW).
	const baseQuery = harness.client.query.bind(harness.client);
	let rechecked = false;
	harness.client.query = async (stmt: string) => {
		const rows = await baseQuery(stmt);
		if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD) && !rechecked) {
			rechecked = true;
			return [{ id: "b-1", content: "concurrently rewritten" }];
		}
		return rows;
	};
	return harness;
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
			config: {
				childrenFor: SECTION_DOC,
				onInsert: () => {
					childrenFor["d-doc"] = [
						...SECTION_DOC["d-doc"],
						walkBlock("b-new", "p", "", "new fact"),
					];
				},
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
		expect(result.anchor).toBe("appendBlock(root) — no next heading");
		const insert = docEnd.calls.find((c) => c.method === "appendBlock");
		expect(insert?.args).toEqual({ data: "new fact", parentID: "d-doc" });

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
		const lastHeading = await trailing.execute(appendParams("h2"));
		expect(lastHeading.anchor).toBe("appendBlock(root) — no next heading");
	});

	it("walk-set diff: a returned id absent from the post-write tree → error (silent rollback)", async () => {
		const appended = setup({ config: { childrenFor: SECTION_DOC } }); // the tree never changes
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

	it("mid-sweep drop after landed deletes → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		let deletes = 0;
		const harness = setup({
			config: {
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
			config: {
				childrenFor: REPLACE_DOC,
				refRows: [{ root_id: "d-other" }],
				hpathRows: [{ hpath: "/Other doc" }],
			},
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
			config: {
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
	});

	it("final section: the sweep runs to end of doc (trailing content deleted), anchor is appendBlock(root)", async () => {
		const harness = setup({
			config: {
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
		// Read 1 (baseline, pre-dialog) matches the walk; read 2 (the
		// post-approval re-check) serves the concurrently rewritten p1 — the
		// kernel-side change landed after approval.
		const harness = await replaceQueryHarness((read) =>
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

	it("the baseline read precedes the confirmation dialog — approval establishes the displayed content, not a post-approval re-read", async () => {
		// The establish read (read 1) must run before confirmGate: a change
		// landing between display and approval must surface as stale_content
		// on the re-check (read 2), never be laundered into the baseline by a
		// post-approval read.
		const harness = setup({ config: { childrenFor: REPLACE_DOC } });
		const baseQuery = harness.client.query.bind(harness.client);
		// Record how many confirmations had fired at each baseline read.
		const timeline: number[] = [];
		harness.client.query = async (stmt: string) => {
			if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) {
				timeline.push(harness.confirmCalls.length);
			}
			return baseQuery(stmt);
		};
		await harness.execute(replaceParams);
		expect(harness.confirmCalls).toHaveLength(1);
		expect(timeline).toEqual([0, 1]);
	});

	it("walk/blocks representation drift does not false-positive stale_content", async () => {
		// The walk serves a plain form, blocks.content a rendered form —
		// baseline and re-check both ride blocks.content, so the replace
		// proceeds (the precondition stays representation-independent).
		const harness = await replaceQueryHarness(
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

	it("write results re-seed outline baselines from blocks.content — follow-up writes compare like-for-like", async () => {
		// The walk serves a plain form ("old two"), blocks.content the
		// rendered form ("old **two**"). The write result carries the
		// outline, so its headings re-baseline from blocks.content (the
		// representation the re-check hashes); a walk-seeded baseline would
		// refuse the follow-up write as stale_content on pure representation
		// drift.
		const harness = await replaceQueryHarness(
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
			[{ id: "p2", content: "old **two**" }],
		);
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
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) {
				// Real-kernel mirror: rows for exactly the requested IDs.
				const ids = [...stmt.matchAll(/'([^']*)'/g)].map((m) => m[1]);
				return ids.flatMap((id) =>
					id !== undefined && stored[id] !== undefined
						? [{ id, content: stored[id] }]
						: [],
				);
			}
			return baseQuery(stmt);
		};
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

/** replace-section harness with scripted `WHERE id IN` content reads —
 * read 1 is the pre-dialog baseline read, read 2 the post-approval
 * re-check (the two representation-matched reads the precondition rides). */
async function replaceQueryHarness(
	respondIdIn: (read: number) => Record<string, unknown>[],
	applyInsert?: (children: Record<string, unknown[]>) => void,
	blockRows: Record<string, unknown>[] = [],
) {
	const harness = setup({
		config: {
			blockRows,
			childrenFor: REPLACE_DOC,
			...(applyInsert
				? {
						onInsert: () => {
							applyInsert(harness.childrenFor);
						},
					}
				: {}),
		},
	});
	const baseQuery = harness.client.query.bind(harness.client);
	let idInReads = 0;
	harness.client.query = async (stmt: string) => {
		if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) {
			idInReads += 1;
			return respondIdIn(idInReads);
		}
		return baseQuery(stmt);
	};
	return harness;
}

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
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1"]);
	});

	it("a kernel success no-op still reports ok — with the walk-set evidence naming it", async () => {
		// childrenFor keeps the block post-delete: the kernel "deleted"
		// nothing (ErrBlockNotFound → nil, stale-target record).
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
	});

	it("a foreign blockId (another doc's block) is refused before any dialog or kernel delete", async () => {
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

	it("a pre-deleted target: no dialog, kernel no-op → ok with the absent-target evidence", async () => {
		// blockRows [] — the target vanished before the call; the delete-set
		// display and confirmation are skipped (nothing to protect).
		const { execute, calls, confirmCalls } = setup({
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
		expect(confirmCalls).toHaveLength(0);
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

	it("doc-level: removeDocByID fires and the result carries only invalidRefs (pinned shape)", async () => {
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

	it("a foreign blockId (a block of another doc) is refused before any anchor or kernel move", async () => {
		// b-foreign is not in the source walk — membership is the scoping check.
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

	it("a pre-deleted source block: moveBlock's synchronous not-found error surfaces verbatim (stale-target record)", async () => {
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
		expect(result.status).toBe("error");
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
		expect(result.message).toContain(
			"already sits at the destination position",
		);
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
		expect(result.message).toContain(
			"already sits at the destination position",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

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
		expect(result.message).toContain("not the doc's last top-level block");
		expect(calls.filter((c) => c.method === "moveBlock")).toHaveLength(1);
	});

	it("same-doc doc-end move with children: the trailing child doesn't false-fail the position check", async () => {
		// Flattened document order puts the moved block's child after it —
		// a "last walk element" shape would false-fail this good move.
		// Nested depth comes from the walk's recursion (childrenFor[p1]),
		// not from a depth field on the doc's flat child list.
		const harness = moveHarness(() => {
			harness.childrenFor["d-doc"] = [
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p2", "p", "", "stay"),
				walkBlock("p1", "p", "", "mover"),
			];
			harness.childrenFor["p1"] = [walkBlock("c1", "p", "", "kid")];
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
	});

	it("doc-end pre-check survives trailing children: block with a child already at doc end refuses, zero kernel moves", async () => {
		// p2's child c1 is the walk's literal last element; the doc-end
		// shape is "last top-level block", not "last element". Nested depth
		// comes from the walk's recursion (childrenFor[p2]).
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "p2", content: "stay" }],
			childrenFor: {
				"d-doc": [
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("p1", "p", "", "first"),
					walkBlock("p2", "p", "", "stay"),
				],
				p2: [walkBlock("c1", "p", "", "kid")],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p2",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"already sits at the destination position",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("same-doc no-op target: block already immediately after the anchor → refusal, zero kernel moves", async () => {
		// c1 (depth 2) already follows p1, h1's section anchor. The kernel
		// moveBlock({id: c1, previousID: p1}) would no-op while the walk-set
		// check ("c1 present") reports a successful move — the generalized
		// pre-check refuses instead.
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "c1", content: "nested" }],
			childrenFor: {
				"d-doc": [
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("p1", "p", "", "first"),
					{ ...walkBlock("c1", "p", "", "nested"), depth: 2 },
				],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "c1",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"already sits at the destination position",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("same-doc kernel no-op behind HTTP success: position check catches the misplacement", async () => {
		// h1's section is [p1, p2]: moving p1 to its end anchors on p2. The
		// stub never applies the move, so the post-move walk is unchanged —
		// presence-based verification would report success for a no-op;
		// the position check fails loud instead.
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "p1", content: "mover" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"present but not at its landing position after the anchor",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			1,
		);
	});

	it("same-doc: anchor block vanished post-move → position check falls back to presence", async () => {
		// The kernel applies the move, but a concurrent delete removed the
		// anchor block p2 — the position is unverifiable, so the check
		// falls back to presence rather than false-failing.
		const harness = moveHarness(() => {
			harness.childrenFor["d-doc"] = [
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p1", "p", "", "mover"),
			];
		});
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
	it("edit: post-write echo-read drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				armQueryError: (set) => {
					arm = set;
				},
				onUpdate: () => arm?.(new SiYuanNetworkError()),
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
	});

	it("edit: post-write read timeout classifies the same way", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				armQueryError: (set) => {
					arm = set;
				},
				onUpdate: () => arm?.(new SiYuanTimeoutError(30_000)),
			},
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("post-write verification reads failed");
	});

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
