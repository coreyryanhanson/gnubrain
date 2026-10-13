// writeAppend tests — the append mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import { headingInWalk } from "../../writeTarget.js";
import { SiYuanApiError, contentHash } from "siyuan-kb-primitives";
import { statementKind } from "siyuan-kb-primitives/testing";
import {
	setup,
	storedContentStub,
	walkBlock,
	SECTION_DOC,
} from "./writeHarness.js";

// ---------------------------------------------------------------------------
// append — tool-derived nextID anchor + walk-set verification
// ---------------------------------------------------------------------------

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

	it("the echo tail baselines served headings from the walk it serves, never a later SQL read", async () => {
		// The outline the result serves and the baselines it seeds are one
		// snapshot (the anti-laundering invariant: baselines.ts). The write's
		// own block is the one SQL-read (its stored form is unknowable at
		// submit time).
		const harness = setup({
			config: {
				childrenFor: BOUNDED_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...BOUNDED_DOC["d-doc"].slice(0, 4),
						walkBlock("b-new", "p", "", "new fact"),
						...BOUNDED_DOC["d-doc"].slice(4),
					];
				},
			},
		});
		storedContentStub(harness, {
			"b-new": "stored new fact",
			// A divergent row the index holds for the served heading — it
			// must never be asked for, let alone remembered.
			h1: "index-lag Goals",
		});
		const requestedIds: string[][] = [];
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-contents") {
				requestedIds.push(
					[...stmt.matchAll(/'([^']*)'/g)].flatMap((m) =>
						m[1] === undefined ? [] : [m[1]],
					),
				);
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(appendParams("h1"));
		expect(result.status).toBe("ok");
		// Only the write's own block is SQL-read; the served headings are
		// never re-read after the walk.
		expect(requestedIds).toEqual([["b-new"]]);
		// The served heading's baseline is the walk form it was shown, not
		// the index-lag row.
		expect(harness.baselines.servedHash("h1")).toBe(contentHash("Goals"));
		// The write's own block baselines from stored form.
		expect(harness.baselines.servedHash("b-new")).toBe(
			contentHash("stored new fact"),
		);
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
		const result = headingInWalk(
			{ blocks: walk, truncated: false, incomplete: false },
			{ title: "Doc", rootId: "d-doc" },
			"h2",
		);
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
