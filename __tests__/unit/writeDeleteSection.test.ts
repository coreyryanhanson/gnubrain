// writeDeleteSection tests — the delete-section mode — executed through
// the registered kb_write definition on a fake-pi harness with a
// SQL-routed kernel stub. The kernel-coupled facts the batched sequence
// rests on (commit-wait at ack, the sub-cliff silent no-op, the ≥32
// bulk path's fail-closed rollback, the rollback residue's repair-first
// recovery, the batch's op derivation) are falsified down-repo (the
// primitives' suites and the layer-1 probe suite); these cases pin the
// tool surface: the arm→payload mapping, the guard's real mechanisms,
// and the walk-partition wording per arm.

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
	it("ok: the receipt itemizes the whole removal in the verdict's judged order — heading first, then the closure in document order — one batch, never a member's descendant", async () => {
		// Every fresh target rides `unseen` adoption (no session baseline,
		// no SQL rows) — this case doubles as the out-of-window member-edit
		// pin: adoption proceeds, never a refusal.
		const { execute } = setup({
			config: { childrenFor: DOC },
		});
		const result = await execute(params);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("delete set 4 block(s)");
		expect(result.message).toContain("0 doc(s) with orphaned refs");
		expect(result.headingId).toBe("h1");
		expect(result.deletedBlocks).toEqual([
			{ blockId: "h1", content: "Goals" },
			{ blockId: "p1", content: "body one" },
			{ blockId: "h2", content: "Details" },
			{ blockId: "p2", content: "nested body" },
		]);
		// The echo tail reflects the post-delete tree (h3 survives).
		expect(result.outline).toBeDefined();
	});

	it("ok: a member that is itself a container reports the descendants its cascade took — the batch issues only the enumerated members", async () => {
		// The delete set is the section's closure (members plus their
		// subtrees) plus the heading, while the batch issues only members +
		// the heading — the kernel's cascade takes the container's
		// descendants with it. DELETE_DOC holds only siblings, so this is
		// the one case where the receipt and the issued ids differ.
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
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("ok");
		expect(result.message).toContain("delete set 6 block(s)");
		expect(result.deletedBlocks).toEqual([
			{ blockId: "h1", content: "Goals" },
			{ blockId: "p1", content: "body one" },
			{ blockId: "c9", content: "container" },
			{ blockId: "p9", content: "inside container" },
			{ blockId: "h2", content: "Details" },
			{ blockId: "p2", content: "nested body" },
		]);
		// The receipt covers the cascade closure — p9 rides it without being
		// issued (the cascade takes it with its container).
		expect(childrenFor["c9"]).toBeUndefined();
	});

	it("a kernel rejection on the batch call flows to the mutation ladder — verbatim message, no receipt (the stub applied nothing; a committed batch can refuse after the commit)", async () => {
		const { execute, calls, childrenFor } = setup({
			config: {
				childrenFor: DOC,
				transactError: new SiYuanApiError(-1, -1, "tree not found"),
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		// The batched-route residual, worded on this flow only: refused-by-
		// HTTP is not proof of non-application — the note rides beside the
		// verbatim rejection. (Here the stub refused pre-commit; the note is
		// the route's wording, not this run's observation.)
		expect(result.message).toContain("may have committed");
		// No receipt: the batch is one call — nothing is known to have
		// landed, and the tree stub confirms nothing was.
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(1);
		expect(childrenFor["d-doc"]).toHaveLength(5);
	});

	it("a transport drop on the batch call flows to the ladder: outcome-unverified, the whole judged set rides unconfirmedBlockIds", async () => {
		// No ack: the commit-wait guarantee does not apply — the batch may
		// still be committing or already committed, so the WHOLE judged set
		// (not a not-yet-attempted remainder) is what may be gone.
		const { execute } = setup({
			config: {
				childrenFor: DOC,
				transactError: new SiYuanNetworkError(),
			},
		});
		const result = await execute(params);
		expectUnverified(result);
		expect(result.message).not.toContain("partially applied");
		expect(result.partialApply).toBeUndefined();
		expect(result.unconfirmedBlockIds).toEqual(["h1", "p1", "h2", "p2"]);
	});

	it("walk-failed: the batch landed but the post-write walk failed — appliedUnverified, never 'partially applied'", async () => {
		// The batch commits (the stub prunes), then the post-write walk
		// throws — armed from the onTransact hook, the only callback that
		// runs between the ack and the walk.
		let arm: ((err: Error) => void) | undefined;
		const { execute } = setup({
			config: {
				childrenFor: DOC,
				armWalkError: (set) => {
					arm = set;
				},
				onTransact: () => {
					arm?.(new SiYuanNetworkError());
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
		// The whole judged set is what may be gone — and here it IS gone
		// (the batch landed); the merged state keeps the empty pending set
		// (the classifier's "nothing remains to apply" tail).
		expect(result.unconfirmedBlockIds).toHaveLength(4);
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.remainingBlockIds).toEqual([]);
	});

	it("nothing-deleted: a rolled-back batch acks success with every section block still present — cause-free wording, repair-first guidance", async () => {
		// Every op silently no-ops (the rollback shape: the walk certifies
		// the "nothing" claim the ack cannot). The kernel reports no batch
		// failure reason over HTTP — the wording must not pretend otherwise.
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				transactPrune: () => false,
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("nothing was deleted");
		expect(result.message).toContain("no reason over HTTP");
		expect(result.message).toContain("re-issue this whole-section delete ONCE");
		expect(result.message).toContain("by id");
		// The primitive's judged order — heading first, then the closure.
		expect(result.judgedBlockIds).toEqual(["h1", "p1", "h2", "p2"]);
		expect(result.partialApply).toBeUndefined();
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(1);
	});

	it("nothing-deleted on a truncated post-walk: presence past the depth bound is not claimed as seen", async () => {
		// The all-or-nothing arm on an INCOMPLETE walk: every issued id is
		// present (the rollback shape), but the walk never reached the deep
		// closure — the sentence must carry the truncation caveat instead of
		// claiming the walk certified the whole judged set's presence.
		const { execute, childrenFor } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [...DOC["d-doc"]!, walkBlock("c9", "", "", "container")],
					c9: [],
				},
				transactPrune: () => false,
				onTransact: () => {
					// Grow the tree past the walk bound after the enumeration:
					// the pre-batch walk was complete, the post-write one is not.
					nestChain(childrenFor, "c9", 33);
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("nothing was deleted");
		expect(result.message).toContain("depth-truncated");
		expect(result.message).toContain("reconcile from the outline");
		expect(result.judgedBlockIds).toEqual(["h1", "p1", "h2", "p2"]);
		expect(result.partialApply).toBeUndefined();
		expect(result.outline).toBeDefined();
	});

	it("members-survived: a sub-cliff silent no-op leaves part of the section in the tree — the survivor arm, never an ok receipt", async () => {
		// p1 prunes (the kernel applied it); h2/p2/h1 silently no-op — the
		// stale-id shape below the ≥32 cliff: acked behind HTTP success.
		const { execute, calls } = setup({
			config: {
				childrenFor: DOC,
				transactPrune: (id) => id === "p1",
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("silent no-op");
		expect(result.message).toContain("still present");
		expect(result.message).toContain("re-issue this whole-section delete ONCE");
		expect(result.survivedIds).toEqual(["h2", "p2", "h1"]);
		expect(result.deletedBlockIds).toEqual(["p1"]);
		// No pending set: the survivors are acked-but-present ids, not a
		// not-yet-applied remainder.
		expect(result.remainingBlockIds).toBeUndefined();
		expect(result.partialApply).toBeUndefined();
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(1);
	});

	it("members-survived with the heading gone: the survivors are orphans — the recovery clause switches to the by-id cleanup", async () => {
		// The sub-cliff dead end: the heading's op committed while the
		// members' ops silently no-opped (stale member ids below the ≥32
		// cliff, members first / heading last). A whole-section re-issue
		// would refuse heading-absent, so the guidance must switch: after
		// the repair write the survivors are an ordinary by-id cleanup.
		const { execute } = setup({
			config: {
				childrenFor: DOC,
				transactPrune: (id) => id === "h1",
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.survivedIds).toEqual(["p1", "h2", "p2"]);
		expect(result.message).toContain("still present");
		expect(result.message).toContain("heading is gone");
		expect(result.message).toContain("delete the surviving block(s) by id");
		// The whole-section re-issue instruction is gone from this branch.
		expect(result.message).not.toContain(
			"re-issue this whole-section delete ONCE",
		);
	});

	it("members-survived: a surviving container's tree descendants are never misreported as deleted", async () => {
		// A member that is itself a container (c9, with p9 inside it) — the
		// survivors cover only the judged ids (members + heading), so the
		// absent half derives from the certified post-walk over that same
		// judged set: p9 is cascade-covered, never judged, never deleted.
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
				transactPrune: (id) => id === "p1",
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.deletedBlockIds).toEqual(["p1"]);
		expect(result.survivedIds).toEqual(["c9", "h2", "p2", "h1"]);
	});

	it("members-survived on a truncated post-walk: absence past the depth bound is unconfirmed, never claimed as deleted", async () => {
		// The post-write walk can come back INCOMPLETE with survivors (the
		// partition's own precedence: presence stays sound, absence does
		// not). A surviving member's descendants past the depth bound are
		// absent from that walk without being deleted — absence there must
		// not be published as deletedBlockIds.
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
				transactPrune: (id) => id === "p1",
				onTransact: () => {
					// Grow the depth run under c9 past the walk bound and hang
					// p9 past its end: the pre-batch walk (taken before the
					// transaction) enumerated p9 at depth 2, but the post-write
					// walk truncates before reaching it.
					nestChain(childrenFor, "c9", 33);
					childrenFor["n32"] = [walkBlock("p9", "p", "", "inside container")];
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("silent no-op");
		expect(result.message).toContain("depth-truncated");
		// The projection's conservatism on a truncated walk: EVERY absence
		// is unconfirmed — p1 (which the batch did remove) rides next to p9
		// (which it never touched, past the bound). The receipt claims no
		// deletion it cannot show.
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p9"]);
		expect(result.survivedIds).toEqual(["c9", "h2", "p2", "h1"]);
	});

	it("post-walk-truncated: the batch landed but the post-write walk hit the depth bound — applied but unverified", async () => {
		// The batch commits (the doc gets shallower), then the tree regrows
		// past the bound under a surviving sibling container, so the
		// post-write walk truncates while the enumeration did not.
		const { execute, childrenFor } = setup({
			config: {
				childrenFor: {
					...DOC,
					"d-doc": [...DOC["d-doc"]!, walkBlock("c9", "", "", "container")],
					c9: [],
				},
				onTransact: () => {
					nestChain(childrenFor, "c9", 33);
				},
			},
		});
		const result = await execute(params);
		expect(result.status).toBe("error");
		expect(result.message).toContain("applied but unverified");
		expect(result.message).toContain("depth bound");
		expect(result.appliedUnverified).toBe(true);
		// The primitive's judged order — heading first, then the closure.
		expect(result.unconfirmedBlockIds).toEqual(["h1", "p1", "h2", "p2"]);
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
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
	});

	it("a headingId that names no heading of the walk refuses before any kernel write", async () => {
		const { execute, calls } = setup({
			config: { childrenFor: DOC },
		});
		const result = await execute({ ...params, headingId: "h9" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is not a heading of doc");
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
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
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
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
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
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
		// The session-held baselines are consulted alongside the index-lag
		// rows; both divergences refuse. (The staleTargets ORDER is the
		// primitives' judged order — pinned down-repo.)
		expect(result.staleTargets).toContainEqual({
			blockId: "h1",
			currentContent: "Goals",
		});
		expect(result.staleTargets).toContainEqual({
			blockId: "p1",
			currentContent: "body one",
		});
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
	});

	it("walk-count pin: the fresh-content judgment rides the enumeration walk (2 walks, not 3)", async () => {
		// The internal guard's falsifier at flow level: enumeration walk +
		// batch post-write walk — the judgment rides the caller-held walk
		// and takes no walk of its own. A regression that re-walks inside
		// the guard adds a third 'd-doc' call here.
		const { execute, calls } = setup({
			config: { childrenFor: DOC },
		});
		const result = await execute(params);
		expect(result.status).toBe("ok");
		expect(
			calls.filter((c) => c.method === "getChildBlocks").map((c) => c.args),
		).toEqual(["d-doc", "d-doc"]);
	});
});
