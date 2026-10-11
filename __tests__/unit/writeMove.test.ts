// writeMove tests — the move mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import { SiYuanApiError, SiYuanNetworkError } from "siyuan-kb-primitives";
import { setup, walkBlock, StubConfig } from "./writeHarness.js";

// ---------------------------------------------------------------------------
// move — verification + doc-level record
// ---------------------------------------------------------------------------

describe("block-level move", () => {
	const MOVE_DOC = {
		"d-doc": [
			walkBlock("h1", "h", "h1", "A"),
			walkBlock("p1", "l", "u", "mover"),
			walkBlock("p2", "p", "", "stay"),
		],
		// Kernel-shaped heading section (see SECTION_DOC).
		h1: [walkBlock("p1", "l", "u", "mover"), walkBlock("p2", "p", "", "stay")],
		"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
	};

	const moveParams = {
		kb: "recipes",
		mode: "move",
		docId: "d-doc",
		blockId: "p1",
		toDocId: "d-other",
		toHeadingId: "oh1",
	};

	/** move harness where `apply` mutates the children map kernel-side. */
	function moveHarness(apply?: () => void, stub?: Partial<StubConfig>) {
		return setup({
			config: {
				blockRows: [{ id: "p1", content: "mover" }],
				childrenFor: JSON.parse(JSON.stringify(MOVE_DOC)),
				docRoots: {
					"d-doc": {
						content: "Docker Networking",
						hpath: "/Docker Networking",
					},
					"d-other": { content: "Other doc", hpath: "/Other doc" },
				},
				...(apply ? { onMove: apply } : {}),
				...stub,
			},
		});
	}

	it("a foreign blockId (a block of another doc) is refused via the verified move's not-in-source arm", async () => {
		// The scoping judgment rides moveBlockVerified (the same raw-id fact
		// blockInDoc refuses edit/delete targets on); cross-doc the primitive
		// fetches the source walk itself. This path pins only the wording.
		const harness = moveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "b-foreign",
			toDocId: "d-other",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("is not a block of source doc");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("a pre-deleted source block: moveBlock's synchronous not-found error surfaces verbatim", async () => {
		const { execute, calls } = moveHarness(() => {
			throw new SiYuanApiError(-1, -1, "block not found");
		});
		const result = await execute(moveParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("block not found");
		expect(result.kb).toBe("recipes");
		expect(result.outline).toBeDefined();
		expect(calls.filter((c) => c.method === "moveBlock")).toHaveLength(1);
	});

	it("a toHeadingId absent from the destination walk is refused via the shared headingInWalk pin, before any kernel move", async () => {
		const harness = moveHarness();
		const result = await harness.execute({
			...moveParams,
			toHeadingId: "oh-gone",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"headingId 'oh-gone' is not a heading of doc 'Other doc' (d-other) — stale or foreign target",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("cross-doc: destination anchor echo, both outlines + movedBlockId", async () => {
		const harness = moveHarness(() => {
			harness.childrenFor["d-doc"] = MOVE_DOC["d-doc"].filter(
				(b) => b.id !== "p1",
			);
			harness.childrenFor["d-other"] = [
				walkBlock("oh1", "h", "h1", "Dest"),
				walkBlock("p1", "p", "", "mover"),
			];
		});
		const result = await harness.execute(moveParams);
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.outline).toBeDefined();
		expect(result.destOutline).toContain("Dest");
	});

	it("same-doc move collapses to outline + anchor with movedBlockId, no destOutline", async () => {
		const harness = moveHarness(() => {
			// The kernel applies: p1 lands at doc end.
			harness.childrenFor["d-doc"] = [
				walkBlock("h1", "h", "h1", "A"),
				walkBlock("p2", "p", "", "stay"),
				walkBlock("p1", "p", "", "mover"),
			];
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.destOutline).toBeUndefined();
		// Doc end with a populated destination: the anchor is the last
		// root-level block (parentID would prepend).
		expect(result.anchor).toBe("previousID=p2 (doc end)");
		// Same-doc: the in-hand source walk serves as the destination —
		// exactly one pre-write and one post-write source walk.
		const walks = harness.calls.filter(
			(c) => c.method === "getChildBlocks" && c.args === "d-doc",
		);
		expect(walks).toHaveLength(2);
	});

	it("cross-doc doc-end move into an EMPTY destination: the append anchor echo", async () => {
		// The only reach of the `append` anchor kind: an empty destination has
		// no block to anchor after. The live kernel never leaves a doc
		// childless, so this leg is unit-only by construction.
		const harness = moveHarness(
			() => {
				harness.childrenFor["d-doc"] = MOVE_DOC["d-doc"].filter(
					(b) => b.id !== "p1",
				);
				harness.childrenFor["d-other"] = [walkBlock("p1", "p", "", "mover")];
			},
			{
				childrenFor: JSON.parse(JSON.stringify({ ...MOVE_DOC, "d-other": [] })),
			},
		);
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-other",
		});
		expect(result.status).toBe("ok");
		expect(result.movedBlockId).toBe("p1");
		expect(result.anchor).toBe("appendBlock(root) — doc end");
	});

	it("a tree-level miss rolls back silently → verified-move error", async () => {
		const harness = moveHarness(); // the tree never changes
		const result = await harness.execute(moveParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("absent from the destination tree");
		expect(result.outline).toBeDefined();
		expect(result.destOutline).toBeDefined();
	});

	// The "already there" refusal class: the destination already contains
	// the block at the position the anchor would produce, so the kernel
	// would no-op behind HTTP success and the walk-set check would misreport
	// the move as landed — the pre-check refuses before any moveBlock.
	// (The pre-check's arm shapes are falsified down-repo; this pins the
	// refusal wording on the tool surface.)
	it("a destination that already holds the block at the anchor's position is refused with zero kernel moves", async () => {
		// MOVE_DOC's h1 section is [p1, p2] — moving p2 to its end would
		// issue moveBlock({previousID: p2}).
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "p2", content: "stay" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p2",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"already sits at the destination position",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("same-doc doc-end move: a silent kernel no-op is caught by the position check", async () => {
		// p1 is mid-doc; the kernel no-ops behind HTTP success — same-doc
		// walk presence can't distinguish, only the doc-end position can.
		const { execute, calls } = moveHarness(); // the tree never changes
		const result = await execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "p1",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"present but not at its landing position after the anchor",
		);
		expect(calls.filter((c) => c.method === "moveBlock")).toHaveLength(1);
	});

	// The own-subtree guard keys on the anchor the kernel receives (the
	// guard itself is falsified down-repo; this pins the refusal wording).
	it("a same-doc move into the block's own subtree is refused with zero kernel moves", async () => {
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "c1", content: "container" }],
			childrenFor: {
				"d-doc": [
					walkBlock("h1", "h", "h1", "A"),
					walkBlock("c1", "callout", "", "container"),
				],
				c1: [
					walkBlock("h2", "h", "h2", "Nested", "c1", "callout"),
					walkBlock("p-kid", "p", "", "kid", "c1", "callout"),
				],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "c1",
			toDocId: "d-doc",
			toHeadingId: "h2",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("inside the block's own subtree");
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
	});

	it("doc-level: moveDocsByID with the notebook id on un-nest; pinned result shape", async () => {
		const harness = moveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
		});
		expect(result.status).toBe("ok");
		const move = harness.calls.find((c) => c.method === "moveDocsByID");
		expect(move?.args).toEqual({ fromIDs: ["d-doc"], toID: "nb-r" });
		expect(result.outline).toBeDefined();
		expect(result.title).toBe("Docker Networking");
		// The doc-level echo's hpath rides the verdict's own evidence — the
		// live-tree read the landed judgment ran on (the kernel rebuilds the
		// blocks.hpath column asynchronously after moveDocsByID, so the SQL
		// column is never the source). The stub routes exportMarkdown through
		// the docRoots table.
		expect(result.hpath).toBe("/Docker Networking");
		expect(result.anchor).toBeUndefined();
		expect(result.newBlockId).toBeUndefined();
		expect(result.movedBlockId).toBeUndefined();
		expect(result.destOutline).toBeUndefined();
	});

	it("doc-level: the kernel rejects an identity move synchronously — surfaces verbatim", async () => {
		// No pre-mutation self-check in the flow: the kernel owns the whole
		// synchronous-rejection class (the identity member included, live-pinned
		// primitives-side, move.live), and the kernel-refused arm surfaces it
		// verbatim — the same shape as the ancestor and depth-cap rejections.
		const harness = moveHarness(() => {
			throw new SiYuanApiError(200, -1, "Cannot move to this location");
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-doc",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("Cannot move to this location");
		expect(result.verificationFailed).toBeUndefined();
		// Bare doc-level record on the kernel-refused arm: no echo tail.
		expect(result.outline).toBeUndefined();
		expect(result.hpath).toBeUndefined();
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(1);
	});

	it("doc-level: silent rollback behind HTTP success → verified-move failed, never ok", async () => {
		// moveDocsByID applies nothing in the stub — the tree still reports
		// the pre-move hpath, which is exactly the silent-rollback shape the
		// primitive's hpath judgment exists to catch.
		const harness = moveHarness();
		const r = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-other",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBeUndefined();
		// Bare doc-level record: no echo tail — a garnish read here could
		// mask the verdict (the errorTail rule; siblings carry no tail).
		expect(r.outline).toBeUndefined();
		expect(r.hpath).toBeUndefined();
		expect(r.message).toContain("verified-move failed");
		expect(r.message).toContain("did not land at the destination");
		expect(r.message).toContain("/Docker Networking");
	});

	it("doc-level: evidence-read drop (exportMarkdown) after moveDocsByID → verificationFailed, not a false ok", async () => {
		let arm: ((err: Error) => void) | undefined;
		const harness = moveHarness(undefined, {
			armExportError: (set) => {
				arm = set;
			},
			onMove: () => arm?.(new SiYuanNetworkError()),
		});
		const r = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		// The mutation's transport succeeded — the move may already be
		// applied. Never the retry invitation, never "unreachable".
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(r.message).toContain("post-write verification reads failed");
		expect(
			harness.calls.filter((c) => c.method === "moveDocsByID"),
		).toHaveLength(1);
	});

	it("doc-level: kernel rejections (the depth cap) surface verbatim", async () => {
		const harness = moveHarness(() => {
			throw new SiYuanApiError(500, -1, "depth level exceeded");
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			doc: true,
			toDocId: "d-other",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("depth level exceeded");
	});
});
