// writeDelete tests — the delete mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
} from "siyuan-kernel-primitives";
import {
	expectUnverified,
	nestChain,
	setup,
	walkBlock,
	DELETE_DOC as DOC,
} from "./writeHarness.js";

// ---------------------------------------------------------------------------
// delete — walk-set evidence + the doc-level pinned shape
// ---------------------------------------------------------------------------

describe("delete", () => {
	it("block-level: ok with the receipt from the post-write walk set, invalidRefs echo", async () => {
		const { execute, calls, childrenFor } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				// The kernel applies the delete: p1 vanishes from the tree.
				onDelete: () => {
					childrenFor["d-doc"] = [];
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("ok");
		// Wording pin: the orphaned-refs count is agent-visible (0 here —
		// no refRows configured).
		expect(result.message).toContain("0 doc(s) with orphaned refs");
		expect(result.invalidRefs).toEqual({
			count: 0,
			hpaths: [],
			truncated: false,
		});
		// The receipt rides the judged arm's content (the primitive's
		// membership read): blockId + content verbatim.
		expect(result.deletedBlocks).toEqual([
			{ blockId: "p1", content: "doomed" },
		]);
		expect(
			calls.filter((c) => c.method === "deleteBlock").map((c) => c.args),
		).toEqual(["p1"]);
		// A plain block is not a heading — the heading-delete report stays out of a
		// block-level receipt (the suppression pin rides the ok case).
		expect(result.message).not.toContain("left in place");
		expect(result.orphanedMembers).toBeUndefined();
		// Walk-count pin: the fresh-content judgment rides the primitive's own
		// stake walk — stake walk + post-delete verification walk, no third.
		expect(
			calls.filter((c) => c.method === "getChildBlocks").map((c) => c.args),
		).toEqual(["d-doc", "d-doc"]);
	});

	it("concurrent change → stale_content refusal before any kernel write", async () => {
		// The blocks index still holds the pre-change row while the live tree
		// already holds the kernel-side rewrite — the index-lag case the
		// precondition exists to catch. No session baseline exists, so the
		// judgment's seed path fails closed: a diverging row reads as stale,
		// never silently matched.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				// The judgment's seed read (block-contents) — the SQL-now row the
				// session holds no baseline for.
				baselineRows: [{ id: "p1", content: "doomed" }],
				childrenFor: {
					"d-doc": [walkBlock("p1", "p", "", "concurrently rewritten")],
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("concurrently rewritten");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("the still-present arm: a success-reported delete that left the block in the tree is an error, never an ok receipt", async () => {
		// childrenFor keeps the block post-delete: the kernel "deleted"
		// nothing behind HTTP success — the still-present arm of the delete
		// judgment. The synchronous-error case is below.
		const { execute } = setup({
			config: {
				blockRows: [{ id: "p1", content: "survivor" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "survivor")] },
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("silent no-op");
		expect(result.message).toContain("still present");
		// A failed delete deleted nothing — no receipt, no orphan-ref echo,
		// but the fresh outline for re-targeting rides.
		expect(result.deletedBlocks).toBeUndefined();
		expect(result.invalidRefs).toBeUndefined();
		expect(result.outline).toBeDefined();
	});

	it("a synchronous kernel rejection with a simultaneous echo failure: the kernel's error still surfaces verbatim, not 'unreachable'", async () => {
		// The outline re-read rides the walk route; arm it to drop at the same
		// moment the kernel answers the delete with a synchronous error. The
		// verdict is the kernel's error — the echo is garnish — and an
		// unwrapped echo throw would make runKbCall reclassify this call as
		// "SiYuan unreachable" even though the kernel answered.
		let arm: ((err: Error) => void) | undefined;
		const { execute } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => {
					arm?.(new SiYuanNetworkError());
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.message).not.toContain("unreachable");
	});

	it("a foreign blockId (another doc's block) is refused before any kernel delete", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [
					{ id: "p-other", content: "other doc", root_id: "d-other" },
				],
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p-other",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("belongs to another doc");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("an absent target: the kernel's synchronous rejection surfaces verbatim with the fresh outline", async () => {
		// blockRows [] — the membership read sees no row, the flow proceeds,
		// and the pinned kernel refuses the delete of an absent block
		// synchronously ("tree not found") instead of no-oping behind success.
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [] },
				onDelete: () => {
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a kernel rejection mid-verification (SiYuanApiError) → verificationFailed, never a false ok", async () => {
		// The client throws SiYuanApiError for unknown/locked ids on
		// getChildBlocks; a strict walk must not let that read as "target
		// gone" behind a successful HTTP delete.
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => arm?.(new SiYuanApiError(500, -1, "block locked")),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expectUnverified(result);
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a verification-phase 429 keeps the may-already-be-applied fact the rethrow erased", async () => {
		// The mutation acked, the post-delete walk hit the per-IP lock: the
		// verdict must word the lock (every authed call re-arms it), keep the
		// applied fact, and carry the authEvent marker runKbCall's breaker
		// accounting consumes.
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armWalkError: (set) => {
					arm = set;
				},
				onDelete: () => arm?.(new SiYuanRateLimitError(429, 90)),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("may already be applied");
		expect(result.message).toContain("re-arms the");
		expect(result.authEvent).toEqual({
			kind: "rate-limit",
			retryAfterSeconds: 90,
		});
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("a transport drop mid-delete reads as outcome-unverified with the outline attached, never a blind-retry invitation", async () => {
		// The delete may already be applied when the transport fails — the
		// primitive's transport-unverified arm, not runKbCall's retry
		// invitation. The error-path echo reads run best-effort.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "p1", content: "doomed" }],
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "doomed")] },
				armDeleteError: (arm) => arm(new SiYuanNetworkError()),
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("transport layer");
		// The verdict is the transport-unverified envelope, not runKbCall's
		// "SiYuan unreachable" shape (the stub's own network-error text
		// legitimately rides the detail interpolation).
		expect(result.blockId).toBe("p1");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(1);
	});

	it("doc-level: a synchronous kernel rejection surfaces verbatim with the fresh outline", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [walkBlock("h1", "h", "h1", "Heading")] },
				onRemoveDoc: () => {
					throw new SiYuanApiError(-1, -1, "tree not found");
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
		expect(result.outline).toContain("Heading");
		expect(
			calls.filter((c) => c.method === "removeDocByID").map((c) => c.args),
		).toEqual(["d-doc"]);
	});

	it("doc-level: removeDocByID fires and the result carries invalidRefs plus the delete receipt (pinned shape)", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: { "d-doc": [walkBlock("p1", "p", "", "body")] },
				refRows: [{ root_id: "d-other" }],
				hpathRows: [{ hpath: "/Other doc" }],
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		expect(
			calls.filter((c) => c.method === "removeDocByID").map((c) => c.args),
		).toEqual(["d-doc"]);
		expect(Object.keys(result).sort()).toEqual([
			"deletedBlocks",
			"invalidRefs",
			"kb",
			"message",
			"status",
		]);
		expect(result.invalidRefs).toEqual({
			count: 1,
			hpaths: ["/Other doc"],
			truncated: false,
		});
		// The receipt rides the pre-delete walk set — the doc is gone.
		expect(result.deletedBlocks).toEqual([{ blockId: "p1", content: "body" }]);
	});

	it("a delete receipt over the preview budget spills: the pointer rides, the inline field goes", async () => {
		const { execute } = setup({
			config: {
				childrenFor: {
					"d-doc": [walkBlock("p1", "p", "", "x".repeat(9000))],
				},
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		expect(result.deletedBlocks).toBeUndefined();
		expect(result.deletedBlocksPreview).toContain('"blockId":"p1"');
		expect(result.deletedBlocksPath).toMatch(
			/kb_write-deleted-blocks-[0-9a-f]{16}\.jsonl$/,
		);
	});
});

// ---------------------------------------------------------------------------
// The heading-delete report — the heading-only delete's orphan judgment
// ---------------------------------------------------------------------------

describe("delete — the heading-delete report", () => {
	// The section-bearing doc the report reads (the kernel's heading delete
	// removes only the heading — members are tree siblings that survive;
	// pinned here so doc and mode cannot drift): the section rule is
	// document-order, so h2/p2 are tree siblings that belong to h1's
	// section.

	it("a section-bearing heading's ok receipt reports the members left in place, ids included", async () => {
		// cascadeDelete: the kernel's heading delete is fold-blind — it
		// removes ONLY the heading (its tree descendants; members are tree
		// siblings), so p1/h2/p2 survive in the post-write walk.
		const { execute } = setup({
			config: {
				blockRows: [{ id: "h1", content: "Goals" }],
				childrenFor: DOC,
				cascadeDelete: true,
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "h1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).toContain(
			"3 body block(s) left in place; they no longer belong to this heading: p1, h2, p2",
		);
		expect(result.orphanedMembers).toEqual(["p1", "h2", "p2"]);
	});

	it("a section-less heading (present, empty member set) suppresses the report", async () => {
		// h1 is followed immediately by a same-level heading: a present
		// heading whose member set is empty — the ids arm's silent return.
		// (That the empty set is ids: [] and not a refusal arm is the
		// projection's own fact, pinned in the primitives.)
		const { execute } = setup({
			config: {
				blockRows: [{ id: "h1", content: "Goals" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "Goals"),
						walkBlock("h2", "h", "h1", "Next"),
					],
				},
				cascadeDelete: true,
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "h1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).not.toContain("left in place");
		expect(result.orphanedMembers).toBeUndefined();
	});

	it("a plain block's ok receipt carries no report and no degrade — nothing to report", async () => {
		// A paragraph orphan nothing: the projection's not-a-heading arm
		// suppresses silently — the degraded line (which mentions section
		// members) would be a false alarm on a non-heading delete.
		const { execute } = setup({
			config: {
				blockRows: [{ id: "p1", content: "Body" }],
				childrenFor: {
					"d-doc": [walkBlock("p1", "p", "", "Body")],
				},
				cascadeDelete: true,
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "p1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).not.toContain("left in place");
		expect(result.message).not.toContain("may go unreported");
		expect(result.orphanedMembers).toBeUndefined();
	});

	it("an incomplete stake walk refuses the delete before any mutation — walk-truncated", async () => {
		// The section nests past the walk depth bound, so the guard's stake
		// walk cannot enumerate the cascade stake from complete evidence —
		// the delete refuses pre-mutation (the guard's own truncation arm).
		const { execute, calls, childrenFor } = setup({
			config: {
				blockRows: [{ id: "h1", content: "Goals" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "Goals"),
						walkBlock("c9", "", "", "container"),
					],
					c9: [],
				},
				onDelete: () => {
					throw new Error("the delete must never fire on a truncated stake");
				},
			},
		});
		// A chain of nested unnamed containers under c9 (built after setup,
		// before the call): the stake walk recurses into it and truncates.
		nestChain(childrenFor, "c9", 33);
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "h1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"cascade stake cannot be derived from complete evidence",
		);
		expect(result.message).toContain("delete refused before any mutation");
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});

	it("a never-served cascade descendant with a diverging seed row refuses the delete — the index-divergence lead", async () => {
		// The guard's derived stake: the container target's descendants
		// judge through the session lookup, so a descendant the session
		// never served but the index still holds refuses fail-closed — the
		// walk-vs-index divergence, worded as the index disagreement it
		// is. The baseline-compared descendant arm renders the session
		// sentence and is pinned through the edit flow (writeEdit.test).
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "c1", content: "container", root_id: "d-doc" }],
				childrenFor: {
					"d-doc": [walkBlock("c1", "b", "", "container")],
					c1: [walkBlock("p1", "p", "", "tree form")],
				},
				// The seed row the session never served — its divergence from
				// the walk content is what the fail-closed seed path reads.
				baselineRows: [{ id: "p1", content: "index form" }],
			},
		});
		const result = await execute({
			kb: "recipes",
			mode: "delete",
			docId: "d-doc",
			blockId: "c1",
		});
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.message).toContain(
			"the live tree and the blocks index disagree about block 'p1'",
		);
		expect(result.blockId).toBe("p1");
		expect(result.currentContent).toBe("tree form");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
	});
});
