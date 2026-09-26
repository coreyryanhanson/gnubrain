// The heading-target refusal over fixture trees — the tool-side consumers
// of the walk. The outline notation itself and the section rule
// (membership/boundary/closure + anchors) are falsified by the primitives
// repo's own corpus.

import { describe, expect, it } from "vitest";
import { headingInWalk, type DocTarget } from "../../writeFlow.js";
import type { WalkedBlock } from "siyuan-kb-primitives";

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
