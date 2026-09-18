// The placement-map corpus: one canonical fixture set, an independent
// oracle, and the properties that fail when any consumer drifts from the
// one section rule (membership = following siblings in the heading's own
// container, level-bounded; placement = before the boundary, else the
// container's end).
//
// The fixture tree feeds both consumers from one structure — the walk is
// produced by the real walkBlockTree over a stub seeded from the tree, the
// oracle reads the child list each heading was stored under — so the two
// cannot share a bug.

import { describe, expect, it } from "vitest";
import {
	deriveAppendAnchor,
	deriveMoveAnchor,
	landingId,
	sectionOf,
	type AppendPlacement,
} from "../../writeAnchors.js";
import {
	renderOutlineFromWalk,
	TARGETABLE_CONTAINER_TYPES,
	walkBlockTree,
	type WalkedBlock,
} from "../../walk.js";
import { headingInWalk } from "../../writeFlow.js";
import { writeKernelStub } from "./writeHarness.js";
import type { DocTarget } from "../../writeFlow.js";

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

interface Built {
	walk: WalkedBlock[];
	/** parentId → the child list the fixture stored under it (root = null).
	 * The oracle's only input. */
	siblings: Map<string | null, FNode[]>;
}

async function build(root: FNode[]): Promise<Built> {
	const siblings = new Map<string | null, FNode[]>();
	siblings.set(null, root);
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			if (node.children.length > 0) {
				siblings.set(node.id, node.children);
				visit(node.children);
			}
		}
	};
	visit(root);
	const { client } = writeKernelStub({
		childrenFor: childrenMap(root, "d-doc"),
	});
	return { walk: await walkBlockTree(client, "d-doc"), siblings };
}

// The independent oracle: following SIBLINGS within the heading's own
// container, up to the first sibling heading of level <= the target's.
// Deep headings never bound; a container does. Computed from the fixture
// tree, never from the walk.
function headingChildrenIds(siblings: FNode[], headingId: string): string[] {
	const idx = siblings.findIndex((n) => n.id === headingId);
	if (idx < 0) return [];
	const level = Number(siblings[idx]!.subType.slice(1)) || 1;
	const out: string[] = [];
	for (let i = idx + 1; i < siblings.length; i++) {
		const node = siblings[i]!;
		if (node.type === "h" && (Number(node.subType.slice(1)) || 1) <= level) {
			break;
		}
		out.push(node.id);
	}
	return out;
}

function collectSubtree(node: FNode, into: Set<string>): void {
	into.add(node.id);
	for (const child of node.children) collectSubtree(child, into);
}

/** The fixture tree flattened to id → node, so a member id reaches its
 * stored subtree for the closure check. */
function fixtureTreeIndex(root: FNode[]): Map<string, FNode> {
	const byId = new Map<string, FNode>();
	const visit = (nodes: FNode[]): void => {
		for (const node of nodes) {
			byId.set(node.id, node);
			visit(node.children);
		}
	};
	visit(root);
	return byId;
}

/** The fixture tree in pre-order — the document order the flattened walk
 * must agree with — each entry carrying its tree parent. */
function preOrderIds(root: FNode[]): { id: string; parentId: string | null }[] {
	const out: { id: string; parentId: string | null }[] = [];
	const visit = (nodes: FNode[], parentId: string | null): void => {
		for (const node of nodes) {
			out.push({ id: node.id, parentId });
			visit(node.children, node.id);
		}
	};
	visit(root, null);
	return out;
}

// ------------------------------------------------------------ the corpus

type InsertExpect =
	| { kind: "insert"; nextID: string }
	| { kind: "append"; containerId: string | null };
type MoveExpect = { kind: "move"; previousID: string };

interface Row {
	label: string;
	fixture: FNode[];
	target: string;
	members: string[];
	boundary: string | null;
	insert: InsertExpect;
	move: MoveExpect;
	placement?: AppendPlacement;
}

const S1: FNode[] = [h("hA", 1, "A"), p("p1"), h("hB", 1, "B")];
const S2: FNode[] = [
	h("hA", 1, "A"),
	p("p1"),
	h("hA1", 2, "A1"),
	p("p2"),
	h("hB", 1, "B"),
];
const S13: FNode[] = [h("hA", 1, "A")];

