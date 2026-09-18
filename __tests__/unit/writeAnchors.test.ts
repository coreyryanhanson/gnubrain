// writeAnchors tests — the pure section/anchor rules: the sectionOf
// primitive (membership, boundary, closure), move-anchor derivation
// (end-of-section, nested-heading recursion, container boundaries,
// fold-state independence), the append anchor (boundary insert vs
// container append), and landingId (kernel placement over the walk).

import { describe, expect, it } from "vitest";
import {
	deriveAppendAnchor,
	deriveMoveAnchor,
	landingId,
	sectionOf,
	type MoveAnchor,
} from "../../writeAnchors.js";
import { walkBlock } from "./writeHarness.js";

describe("sectionOf (membership, boundary, closure)", () => {
	it("members run to the next same-or-shallower sibling heading; deeper headings belong to the section", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "Top"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("h2", "h", "h2", "Sub"),
			walkBlock("p2", "p", "", "two"),
			walkBlock("p3", "p", "", "three"),
		];
		const section = sectionOf(walk, "h1");
		expect(section?.members.map((b) => b.id)).toEqual(["p1", "h2", "p2", "p3"]);
		expect(section?.boundary).toBeNull();
		expect(section?.containerId).toBeNull();
		expect(section?.closure.map((b) => b.id)).toEqual(["p1", "h2", "p2", "p3"]);
	});

	it("the boundary is the first same-or-shallower sibling heading", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h1b", "h", "h1", "B"),
			walkBlock("p2", "p", "", "y"),
		];
		const section = sectionOf(walk, "h1");
		expect(section?.members.map((b) => b.id)).toEqual(["p1"]);
		expect(section?.boundary?.id).toBe("h1b");
		expect(section?.closure.map((b) => b.id)).toEqual(["p1"]);
	});

	it("a container member ends the sibling run — nothing past it is a member", () => {
		// pOut and the next heading live OUTSIDE c1: h2's section is
		// container-bounded, so they survive a sweep of the section.
		const walk = [
			walkBlock("h1", "h", "h1", "Top"),
			walkBlock("c1", "callout", "", "callout"),
			walkBlock("h2", "h", "h2", "Nested", "c1", "callout"),
			walkBlock("p2", "p", "", "callout body", "c1", "callout"),
			walkBlock("pOut", "p", "", "outside"),
			walkBlock("h3", "h", "h1", "Next"),
		];
		const section = sectionOf(walk, "h2");
		expect(section?.members.map((b) => b.id)).toEqual(["p2"]);
		expect(section?.boundary).toBeNull();
		expect(section?.containerId).toBe("c1");
		expect(section?.closure.map((b) => b.id)).toEqual(["p2"]);
	});

	it("closure carries a container member's descendants", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("l1", "l", "", "list"),
			walkBlock("i1", "i", "", "item one", "l1", "l"),
			walkBlock("i2", "i", "", "item two", "l1", "l"),
			walkBlock("h2", "h", "h1", "B"),
		];
		const section = sectionOf(walk, "h1");
		expect(section?.members.map((b) => b.id)).toEqual(["p1", "l1"]);
		expect(section?.closure.map((b) => b.id)).toEqual(["p1", "l1", "i1", "i2"]);
	});

	it("an unresolvable heading yields undefined (the flow refuses)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(sectionOf(walk, "ghost")).toBeUndefined();
	});

	it("a sibling heading of the same level bounds the run inside a shared container", () => {
		const walk = [
			walkBlock("c1", "callout", "", "callout"),
			walkBlock("hA", "h", "h2", "A", "c1", "callout"),
			walkBlock("pA", "p", "", "body A", "c1", "callout"),
			walkBlock("hB", "h", "h2", "B", "c1", "callout"),
			walkBlock("pB", "p", "", "body B", "c1", "callout"),
		];
		const section = sectionOf(walk, "hA");
		expect(section?.members.map((b) => b.id)).toEqual(["pA"]);
		expect(section?.boundary?.id).toBe("hB");
	});
});

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
			walkBlock("item", "i", "", "item", "list", "l"),
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

	it("omitted toHeadingId, populated destination → move after the last root-level block (doc end)", () => {
		const anchor = deriveMoveAnchor(
			[
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p1", "p", "", "one"),
				walkBlock("p2", "p", "", "last top-level"),
			],
			undefined,
		);
		expect(anchor).toEqual({
			kind: "move",
			previousID: "p2",
			anchor: "previousID=p2 (doc end)",
		});
	});

	it("omitted toHeadingId, empty destination → appendBlock on the root (prepend IS the end position)", () => {
		const anchor = deriveMoveAnchor([], undefined);
		expect(anchor).toEqual({
			kind: "append",
			containerId: null,
			anchor: "appendBlock(root) — doc end",
		});
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

	it("a member heading with an empty section is the anchor, even mid-section", () => {
		// The section ends in a subheading with no content of its
		// own — anchoring past it IS the end of the parent's section.
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("h2", "h", "h2", "A.b"),
		];
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("h2");
	});

	it("a heading inside a container anchors within that container", () => {
		// The section is container-local — the anchor is the last
		// member inside the callout, never the doc-level blocks after it.
		const walk = [
			walkBlock("h1", "h", "h1", "Top"),
			walkBlock("c1", "callout", "", "callout"),
			walkBlock("h2", "h", "h2", "N", "c1", "callout"),
			walkBlock("p2", "p", "", "callout body", "c1", "callout"),
			walkBlock("pOut", "p", "", "outside"),
			walkBlock("h3", "h", "h1", "Next"),
		];
		const anchor = deriveMoveAnchor(walk, "h2");
		expect(anchor.kind === "move" && anchor.previousID).toBe("p2");
	});
});

