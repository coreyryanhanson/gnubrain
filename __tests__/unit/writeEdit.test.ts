// writeEdit tests — the edit mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub. The edit's judgment is
// walk-vs-walk (the fresh guard's pre-write row against one post-write
// tree walk): every case that reaches the mutation carries a walk
// fixture, and the stub's updateBlock converges the tree row in place.

import { describe, expect, it } from "vitest";
import { SiYuanApiError, contentHash } from "siyuan-kernel-primitives";
import { statementKind } from "siyuan-kernel-primitives/testing";
import {
	setup,
	walkBlock,
	editBase,
	nestChain,
	editDoc,
} from "./writeHarness.js";

// ---------------------------------------------------------------------------
// edit — fresh-content precondition
// ---------------------------------------------------------------------------

describe("edit", () => {
	it("applies via updateBlock and echoes the contract fields", async () => {
		const { execute, calls } = setup({
			config: editDoc("stale paragraph"),
		});
		const result = await execute(editBase);
		expect(result.status).toBe("ok");
		expect(result.docId).toBe("d-doc");
		expect(result.title).toBe("Docker Networking");
		expect(result.hpath).toBe("/Docker Networking");
		expect(result.outline).toBeDefined();
		expect(
			calls.filter((c) => c.method === "updateBlock").map((c) => c.args),
		).toEqual([{ id: "b-1", data: "corrected body" }]);
	});

	it("a target past the walk's depth bound refuses the edit before any mutation — walk-truncated", async () => {
		// The guard's walk cannot see the target: an unconfirmed absence
		// never mutates, and content it could not compare is not a fresh
		// target.
		const { execute, calls, childrenFor } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "deep body" }],
			},
		});
		// The target sits at the end of a chain deeper than the walk's depth
		// bound — the walk truncates before reaching it.
		nestChain(childrenFor, "d-doc", 33);
		childrenFor["n32"] = [walkBlock("b-1", "p", "", "deep body")];
		const result = await execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"the edit target's presence and content cannot be derived",
		);
		expect(result.message).toContain("edit refused before any mutation");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("a served baseline diverging from the walk takes the session-sentence lead — the split keys on the flow's own input", async () => {
		// The session served the block (an older form), the tree moved on:
		// the served verdict's hash comparison is the comparison path, so the
		// lead is the session sentence — the index-divergence sentence would
		// be false here (the index agrees with the walk).
		const harness = setup({
			config: editDoc("stale paragraph", "concurrently rewritten"),
		});
		harness.baselines.remember("b-1", "older form");
		const result = await harness.execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.message).toContain(
			"changed since this session last checked it",
		);
	});

	it("a block id passed as docId reads as no doc — rootEcho's type-'d' discrimination, zero kernel write calls", async () => {
		// b-1 exists as a block row but is not a doc root; the write path
		// refuses it instead of normalizing it to its containing doc.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
			},
		});
		const result = await execute({ ...editBase, docId: "b-1" });
		expect(result.status).toBe("error");
		expect(result.message).toContain("no doc 'b-1'");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("concurrent change → stale_content refusal with current content + fresh outline, zero kernel write calls", async () => {
		// The session never served the block (no row seed — the guard's input
		// mints from session state alone), so the target judges on the seed
		// path: the index still holds the pre-change form while the live tree
		// already holds the kernel-side rewrite — exactly the walk-vs-index
		// divergence the seed path fails closed on. The refusal lead words
		// that truthfully (the session sentence would be false here).
		const { execute, calls } = setup({
			config: {
				...editDoc("stale paragraph", "concurrently rewritten"),
				baselineRows: [{ id: "b-1", content: "stale paragraph" }],
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.message).toContain(
			"the live tree and the blocks index disagree about block 'b-1'",
		);
		expect(result.currentContent).toBe("concurrently rewritten");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("matching re-check proceeds; kernel errors surface verbatim with the fresh outline", async () => {
		const failing = setup({
			config: {
				...editDoc("stale paragraph"),
				onUpdate: () => {
					throw new SiYuanApiError(500, -1, "block [b-1] not found");
				},
			},
		});
		const refused = await failing.execute(editBase);
		expect(refused.status).toBe("error");
		expect(refused.message).toContain("block [b-1] not found");
		expect(refused.outline).toBeDefined();
	});

	it("a missing blockId refuses pre-mutation — absent-target, never a kernel round-trip", async () => {
		// No index row and no walk row: the complete walk cannot see the
		// target, and updateBlock on a walk-invisible row acks a destructive
		// body wipe — the refusal fires before any mutation, naming which
		// of the two reads disagreed (neither sees it) and
		// serving the outline the verdict already paid for.
		const { execute, calls } = setup({ config: {} });
		const orphan = await execute({ ...editBase, blockId: "b-ghost" });
		expect(orphan.status).toBe("refused");
		expect(orphan.message).toContain("absent from a complete walk");
		expect(orphan.message).toContain("nothing was modified");
		expect(orphan.message).toContain("re-target from the outline below");
		expect(orphan.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("a foreign blockId (another doc's block) is refused before any kernel write", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [
					{ id: "b-foreign", content: "other doc", root_id: "d-other" },
				],
			},
		});
		const result = await execute({ ...editBase, blockId: "b-foreign" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("belongs to another doc");
		expect(result.message).toContain("d-other");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("a document id in the blockId slot is refused before any kernel write", async () => {
		const { execute, calls } = setup({
			config: {
				// The doc's own 'd' row: root_id === docId, content is the title.
				blockRows: [
					{ id: "d-doc", content: "Doc Title", root_id: "d-doc", type: "d" },
				],
			},
		});
		const result = await execute({ ...editBase, blockId: "d-doc" });
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is a document id, not a block");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("a tree no-op (ack ok, the walk row never moves) does not read as ok", async () => {
		// The judgment never consults the update ack/echo (a hint, never
		// evidence): even with a well-formed ack over an unmoved tree — empty
		// ops or an ack naming the target — the walk-vs-walk comparison
		// answers still-pre-write. HTTP success + a well-formed ack for the
		// target with the tree keeping the pre-write row is the
		// silent-rollback class the judgment must fail loud on, worded as the
		// tree fact it is.
		const harness = setup({
			config: editDoc("stale paragraph"),
		});
		harness.client.updateBlock = async (p) => {
			harness.calls.push({ method: "updateBlock", args: p });
			return [{ doOperations: [{ id: "b-1" }] }];
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("error");
		expect(result.message).toContain("verified-edit failed");
		expect(result.message).toContain(
			"the live tree still holds the pre-write row",
		);
		expect(result.message).toContain("a normalized resubmit");
		expect(result.message).toContain("do NOT retry blindly");
		expect(result.outline).toBeDefined();
	});

	it.each([
		{
			name: "a concurrent intra-doc move re-parenting the row answers concurrent-move",
			mutate: (childrenFor: Record<string, unknown[]>) => {
				// The walk derives parentId from traversal, so the move must
				// re-home the row in the tree — under a quote container here.
				childrenFor["d-doc"] = [walkBlock("q1", "b", "", "")];
				childrenFor["q1"] = [walkBlock("b-1", "p", "", "stale paragraph")];
			},
			fragment: "the block's parent changed under the edit",
		},
		{
			name: "a concurrent delete or cross-doc move answers concurrent-gone",
			mutate: (childrenFor: Record<string, unknown[]>) => {
				childrenFor["d-doc"] = [];
			},
			fragment: "no longer in 'Docker Networking's live tree",
		},
		{
			name: "a concurrent move past the walk depth bound answers absence-unconfirmed",
			mutate: (childrenFor: Record<string, unknown[]>) => {
				nestChain(childrenFor, "d-doc", 33);
				childrenFor["n32"] = [
					walkBlock("b-1", "p", "", "stale paragraph", "n32"),
				];
			},
			fragment: "the post-write walk could not reach the block's position",
		},
	])(
		"a verify failure arms the envelope — $name",
		async ({ mutate, fragment }) => {
			// The mutation acks, then the tree shifts under the edit before
			// the post-write walk reads it — each concurrency class words its
			// own sentence inside the shared do-not-retry frame.
			const { execute, childrenFor } = setup({
				config: {
					...editDoc("stale paragraph"),
					onUpdate: () => mutate(childrenFor),
				},
			});
			const result = await execute(editBase);
			expect(result.status).toBe("error");
			expect(result.message).toContain("verified-edit failed");
			expect(result.message).toContain(fragment);
			expect(result.message).toContain("do NOT retry blindly");
			expect(result.outline).toBeDefined();
		},
	);

	it("the successful edit baselines its own block from the verdict's carried row", async () => {
		const harness = setup({
			config: editDoc("stale paragraph", "served body"),
		});
		// A prior serve seeds the baseline, so the pre-write fallback (which
		// only fills missing entries) cannot mask the refresh: only the
		// verdict-carried row can move the hash off the original serve. The
		// tree holds the served form so the precondition matches.
		harness.baselines.remember("b-1", "served body");
		let scopingReads = 0;
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-in-doc") {
				scopingReads += 1;
			}
			if (statementKind(stmt) === "block-contents") {
				// No baseline-content refresh rides the edit's success path —
				// the landed verdict carries the row it judged. A broad
				// refresh here would launder a concurrent change into the
				// baseline.
				throw new Error("unexpected blocks.content refresh");
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
		// The walk is the presence authority, so no membership read rides
		// the edit's success path — the diagnosis read only runs on the
		// absent-target refusal. No poll loop, no post-write verification
		// SQL anywhere on the edit path.
		expect(scopingReads).toBe(0);
		// The verdict carried the post-write walk row — a follow-up edit
		// compares against it, not the submitted markdown and not the
		// pre-write serve.
		expect(harness.baselines.servedBaseline("b-1")).toEqual({
			kind: "served",
			hash: contentHash("corrected body"),
		});
	});
});