const CORPUS: Row[] = [
	{
		label: "a plain section — insert before the boundary, move after the body",
		fixture: S1,
		target: "hA",
		members: ["p1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "p1" },
	},
	{
		label:
			"a deeper heading belongs to the section — the run runs past it to the boundary",
		fixture: S2,
		target: "hA",
		members: ["p1", "hA1", "p2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "p2" },
	},
	{
		label:
			"a list member ends the sibling run — the insert is never anchored inside it",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("l2", "l", [box("i3", "i", [p("i3a")]), box("i4", "i", [p("i4a")])]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "l2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "l2" },
	},
	{
		label:
			"a quote member is a member — its descendants are closure, not members",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("b2", "b", [p("p3")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "b2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "b2" },
	},
	{
		label:
			"a callout-nested section sweeps only inside the callout — the container's following sibling survives",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [h("hN", 2, "N"), p("p2")]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hN",
		members: ["p2"],
		boundary: null,
		insert: { kind: "append", containerId: "c1" },
		move: { kind: "move", previousID: "p2" },
	},
	{
		label:
			"a sibling heading inside one callout bounds the run — the insert lands inside the container",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [
				h("hA2", 2, "A"),
				p("pA"),
				h("hB2", 2, "B"),
				p("pB"),
			]),
			h("hNext", 1, "Next"),
		],
		target: "hA2",
		members: ["pA"],
		boundary: "hB2",
		insert: { kind: "insert", nextID: "hB2" },
		move: { kind: "move", previousID: "pA" },
	},
	{
		label:
			"a heading inside a list item is container-local — the sibling list item survives",
		fixture: [
			h("hTop", 1, "Top"),
			box("l1", "l", [
				box("i1", "i", [h("hH", 2, "H"), p("p3")]),
				box("i2", "i", [p("i2p")]),
			]),
			h("hNext", 1, "Next"),
		],
		target: "hH",
		members: ["p3"],
		boundary: null,
		insert: { kind: "append", containerId: "i1" },
		move: { kind: "move", previousID: "p3" },
	},
	{
		label:
			"an empty section between two headings — the move anchors on the target heading itself",
		fixture: [h("hA", 1, "A"), h("hB", 1, "B")],
		target: "hA",
		members: [],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "hA" },
	},
	{
		label: "a section running to the doc end — appendBlock on the root",
		fixture: S1.slice(0, 2),
		target: "hA",
		members: ["p1"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		move: { kind: "move", previousID: "p1" },
	},
	{
		label:
			"a trailing list container runs to the doc end — the move anchors on the container, never inside it",
		fixture: [h("hA", 1, "A"), box("l2", "l", [box("i3", "i", [p("i3a")])])],
		target: "hA",
		members: ["l2"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		move: { kind: "move", previousID: "l2" },
	},
	{
		label: "a superblock-nested section appends inside the superblock",
		fixture: [
			h("hTop", 1, "Top"),
			box("s1", "s", [h("hH", 2, "H"), p("p3")]),
			h("hNext", 1, "Next"),
		],
		target: "hH",
		members: ["p3"],
		boundary: null,
		insert: { kind: "append", containerId: "s1" },
		move: { kind: "move", previousID: "p3" },
	},
	{
		label:
			"a heading nested inside a quote member is closure — the anchor stays at doc level",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("b2", "b", [p("pA"), h("hH", 2, "H")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "b2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "b2" },
	},
	{
		label: "a lone heading — an empty section running to the doc end",
		fixture: S13,
		target: "hA",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: null },
		move: { kind: "move", previousID: "hA" },
	},
	{
		label:
			"sibling headings inside a callout, with the doc's trailing blocks outside — nothing past the container is touched",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [
				h("hA2", 2, "A"),
				p("pA"),
				h("hB2", 2, "B"),
				p("pB"),
			]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hA2",
		members: ["pA"],
		boundary: "hB2",
		insert: { kind: "insert", nextID: "hB2" },
		move: { kind: "move", previousID: "pA" },
	},
	{
		label:
			"a section ending in an empty subheading — the move anchors on that subheading",
		fixture: [h("hA", 1, "A"), p("p1"), h("hA1", 2, "A1")],
		target: "hA",
		members: ["p1", "hA1"],
		boundary: null,
		insert: { kind: "append", containerId: null },
		move: { kind: "move", previousID: "hA1" },
	},
	{
		label:
			"a container-nested empty section — the sweep is empty, the doc's trailing blocks survive",
		fixture: [
			h("hTop", 1, "Top"),
			box("c1", "callout", [h("hN", 2, "N")]),
			p("pOut"),
			h("hNext", 1, "Next"),
		],
		target: "hN",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: "c1" },
		move: { kind: "move", previousID: "hN" },
	},
	// placement: "section-start" — a second projection of the same Section.
	{
		label:
			"section-start inserts before the first subsection, after the leading run",
		fixture: S2,
		target: "hA",
		members: ["p1", "hA1", "p2"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hA1" },
		move: { kind: "move", previousID: "p2" },
		placement: "section-start",
	},
	{
		label: "section-start on an empty section is identical to the default",
		fixture: S13,
		target: "hA",
		members: [],
		boundary: null,
		insert: { kind: "append", containerId: null },
		move: { kind: "move", previousID: "hA" },
		placement: "section-start",
	},
	{
		label:
			"section-start with no deeper sibling heading falls to the boundary — identical to the default",
		fixture: S1,
		target: "hA",
		members: ["p1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "p1" },
		placement: "section-start",
	},
	{
		label:
			"section-start ignores a deeper heading nested inside a container member — the body never lands above it",
		fixture: [
			h("hA", 1, "A"),
			p("p1"),
			box("c1", "callout", [h("hX", 2, "X")]),
			h("hB", 1, "B"),
		],
		target: "hA",
		members: ["p1", "c1"],
		boundary: "hB",
		insert: { kind: "insert", nextID: "hB" },
		move: { kind: "move", previousID: "c1" },
		placement: "section-start",
	},
];

// Every fixture the properties range over: the corpus plus the refused-
// target fixture (property 6 needs the non-targetable outline marker).
const ALL_FIXTURES: FNode[][] = [
	...CORPUS.map((row) => row.fixture),
	[
		h("hA", 1, "A"),
		box("tabs1", "tabs", [h("hT", 1, "In tabs")]),
		box("fn1", "", [h("hF", 2, "In footnote")]),
		h("hB", 1, "B"),
	],
];

// ------------------------------------------------------------- assertions

describe("placement-map corpus", () => {
	for (const row of CORPUS) {
		it(row.label, async () => {
			const { walk } = await build(row.fixture);
			const heading = walk.find((b) => b.id === row.target && b.type === "h");
			expect(heading).toBeDefined();
			const section = sectionOf(walk, row.target);
			expect(section).toBeDefined();
			// The sweep reads members; the display/baselines read closure —
			// pinned separately below, so the members assert covers both
			// corpus columns that list the sibling run.
			expect(section!.members.map((m) => m.id)).toEqual(row.members);
			expect(section!.boundary?.id ?? null).toEqual(row.boundary);
			const insert = deriveAppendAnchor(
				walk,
				heading,
				row.placement ?? "section-end",
			);
			expect(insert.kind).toBe(row.insert.kind);
			if (row.insert.kind === "insert" && insert.kind === "insert") {
				expect(insert.nextID).toBe(row.insert.nextID);
			}
			if (row.insert.kind === "append" && insert.kind === "append") {
				expect(insert.containerId).toBe(row.insert.containerId);
			}
			const move = deriveMoveAnchor(walk, row.target);
			expect(move.kind).toBe(row.move.kind);
			if (row.move.kind === "move" && move.kind === "move") {
				expect(move.previousID).toBe(row.move.previousID);
			}
		});
	}
});

describe("properties", () => {
	it("oracle equality: sectionOf.members equals the independent oracle for every heading in every fixture", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk, siblings } = await build(fixture);
			for (const list of siblings.values()) {
				for (const node of list) {
					if (node.type !== "h") continue;
					const section = sectionOf(walk, node.id);
					expect(section).toBeDefined();
					expect(section!.members.map((m) => m.id)).toEqual(
						headingChildrenIds(list, node.id),
					);
				}
			}
		}
	});

	it("anchor outside the swept set: the insert anchor is never inside a member's closure", async () => {
		// The section-end anchor only: the section-start projection is
		// append-only, and its anchor IS a member (the first subsection) —
		// append sweeps nothing, so the property does not apply there.
		for (const fixture of ALL_FIXTURES) {
			const { walk } = await build(fixture);
			for (const heading of walk.filter((b) => b.type === "h")) {
				const section = sectionOf(walk, heading.id)!;
				const swept = new Set(section.closure.map((b) => b.id));
				const anchor = deriveAppendAnchor(walk, heading, "section-end");
				const anchorId =
					anchor.kind === "insert" ? anchor.nextID : anchor.containerId;
				if (anchorId === null) continue; // the doc root, not a block
				expect(swept.has(anchorId)).toBe(false);
			}
		}
	});

	it("delete-set scope: closure is members plus every tree descendant, in document order", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk } = await build(fixture);
			const byId = fixtureTreeIndex(fixture);
			for (const heading of walk.filter((b) => b.type === "h")) {
				const section = sectionOf(walk, heading.id)!;
				const subtree = new Set<string>();
				for (const member of section.members) {
					collectSubtree(byId.get(member.id)!, subtree);
				}
				expect(section.closure.map((b) => b.id)).toEqual(
					walk.filter((b) => subtree.has(b.id)).map((b) => b.id),
				);
			}
		}
	});

	it("move-anchor invariant: the anchor is never a heading whose own section has content", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk } = await build(fixture);
			for (const heading of walk.filter((b) => b.type === "h")) {
				const move = deriveMoveAnchor(walk, heading.id);
				expect(move.kind).toBe("move");
				if (move.kind !== "move") continue;
				const anchorBlock = walk.find((b) => b.id === move.previousID);
				expect(anchorBlock).toBeDefined();
				if (anchorBlock!.type !== "h") continue;
				expect(sectionOf(walk, move.previousID)!.members).toEqual([]);
			}
		}
	});

	it("parentage: every walked block's (parentId, parentType) equals the fixture key it was stored under", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk, siblings } = await build(fixture);
			for (const block of walk) {
				const list = siblings.get(block.parentId);
				expect(list?.some((n) => n.id === block.id)).toBe(true);
				if (block.parentId === null) {
					expect(block.parentType).toBe("d");
				} else {
					const parent = walk.find((b) => b.id === block.parentId);
					expect(parent).toBeDefined();
					expect(block.parentType).toBe(parent!.type);
				}
			}
		}
	});

	it("outline: every heading line carries the → id payload, and (not targetable) marks exactly the refused containers", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk } = await build(fixture);
			const { outline } = renderOutlineFromWalk("s", "test", walk);
			const lines = outline.split("\n");
			const headings = walk.filter((b) => b.type === "h");
			expect(lines).toHaveLength(headings.length);
			for (const heading of headings) {
				const line = lines.find((l: string) => l.endsWith(`→ ${heading.id}`));
				// A refused heading's line ends with the marker after the id.
				const refused = !TARGETABLE_CONTAINER_TYPES.has(
					heading.parentType ?? "",
				);
				if (refused) {
					const marked = lines.find((l: string) =>
						l.endsWith(`→ ${heading.id} (not targetable)`),
					);
					expect(marked).toBeDefined();
				} else {
					expect(line).toBeDefined();
					expect(line).not.toContain("(not targetable)");
				}
			}
		}
	});

	it("landingId is the same rule: the tree's pre-order entry after the anchor's subtree — never the raw next entry", async () => {
		for (const fixture of ALL_FIXTURES) {
			const { walk } = await build(fixture);
			// The oracle recomputes the landing from the fixture tree's
			// pre-order, independently of the real walk's flattening.
			const flat = preOrderIds(fixture);
			const byId = new Map(flat.map((e) => [e.id, e]));
			for (const heading of walk.filter((b) => b.type === "h")) {
				const move = deriveMoveAnchor(walk, heading.id);
				if (move.kind !== "move") continue;
				const idx = flat.findIndex((e) => e.id === move.previousID);
				let expected: string | undefined;
				for (let i = idx + 1; i < flat.length; i++) {
					let parent: string | null = flat[i]!.parentId;
					let inSubtree = false;
					while (parent !== null) {
						if (parent === move.previousID) {
							inSubtree = true;
							break;
						}
						parent = byId.get(parent)!.parentId;
					}
					if (!inSubtree) {
						expected = flat[i]!.id;
						break;
					}
				}
				// The append branch (the container's last child) is pinned in
				// writeAnchors.test.ts; the move branch is the parent-chain rule.
				expect(landingId(walk, move)).toBe(expected);
			}
		}
	});
});

describe("refused targets", () => {
	const doc: DocTarget = {
		title: "Docker Networking",
		rootId: "d-doc",
	};
	it("a heading inside a tabs container is refused before any dialog", () => {
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