describe("landingId (kernel placement over the flattened walk)", () => {
	// The anchor echo is irrelevant to placement — only the kind + id are.
	const mv = (previousID: string): MoveAnchor => ({
		kind: "move",
		previousID,
		anchor: "",
	});

	it("leaf anchor: the entry right after it (parity with next-entry indexing)", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "one"),
			walkBlock("p2", "p", "", "two"),
		];
		expect(landingId(walk, mv("p1"))).toBe("p2");
	});

	it("container anchor: the entry after the container's SUBTREE, not its first child", () => {
		// The bug shape: a list's items trail it in the flattened walk, and
		// the kernel places the moved block as the list's next SIBLING —
		// next-entry indexing sees the first item and false-fails.
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("list", "l", "", "list"),
			walkBlock("i1", "i", "", "one", "list", "l"),
			walkBlock("i2", "i", "", "two", "list", "l"),
			walkBlock("h2", "h", "h1", "B"),
		];
		expect(landingId(walk, mv("list"))).toBe("h2");
	});

	it("derivation and placement agree: the container section's anchor lands past its own subtree", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "mover"),
			walkBlock("list", "l", "", "list"),
			walkBlock("i1", "i", "", "one", "list", "l"),
			walkBlock("i2", "i", "", "two", "list", "l"),
			walkBlock("h2", "h", "h1", "B"),
		];
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("list");
		expect(landingId(walk, anchor)).toBe("h2");
	});

	it("a leaf anchor that ends the walk → undefined (no entry after its subtree)", () => {
		// p2's subtree holds c1; every trailing entry is inside the subtree,
		// so nothing occupies the landing position after it.
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p2", "p", "", "last top-level"),
			walkBlock("c1", "p", "", "kid", "p2", "p"),
		];
		expect(landingId(walk, mv("p2"))).toBeUndefined();
	});

	it("vanished anchor → undefined (the caller falls back to presence)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(landingId(walk, mv("ghost"))).toBeUndefined();
	});

	it("append: the container's last child, surviving trailing deep children", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p2", "p", "", "last top-level"),
			walkBlock("c1", "p", "", "kid", "p2", "p"),
		];
		expect(
			landingId(walk, { kind: "append", containerId: null, anchor: "" }),
		).toBe("p2");
	});

	it("append on an empty walk → undefined", () => {
		expect(
			landingId([], { kind: "append", containerId: null, anchor: "" }),
		).toBeUndefined();
	});
});

describe("deriveAppendAnchor", () => {
	it("inserts before the section's boundary heading", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h1b", "h", "h1", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0])).toEqual({
			kind: "insert",
			nextID: "h1b",
			anchor: "nextID=h1b (next heading)",
		});
	});

	it("a deeper heading never bounds the section — no same-or-shallower boundary → appendBlock(root)", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h2", "h", "h2", "A.b"),
			walkBlock("p2", "p", "", "y"),
		];
		expect(deriveAppendAnchor(walk, walk[0])).toEqual({
			kind: "append",
			containerId: null,
			anchor: "appendBlock(root) — doc end",
		});
	});

	it("a container-nested final section appends to the container, not the doc root", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "Top"),
			walkBlock("c1", "callout", "", "callout"),
			walkBlock("h2", "h", "h2", "N", "c1", "callout"),
			walkBlock("p2", "p", "", "callout body", "c1", "callout"),
			walkBlock("pOut", "p", "", "outside"),
		];
		expect(deriveAppendAnchor(walk, walk[2])).toEqual({
			kind: "append",
			containerId: "c1",
			anchor: "appendBlock(c1) — end of section",
		});
	});

	it("no heading → appendBlock(root)", () => {
		const anchor = deriveAppendAnchor(
			[walkBlock("h1", "h", "h1", "A")],
			undefined,
		);
		expect(anchor).toEqual({
			kind: "append",
			containerId: null,
			anchor: "appendBlock(root) — doc end",
		});
	});

	// placement: "section-start" — before the first deeper sibling heading;
	// every fallback lands where the default would.

	it("section-start inserts before the first subsection, after the leading run", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h2", "h", "h2", "A.b"),
			walkBlock("p2", "p", "", "y"),
			walkBlock("h1b", "h", "h1", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0], "section-start")).toEqual({
			kind: "insert",
			nextID: "h2",
			anchor: "nextID=h2 (next heading)",
		});
		// the same section's default anchor is the boundary, past the run
		expect(deriveAppendAnchor(walk, walk[0])).toEqual({
			kind: "insert",
			nextID: "h1b",
			anchor: "nextID=h1b (next heading)",
		});
	});

	it("section-start on an empty section is identical to the default", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("h1b", "h", "h1", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0], "section-start")).toEqual({
			kind: "insert",
			nextID: "h1b",
			anchor: "nextID=h1b (next heading)",
		});
		const lone = [walkBlock("h1", "h", "h1", "A")];
		expect(deriveAppendAnchor(lone, lone[0], "section-start")).toEqual({
			kind: "append",
			containerId: null,
			anchor: "appendBlock(root) — doc end",
		});
	});

	it("section-start with no subsection (only leading content) is identical to the default", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h1b", "h", "h1", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0], "section-start")).toEqual({
			kind: "insert",
			nextID: "h1b",
			anchor: "nextID=h1b (next heading)",
		});
	});

	it("section-start ignores a deeper heading nested inside a container member — it falls to the boundary", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("c1", "callout", "", "callout"),
			walkBlock("h2", "h", "h2", "X", "c1", "callout"),
			walkBlock("h1b", "h", "h1", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0], "section-start")).toEqual({
			kind: "insert",
			nextID: "h1b",
			anchor: "nextID=h1b (next heading)",
		});
	});
});
