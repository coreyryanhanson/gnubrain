// writeDeleteSection tests — the delete-section mode — executed through
// the registered kb_write definition on a fake-pi harness with a
// SQL-routed kernel stub. The kernel-coupled facts the sequence rests on
// (fold-blind heading delete, cascade scoping, the first-mutation phase
// rule's arms) are falsified down-repo; these cases pin the tool surface:
// the delete-set order the receipt rests on, the guard's real mechanisms,
// and the partial-apply wording per arm.

import { describe, expect, it } from "vitest";
import { SiYuanApiError, SiYuanNetworkError } from "siyuan-kb-primitives";
import {
	DELETE_DOC as DOC,
	expectUnverified,
	nestChain,
	setup,
	walkBlock,
} from "./writeHarness.js";

const params = {
	kb: "recipes",
	mode: "delete-section",
	docId: "d-doc",
	headingId: "h1",
};

describe("delete-section", () => {
	it("ok: members first in document order, the heading last, never a member's descendant — the receipt itemizes the whole removal", async () => {
		// Every fresh target rides `unseen` adoption (no session baseline,
		// no SQL rows) — this case doubles as the out-of-window member-edit
		// pin: adoption proceeds, never a refusal.
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				cascadeDelete: true,
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("ok");
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1", "h2", "p2", "h1"]);
		expect(result.message).toContain("delete set 4 block(s)");
		expect(result.message).toContain("0 doc(s) with orphaned refs");
		expect(result.headingId).toBe("h1");
		expect(result.deletedBlocks).toEqual([
			{ blockId: "p1", content: "body one" },
			{ blockId: "h2", content: "Details" },
			{ blockId: "p2", content: "nested body" },
			{ blockId: "h1", content: "Goals" },
		]);
		// The echo tail reflects the post-delete tree (h3 survives).
		expect(result.outline).toBeDefined();
	});

	it("ok: a member that is itself a container reports the descendants its cascade took — the receipt itemizes the whole removal", async () => {
		// The delete set is the section's closure (members plus their
		// subtrees) plus the heading, while the sweep issues only members +
		// the heading — the kernel's cascade takes the container's
		// descendants with it. DELETE_DOC holds only siblings, so this is
		// the one case where the receipt and the issued ids differ.
		const { execute, calls } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [
						...DOC["d-doc"]!.slice(0, 2), // h1, p1
						walkBlock("c9", "", "", "container"),
						...DOC["d-doc"]!.slice(2),
					],
					c9: [walkBlock("p9", "p", "", "inside container")],
				},
				cascadeDelete: true,
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("delete set 6 block(s)");
		expect(result.deletedBlocks).toEqual([
			{ blockId: "p1", content: "body one" },
			{ blockId: "c9", content: "container" },
			{ blockId: "p9", content: "inside container" },
			{ blockId: "h2", content: "Details" },
			{ blockId: "p2", content: "nested body" },
			{ blockId: "h1", content: "Goals" },
		]);
		// The sweep issues exactly members + the heading — never the
		// descendant the cascade removes with its container.
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1", "c9", "h2", "p2", "h1"]);
	});

	it("a kernel rejection at index 0 flows to the mutation ladder, never the partial arm", async () => {
		// The first-mutation phase rule: nothing IS KNOWN to have landed, so
		// "partially applied" would mis-word an unapplied write.
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				onDelete: () => {
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		// Unique to this arm: no receipt, and exactly one delete — no retry,
		// no swallow. The not-partial asserts are the transport-drop case's.
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a transport drop at index 0 flows to the ladder: outcome-unverified, never partial", async () => {
		const { execute } = setup({
			config: {
				childrenFor: DOC,
				armDeleteError: (arm) => arm(new SiYuanNetworkError()),
			},
		});
		const result = await execute(params);
		expectUnverified(result);
		expect(result.message).not.toContain("partially applied");
		expect(result.partialApply).toBeUndefined();
	});

	it("a kernel rejection mid-sweep renders the partial receipt with the already-gone-member caveat", async () => {
		let deletes = 0;
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				cascadeDelete: true,
				onDelete: () => {
					deletes += 1;
					if (deletes === 2) {
						throw new SiYuanApiError(-1, -1, "tree not found");
					}
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("delete-section partially applied");
		expect(result.message).toContain(
			"the deletes of 1 earlier block(s) acked unverified",
		);
		expect(result.message).toContain("may already have been removed");
		expect(result.partialApply).toBe(true);
		expect(result.unconfirmedBlockIds).toEqual(["p1"]);
		expect(result.remainingBlockIds).toEqual(["h2", "p2", "h1"]);
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1", "h2"]);
	});

	it("walk-failed: every delete landed but the verification walk failed — appliedUnverified, never 'partially applied'", async () => {
		let deletes = 0;
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				cascadeDelete: true,
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => {
					deletes += 1;
					if (deletes === 4) arm?.(new SiYuanNetworkError());
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.appliedUnverified).toBe(true);
		expect(result.partialApply).toBeUndefined();
		expect(result.message).toContain("applied but unverified");
		expect(result.message).not.toContain("partially applied");
		expect(result.unconfirmedBlockIds).toHaveLength(4);
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.remainingBlockIds).toEqual([]);
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1", "h2", "p2", "h1"]);
	});

	it("members-survived: a success-reported sweep that left the section in the tree is an error, never an ok receipt", async () => {
		// cascadeDelete off: every deleteBlock acks but applies nothing —
		// the success no-op the judgment refuses on.
		const { execute, calls } = setup({
			config: { childrenFor: DOC },
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("silent no-op");
		expect(result.message).toContain("still present");
		expect(result.partialApply).toBe(true);
		expect(result.remainingBlockIds).toEqual(["p1", "h2", "p2", "h1"]);
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(4);
	});

	it("members-survived: a surviving member's tree descendants stay in the remaining set, never misreported as deleted", async () => {
		// A member that is itself a container (c9, with p9 inside it) — the
		// core's survivedIds covers only the issued ids (members + heading),
		// so the partition derives from the certified post-walk instead.
		const { execute } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [
						...DOC["d-doc"]!.slice(0, 2), // h1, p1
						walkBlock("c9", "", "", "container"),
						...DOC["d-doc"]!.slice(2),
					],
					c9: [walkBlock("p9", "p", "", "inside container")],
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.deletedBlockIds).toEqual([]);
		expect(result.remainingBlockIds).toEqual([
			"p1",
			"c9",
			"p9",
			"h2",
			"p2",
			"h1",
		]);
	});

	it("members-survived on a truncated post-walk: absence past the depth bound is unconfirmed, never claimed as deleted", async () => {
		// The post-sweep walk can come back INCOMPLETE with survivors (the
		// core's own precedence: presence stays sound, absence does not).
		// A surviving member's descendants past the depth bound are absent
		// from that walk without being deleted — absence there must not be
		// published as deletedBlockIds.
		const { execute, childrenFor } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [
						...DOC["d-doc"]!.slice(0, 2), // h1, p1
						walkBlock("c9", "", "", "container"),
						...DOC["d-doc"]!.slice(2),
					],
					c9: [walkBlock("p9", "p", "", "inside container")],
				},
				onDelete: () => {
					// Grow the depth run under c9 past the walk bound and hang
					// p9 past its end: the pre-write walk (taken before any
					// delete) enumerated p9 at depth 2, but the post-sweep walk
					// truncates before reaching it.
					nestChain(childrenFor, "c9", 33);
					childrenFor["n32"] = [walkBlock("p9", "p", "", "inside container")];
				},
			},
		});
		// cascadeDelete off: every delete acks and applies nothing — all
		// members survive, so the members-survived arm renders over a
		// truncated post-walk.
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("silent no-op");
		expect(result.message).toContain("depth-truncated");
		// p9 is unconfirmed, not deleted — and not claimed present either.
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.unconfirmedBlockIds).toEqual(["p9"]);
		expect(result.remainingBlockIds).toEqual(["p1", "c9", "h2", "p2", "h1"]);
	});

	it("sweep-truncated: the post-sweep walk hit the depth bound — applied but unverified", async () => {
		// The section deletes land (the doc gets shallower), then the tree
		// regrows past the bound under a surviving sibling container, so the
		// post-sweep walk truncates while the enumeration did not.
		const { execute, childrenFor } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [...DOC["d-doc"]!, walkBlock("c9", "", "", "container")],
					c9: [],
				},
				cascadeDelete: true,
				onDelete: () => {
					nestChain(childrenFor, "c9", 33);
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("applied but unverified");
		expect(result.message).toContain("depth bound");
		expect(result.appliedUnverified).toBe(true);
		expect(result.unconfirmedBlockIds).toEqual(["p1", "h2", "p2", "h1"]);
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.remainingBlockIds).toBeUndefined();
	});

	it("a truncated enumeration walk refuses before any kernel write", async () => {
		// The chain hangs under a type-"" container that is itself a section
		// member (a `p` block never nests), so the pre-write walk truncates:
		// the delete-set bound cannot derive from incomplete evidence.
		const { execute, calls, childrenFor } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [
						...DOC["d-doc"]!.slice(0, 2), // h1, p1
						walkBlock("c9", "", "", "container"),
						...DOC["d-doc"]!.slice(2),
					],
					c9: [],
				},
			},
		});
		nestChain(childrenFor, "c9", 33);
		const result = await execute(params);
		expect(result.status).toBe("refused");
		expect(result.message).toContain("delete-section refused");
		expect(result.message).toContain("depth bound");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("a headingId that names no heading of the walk refuses before any kernel write", async () => {
		const { execute, calls } = setup({
			config: { childrenFor: DOC },
		});
		const result = await execute({ ...params, headingId: "h9" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is not a heading of doc");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("a headingId belonging to another doc reads as heading-absent — the tool surface cannot produce the foreign arm", async () => {
		// The walk's root always equals the resolved docId (walkBlockTree
		// is called with docId), so the primitive's walk-rootId check never
		// fires through this tool — a cross-doc heading id is just absent
		// from the walk. The foreign arm itself is falsified down-repo
		// (deleteSection unit suite + the live foreign pin).
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				blockRows: [{ id: "h-other", content: "Goals", root_id: "d-other" }],
			},
		});
		const result = await execute({ ...params, headingId: "h-other" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is not a heading of doc");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("a member's index-lag divergence refuses stale_content before any kernel write", async () => {
		// The blocks index still holds the pre-change row while the live tree
		// already holds the rewrite — the divergence-window case the guard
		// catches on members.
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				baselineRows: [{ id: "p1", content: "body one (old row)" }],
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.staleTargets).toEqual([
			{ blockId: "p1", currentContent: "body one" },
		]);
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("an explicitly seeded member and heading baseline both refuse on divergence; staleTargets order is heading-first", async () => {
		const { execute, baselines, calls } = setup({
			config: { childrenFor: DOC },
		});
		baselines.remember("p1", "body one (seen earlier)");
		baselines.remember("h1", "Goals (seen earlier)");
		const result = await execute(params);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.staleTargets).toEqual([
			{ blockId: "h1", currentContent: "Goals" },
			{ blockId: "p1", currentContent: "body one" },
		]);
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});
});
