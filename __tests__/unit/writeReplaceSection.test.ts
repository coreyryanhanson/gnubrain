// writeReplaceSection tests — the replace-section mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	contentHash,
} from "siyuan-kb-primitives";
import {
	REPLACE_DOC,
	SECTION_DOC,
	replaceParams,
	setup,
	storedContentStub,
	walkBlock,
} from "./writeHarness.js";

// ---------------------------------------------------------------------------
// replace-section — insert-before-delete, invalidRefs
// ---------------------------------------------------------------------------

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
			truncated: false,
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
		// post-sweep walk, so a success-reported delete that left the block
		// in the tree renders the members-survived refusal with the survivors
		// itemized, never an ok receipt.
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
		expect(result.invalidRefs).toEqual({
			count: 1,
			hpaths: ["/Other doc"],
			truncated: false,
		});
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
