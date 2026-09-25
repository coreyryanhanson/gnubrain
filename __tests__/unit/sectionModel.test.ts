// The outline presentation and the heading-target refusal, pinned over
// fixture trees built through the real walkBlockTree — the tool-side
// consumers of the walk. The section rule itself (membership/boundary/
// closure + anchors) is falsified by the primitives repo's placement
// corpus; `headingLevel` is shared with it, which is the anti-drift seam
// these fixtures guard on this side.

import { describe, expect, it } from "vitest";
import {
	TARGETABLE_CONTAINER_TYPES,
	walkBlockTree,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import { containerPrefix, renderOutlineLines } from "../../outline.js";
import { headingInWalk, type DocTarget } from "../../writeFlow.js";
import { writeKernelStub } from "./writeHarness.js";

// ---------------------------------------------------------------- fixtures

interface FNode {
	id: string;
	type: string;
	subType: string;
	content: string;
	children: FNode[];
}

const h = (id: string, level: number, content: string): FNode => ({
	id,
	type: "h",
	subType: `h${level}`,
	content,
	children: [],
});
const p = (id: string, content = "body"): FNode => ({
	id,
	type: "p",
	subType: "",
	content,
	children: [],
});
const box = (
	id: string,
	type: string,
	children: FNode[],
	subType = "",
): FNode => ({ id, type, subType, content: type, children });

/** Seed a kernel stub's child map from the fixture tree: the document's
 * root children plus every container's children. The real walk recurses
 * exactly into the containers, so unseeded ids never matter. */
function childrenMap(
	root: FNode[],
	docId: string,
): Record<string, Record<string, unknown>[]> {
	const toRow = (n: FNode): Record<string, unknown> => ({
		id: n.id,
		type: n.type,
		subType: n.subType,
		content: n.content,
	});
	const map: Record<string, Record<string, unknown>[]> = {
		[docId]: root.map(toRow),
	};
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				map[node.id] = node.children.map(toRow);
				visit(node.children);
			}
		}
	};
	visit(root);
	return map;
}

async function buildWalk(root: FNode[]): Promise<WalkedBlock[]> {
	const { client } = writeKernelStub({
		childrenFor: childrenMap(root, "d-doc"),
	});
	return walkBlockTree(client, "d-doc");
}

// The outline fixture set: one tree per container-prefix class the
// renderer distinguishes, plus the refused containers.
const OUTLINE_FIXTURES: FNode[][] = [
	[h("hA", 1, "A"), p("p1"), h("hB", 1, "B")],
	[h("hA", 1, "A"), p("p1"), h("hA1", 2, "A1"), p("p2"), h("hB", 1, "B")],
	[
		h("hTop", 1, "Top"),
		box("c1", "callout", [h("hN", 2, "N"), p("p2")]),
		p("pOut"),
		h("hNext", 1, "Next"),
	],
	[
		h("hTop", 1, "Top"),
		box("l1", "l", [
			box("i1", "i", [h("hH", 2, "H"), p("p3")]),
			box("i2", "i", [p("i2p")]),
		]),
		h("hNext", 1, "Next"),
	],
	[
		h("hTop", 1, "Top"),
		box("b2", "b", [p("p3")]),
		box("s1", "s", [h("hH", 2, "H")]),
		box("t1", "tab", [h("hT", 2, "In tab")]),
		h("hNext", 1, "Next"),
	],
	[
		h("hA", 1, "A"),
		box("tabs1", "tabs", [h("hT", 1, "In tabs")]),
		box("fn1", "", [h("hF", 2, "In footnote")]),
		h("hB", 1, "B"),
	],
];

describe("outline rendering", () => {
	it("every heading line carries the → id payload", async () => {
		for (const fixture of OUTLINE_FIXTURES) {
			const walk = await buildWalk(fixture);
			const outline = renderOutlineLines(walk).join("\n");
			const lines = outline.split("\n");
			const headings = walk.filter((b) => b.type === "h");
			expect(lines).toHaveLength(headings.length);
			for (const heading of headings) {
				const line = lines.find((l: string) => l.endsWith(`→ ${heading.id}`));
				const refused = !TARGETABLE_CONTAINER_TYPES.has(
					heading.parentType ?? "",
				);
				if (!refused) {
					expect(line).toBeDefined();
					expect(line).not.toContain("(not targetable)");
				}
			}
		}
	});

	it("(not targetable) marks exactly the refused containers", async () => {
		const walk = await buildWalk(
			OUTLINE_FIXTURES[OUTLINE_FIXTURES.length - 1]!,
		);
		const lines = renderOutlineLines(walk);
		for (const heading of walk.filter((b) => b.type === "h")) {
			const line = lines.find((l) => l.includes(heading.id));
			expect(line).toBeDefined();
			const refused = !TARGETABLE_CONTAINER_TYPES.has(heading.parentType ?? "");
			expect(line!.includes("(not targetable)")).toBe(refused);
		}
	});

	it("bracketed tokens for refused containers; a heading in a list item renders one bullet", async () => {
		const refused = await buildWalk(
			OUTLINE_FIXTURES[OUTLINE_FIXTURES.length - 1]!,
		);
		const refusedLines = renderOutlineLines(refused);
		expect(
			refusedLines.some((l) => l.includes("[tabs]") && l.includes("In tabs")),
		).toBe(true);
		expect(
			refusedLines.some(
				(l) => l.includes("[unnamed]") && l.includes("In footnote"),
			),
		).toBe(true);
		// l → i nesting renders through the item's bullet once, not twice.
		const listed = await buildWalk(OUTLINE_FIXTURES[3]!);
		const hLine = renderOutlineLines(listed).find((l) => l.includes("hH"));
		expect(hLine).toBeDefined();
		expect(hLine!.startsWith("-## ")).toBe(true);
	});

	// The glyph table and the write-side container pin encode the same
	// kernel vocabulary; this pins them together so a primitives-side
	// vocabulary bump turns red here instead of rendering a writable
	// container as `[unnamed]` in outlines.
	it("every targetable container type renders a defined glyph, never [unnamed]", () => {
		for (const type of TARGETABLE_CONTAINER_TYPES) {
			const prefix = containerPrefix({
				id: "c1",
				type,
				subType: "",
				content: "",
				parentId: null,
				parentType: "d",
			});
			expect(prefix).not.toBe("[unnamed]");
		}
	});
});

describe("refused targets", () => {
	const doc: DocTarget = {
		title: "Docker Networking",
		rootId: "d-doc",
	};
	it("a heading inside a tabs container is refused", () => {
		const walk: WalkedBlock[] = [
			{
				id: "tabs1",
				type: "tabs",
				subType: "",
				content: "tabs",
				parentId: null,
				parentType: "d",
			},
			{
				id: "h1",
				type: "h",
				subType: "h1",
				content: "In tabs",
				parentId: "tabs1",
				parentType: "tabs",
			},
		];
		const result = headingInWalk(walk, doc, "h1");
		expect("message" in result && result.message).toContain("'tabs' container");
	});
	it("a heading inside an unnamed container (a footnote definition) is refused too", () => {
		const walk: WalkedBlock[] = [
			{
				id: "fn1",
				type: "",
				subType: "",
				content: "fn",
				parentId: null,
				parentType: "d",
			},
			{
				id: "h2",
				type: "h",
				subType: "h2",
				content: "In footnote",
				parentId: "fn1",
				parentType: "",
			},
		];
		const result = headingInWalk(walk, doc, "h2");
		expect("message" in result && result.message).toContain(
			"an unnamed container",
		);
	});
});
