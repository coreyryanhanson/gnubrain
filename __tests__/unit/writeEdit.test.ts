// writeEdit tests — the edit mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import { SiYuanApiError, contentHash } from "siyuan-kb-primitives";
import { statementKind, withVerifyWindow } from "siyuan-kb-primitives/testing";
import { setup, walkBlock, editBase } from "./writeHarness.js";

// ---------------------------------------------------------------------------
// edit — fresh-content precondition
// ---------------------------------------------------------------------------

describe("edit", () => {
	it("applies via updateBlock and echoes the contract fields", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
			},
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
		// The dialog served "stale paragraph" (the blocks index, baseline
		// seeded from it at check time); the live tree already holds the
		// kernel-side rewrite — exactly the index-lag case the tree-riding
		// precondition exists to catch.
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				childrenFor: {
					"d-doc": [walkBlock("b-1", "p", "", "concurrently rewritten")],
				},
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("concurrently rewritten");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(0);
	});

	it("matching re-check proceeds; kernel errors surface verbatim with the fresh outline", async () => {
		const failing = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
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

	it("a missing blockId reaches the kernel — its synchronous not-found error surfaces verbatim", async () => {
		const { execute, calls } = setup({
			config: {
				// blockRows route returns [] — the target is already gone.
				onUpdate: () => {
					throw new SiYuanApiError(500, -1, "block [b-ghost] not found");
				},
			},
		});
		const orphan = await execute({ ...editBase, blockId: "b-ghost" });
		expect(orphan.status).toBe("error");
		expect(orphan.message).toContain("block [b-ghost] not found");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
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

	it("verified-edit: an update tx without the target's op fails loud, not ok", async () => {
		const { execute } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				updateTx: [{ doOperations: [] }],
			},
		});
		const result = await execute(editBase);
		expect(result.status).toBe("error");
		expect(result.message).toContain("verified-edit failed");
		expect(result.message).toContain("no update operation");
		expect(result.outline).toBeDefined();
	});

	it("verified-edit: a silent kernel no-op (ack ok, index never converges) does not read as ok", () =>
		// Collapse the convergence window: the index never serves the
		// submitted body, so the first retry exhausts the table instantly.
		// The swap rides the primitives' `withVerifyWindow` seam — restore
		// is structural, so no try/finally and no in-place mutation of a
		// production table.
		withVerifyWindow([0], async () => {
			const harness = setup({
				config: {
					blockRows: [{ id: "b-1", content: "stale paragraph" }],
				},
			});
			// HTTP success + a well-formed ack for the target — the exact
			// silent-rollback class the insert paths guard against.
			harness.client.updateBlock = async (p) => {
				harness.calls.push({ method: "updateBlock", args: p });
				return [{ doOperations: [{ id: "b-1" }] }];
			};
			const result = await harness.execute(editBase);
			expect(result.status).toBe("error");
			expect(result.message).toContain("verified-edit failed");
			expect(result.message).toContain("never moved off the pre-write content");
			expect(result.message).toContain("do NOT retry blindly");
			expect(result.outline).toBeDefined();
		}));

	it("verified-edit tolerates the async index: a stale first read retries inside the window", async () => {
		const harness = setup({
			config: { blockRows: [{ id: "b-1", content: "stale paragraph" }] },
		});
		const baseQuery = harness.client.query.bind(harness.client);
		let blockReads = 0;
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-in-doc") {
				blockReads += 1;
				const rows = (await baseQuery(stmt)) as {
					id: string;
					content: string;
				}[];
				// Reads 1–2 are the pre-write target reads (the flow's own, then
				// the primitive's); read 3 the first post-write verification
				// read — the index has not converged yet and still serves the
				// pre-write form.
				if (blockReads === 3) {
					return [{ ...rows[0]!, content: "stale paragraph" }];
				}
				return rows;
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
	});

	it("an identical resubmit lands after observed window stillness — the no-op reads as ok", () =>
		// The primitives judge a byte-equal resubmit through the convergence
		// window, never on the ack alone: stored content re-parses on
		// resubmit, so stillness — not the ack — is the no-op signal.
		// Collapsed table via the `withVerifyWindow` seam, same as the
		// silent-no-op case above: the first retry exhausts the window
		// instantly.
		withVerifyWindow([0], async () => {
			const { execute } = setup({
				config: {
					blockRows: [{ id: "b-1", content: "same body" }],
				},
			});
			const result = await execute({ ...editBase, markdown: "same body" });
			expect(result.status).toBe("ok");
		}));

	it("the successful edit baselines its own block from the verdict's carried pair", async () => {
		const harness = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				childrenFor: {
					"d-doc": [walkBlock("b-1", "p", "", "served body")],
				},
			},
		});
		// A prior serve seeds the baseline, so the pre-write fallback (which
		// only fills missing entries) cannot mask the refresh: only the
		// verdict-carried pair can move the hash off the original serve. The
		// tree holds the served form so the precondition matches.
		harness.baselines.remember("b-1", "served body");
		let blockReads = 0;
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-in-doc") {
				blockReads += 1;
				// Reads 1–2 are the pre-write reads (the flow's own, then the
				// primitive's); reads 3+ are post-write verification reads,
				// serving a kernel-normalized stored form distinct from the
				// submitted markdown.
				return blockReads <= 2
					? baseQuery(stmt)
					: [
							{
								id: "b-1",
								root_id: "d-doc",
								type: "p",
								content: "correctd body",
							},
						];
			}
			if (statementKind(stmt) === "block-contents") {
				// No baseline-content refresh rides the edit's success path —
				// the landed verdict carries the stored pair it judged. A
				// broad refresh here would launder a concurrent change into
				// the baseline.
				throw new Error("unexpected blocks.content refresh");
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
		// The verdict carried the post-write stored (index) form — a
		// follow-up edit compares against it, not the submitted markdown
		// and not the pre-write serve.
		expect(harness.baselines.servedHash("b-1")).toBe(
			contentHash("correctd body"),
		);
	});

	it("an unobserved-baseline landed verdict never seeds a baseline", async () => {
		// No pre-write pair (create → edit immediately: the index could not
		// see the block pre-write) — any served row lands the edit, but the
		// stored pair may still be the pre-edit row arriving through the
		// index lag, so it must not be laundered into a baseline.
		const harness = setup({ config: { blockRows: [] } });
		const baseQuery = harness.client.query.bind(harness.client);
		let blockReads = 0;
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-in-doc") {
				blockReads += 1;
				// Reads 1–2 are the pre-write reads (the flow's own, then the
				// primitive's) and both are absent; from read 3 on the index
				// serves a row — byte-identical to what a late-arriving pre-edit
				// row would look like.
				return blockReads <= 2
					? []
					: [
							{
								id: "b-1",
								root_id: "d-doc",
								type: "p",
								content: "stale paragraph",
							},
						];
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute(editBase);
		expect(result.status).toBe("ok");
		// The block stays baseline-less: the next fresh-check reads it as
		// `unseen` instead of trusting the possibly-stale row.
		expect(harness.baselines.servedHash("b-1")).toBeUndefined();
	});
});
