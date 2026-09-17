// writeAnchors tests — the pure anchor/section-slicing rules: move-anchor
// derivation (end-of-section, nested-heading recursion, container
// boundaries, fold-state independence), the delete-set boundary + final
// sweep, and the append anchor (next heading vs appendBlock-on-root).

import { describe, expect, it } from "vitest";
import {
	deriveAppendAnchor,
	deriveMoveAnchor,
	landingId,
	sectionDeleteSet,
	type MoveAnchor,
} from "../../writeAnchors.js";
import { walkBlock } from "./writeHarness.js";

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
			walkBlock("i1", "i", "", "one", 2),
			walkBlock("i2", "i", "", "two", 2),
			walkBlock("h2", "h", "h1", "B"),
		];
		expect(landingId(walk, mv("list"))).toBe("h2");
	});

	it("derivation and placement agree: the container section's anchor lands past its own subtree", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "mover"),
			walkBlock("list", "l", "", "list"),
			walkBlock("i1", "i", "", "one", 2),
			walkBlock("i2", "i", "", "two", 2),
			walkBlock("h2", "h", "h1", "B"),
		];
		const anchor = deriveMoveAnchor(walk, "h1");
		expect(anchor.kind === "move" && anchor.previousID).toBe("list");
		expect(landingId(walk, anchor)).toBe("h2");
	});

	it("vanished anchor → undefined (the caller falls back to presence)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(landingId(walk, mv("ghost"))).toBeUndefined();
	});

	it("appendRoot: the last depth-1 block, surviving trailing deep children", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p2", "p", "", "last top-level"),
			walkBlock("c1", "p", "", "kid", 2),
		];
		expect(landingId(walk, { kind: "appendRoot", anchor: "" })).toBe("p2");
	});

	it("appendRoot on an empty walk → undefined", () => {
		expect(landingId([], { kind: "appendRoot", anchor: "" })).toBeUndefined();
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
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "p", "", "x"),
			walkBlock("h2", "h", "h2", "B"),
		];
		expect(deriveAppendAnchor(walk, walk[0])).toEqual({
			kind: "insert",
			nextID: "h2",
			anchor: "nextID=h2 (next heading)",
		});
	});

	it("no next heading → appendBlock(root)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		const anchor = deriveAppendAnchor(walk, walk[0]);
		expect(anchor.kind).toBe("appendRoot");
	});

	it("no heading → appendBlock(root)", () => {
		const anchor = deriveAppendAnchor(
			[walkBlock("h1", "h", "h1", "A")],
			undefined,
		);
		expect(anchor.kind).toBe("appendRoot");
	});
});
