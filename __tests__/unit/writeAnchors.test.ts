// writeAnchors tests — only the shapes the placement-map corpus in
// sectionModel.test.ts cannot reach (its real walkBlockTree corpus plus the
// independent oracle pin the sectionOf/anchor/landingId rules over 20
// fixture trees). Everything here feeds an anchor the corpus never derives:
// an unresolvable heading, a missing walk target, and the landingId append
// branch. Anchor echo wording is pinned in writeModes.test.ts envelopes.

import { describe, expect, it } from "vitest";
import {
	deriveAppendAnchor,
	deriveMoveAnchor,
	landingId,
	sectionOf,
	type MoveAnchor,
} from "../../writeAnchors.js";
import { walkBlock } from "./writeHarness.js";

describe("writeAnchors — corpus-unreachable shapes", () => {
	it("sectionOf: an unresolvable heading yields undefined (the flow refuses)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(sectionOf(walk, "ghost")).toBeUndefined();
	});

	it("deriveMoveAnchor: omitted toHeadingId, populated destination → move after the last root-level block (doc end)", () => {
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

	it("deriveMoveAnchor: omitted toHeadingId, empty destination → appendBlock on the root (prepend IS the end position)", () => {
		const anchor = deriveMoveAnchor([], undefined);
		expect(anchor).toEqual({
			kind: "append",
			anchor: "appendBlock(root) — doc end",
		});
	});

	it("deriveAppendAnchor: no heading → appendBlock(root)", () => {
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

	// The anchor echo is irrelevant to placement — only the kind + id are.
	const mv = (previousID: string): MoveAnchor => ({
		kind: "move",
		previousID,
		anchor: "",
	});

	it("landingId: vanished anchor → undefined (the caller falls back to presence)", () => {
		const walk = [walkBlock("h1", "h", "h1", "A")];
		expect(landingId(walk, mv("ghost"))).toBeUndefined();
	});

	it("landingId append: the container's last child, surviving trailing deep children", () => {
		const walk = [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p2", "p", "", "last top-level"),
			walkBlock("c1", "p", "", "kid", "p2", "p"),
		];
		expect(landingId(walk, { kind: "append", anchor: "" })).toBe("p2");
	});

	it("landingId: append on an empty walk → undefined", () => {
		expect(landingId([], { kind: "append", anchor: "" })).toBeUndefined();
	});
});
