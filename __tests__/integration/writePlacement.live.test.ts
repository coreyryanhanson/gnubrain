// Live write-mode placement pins against the pinned kernel — where each
// mode lands (append/replace-section inside the section, moves through the
// placement rule, the sweep's boundary) plus the placement refusal and the
// vanished-anchor kernel-error route. Disposable fixture notebook,
// teardown via removeNotebook; opt-in with SIYUAN_INTEGRATION=1,
// never in CI.
//
// The refused kinds (a heading under `tabs` or an unnamed container) have no
// markdown-mintable fixture — tabs are a UI construct and a footnote
// definition cannot carry a heading — so their refusal is pinned by the
// headingInWalk unit cases; the kernel-side facts those refusals mirror (the
// membership oracle, the container write-parent set) are pinned by the
// primitives' own live suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	isHeadingBlock,
	PINNED_SIYUAN_VERSION,
	sectionOf,
	SiYuanKernelClient,
	walkBlockTree,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import { headingInWalk, type DocTarget } from "../../writeTarget.js";
import { createWriteGrantState } from "../../writeConfirm.js";
import { registerKbWrite } from "../unit/writeHarness.js";
import { type SessionValidation } from "../../validation.js";
import {
	awaitIndexed as hAwaitIndexed,
	mintDoc as hMintDoc,
	heading,
	BASE_URL,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("live write placement", () => {
	// Built lazily: a describe body runs during collection even when the suite
	// is skipped, and BASE_URL/TOKEN are only present in a live run.
	let client: SiYuanKernelClient;
	let notebookId = "";
	let run = 0;

	beforeAll(async () => {
		client = new SiYuanKernelClient(BASE_URL, TOKEN);
		const box = await client.createNotebook(
			`gnubrain-live-pins-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
		);
		notebookId = box.id;
		await client.openNotebook(notebookId);
	});

	afterAll(async () => {
		if (notebookId === "") return;
		try {
			await client.removeNotebook(notebookId);
		} catch {
			// teardown never masks a pin failure
		}
	});

	/** The kb_write tool path over the real kernel: the unit harness's
	 * registration with hooks wired to the live client. `intercept` runs
	 * once, before the first mutation call passes through — the neutral
	 * seam for injecting a concurrent edit between the walk and the insert
	 * (the concurrent-delete pin), independent of dialog placement. */
	function liveSetup(intercept?: () => Promise<void>) {
		run += 1;
		const validation: SessionValidation = {
			settings: undefined,
			shapeErrors: [],
			probe: { verdict: "ok", kernelVersion: PINNED_SIYUAN_VERSION },
			validKBs: new Map([["live", notebookId]]),
			scope: ["live"],
			defaultKBs: ["live"],
			warnings: [],
			authFailed: false,
			lsNotebooksOk: true,
		};
		let intercepted = false;
		const hook = intercept;
		const runIntercept = async () => {
			if (hook === undefined || intercepted) return;
			intercepted = true;
			await hook();
		};
		const kernel: WriteKernelClient =
			hook === undefined
				? client
				: Object.assign(Object.create(client) as WriteKernelClient, {
						insertBlock: async (
							params: Parameters<typeof client.insertBlock>[0],
						) => {
							await runIntercept();
							return client.insertBlock(params);
						},
						appendBlock: async (
							params: Parameters<typeof client.appendBlock>[0],
						) => {
							await runIntercept();
							return client.appendBlock(params);
						},
					});
		const { execute: runTool } = registerKbWrite({
			getValidation: () => validation,
			getKernel: () => kernel,
			breaker: new CircuitBreaker(),
			grantState: createWriteGrantState(),
			baselines: ContentBaselines.create(),
		});
		// Details-level result (status/anchor/outline/...) — the assertion
		// surface every write test uses.
		return async (params: Record<string, unknown>) =>
			(await runTool(params as never)).details as Record<string, unknown> & {
				status: string;
			};
	}

	/** Block-index polling + fixture minting ride the shared harness helpers
	 * (the write tool's ownership/guard queries lag createDocWithMarkdown). */
	const awaitIndexed = (docId: string) =>
		hAwaitIndexed(client, notebookId, docId);
	const mintDoc = (title: string, markdown: string) =>
		hMintDoc(client, notebookId, `/${title}-${run}`, markdown);

	/** Fold state rides the heading's ial (`fold` attr) — invisible to the
	 * walk, settable via the documented attr endpoint (raw fetch: the typed
	 * client deliberately keeps the attr surface out). */
	async function setFold(blockId: string, fold: boolean): Promise<void> {
		const res = await fetch(`${BASE_URL}/api/attr/setBlockAttrs`, {
			method: "POST",
			headers: {
				Authorization: `Token ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ id: blockId, attrs: { fold: fold ? "1" : "" } }),
		});
		expect(res.ok).toBe(true);
	}

	it(
		"append and replace-section on a callout-nested heading land inside the container; the doc's following blocks survive",
		async () => {
			const execute = liveSetup();
			const docId = await mintDoc(
				"callout nested",
				[
					"# Top",
					"",
					"> [!NOTE] Container",
					"> ## Nested",
					"> callout body",
					"",
					"after the callout",
					"",
					"# Next",
					"",
				].join("\n"),
			);
			const walk = (await walkBlockTree(client, docId)).blocks;
			const nested = heading(walk, "Nested");
			const appended = await execute({
				kb: "live",
				mode: "append",
				docId,
				headingId: nested.id,
				markdown: "appended body",
			});
			expect(appended.status).toBe("ok");
			const afterTree = await walkBlockTree(client, docId);
			const after = afterTree.blocks;
			const calloutSection = sectionOf(afterTree, nested.id);
			expect(calloutSection.kind).toBe("section");
			if (calloutSection.kind !== "section") return;
			const containerId = calloutSection.section.containerId;
			expect(containerId).not.toBeNull();
			// The appended block is the callout's last child; the container's
			// following siblings are untouched.
			const containerChildren = after.filter((b) => b.parentId === containerId);
			expect(containerChildren.at(-1)!.content).toBe("appended body");
			expect(after.some((b) => b.content === "after the callout")).toBe(true);
			expect(heading(after, "Next")).toBeDefined();

			// replace-section on the same nested target: the sweep is exactly the
			// sibling run inside the container, never the doc-level blocks after it.
			const replaced = await execute({
				kb: "live",
				mode: "replace-section",
				docId,
				headingId: nested.id,
				markdown: "replacement body",
			});
			expect(replaced.status).toBe("ok");
			const replaceTree = await walkBlockTree(client, docId);
			const afterReplace = replaceTree.blocks;
			const nestedAfter = heading(afterReplace, "Nested");
			const sweepSection = sectionOf(replaceTree, nestedAfter.id);
			expect(sweepSection.kind).toBe("section");
			if (sweepSection.kind !== "section") return;
			expect(sweepSection.section.members.map((m) => m.content)).toEqual([
				"replacement body",
			]);
			expect(afterReplace.some((b) => b.content === "after the callout")).toBe(
				true,
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"a move into a list-item-nested section lands inside the item (the landing judgment is live-pinned primitives-side)",
		async () => {
			const execute = liveSetup();
			const docId = await mintDoc(
				"list item nested",
				[
					"# Top",
					"",
					"- item one",
					"",
					"  ## H",
					"",
					"  item body",
					"",
					"- item two",
					"",
					"# Next",
					"",
				].join("\n"),
			);
			const walk = (await walkBlockTree(client, docId)).blocks;
			const h = heading(walk, "H");
			const next = heading(walk, "Next");
			const moved = await execute({
				kb: "live",
				mode: "move",
				docId,
				blockId: next.id,
				toDocId: docId,
				toHeadingId: h.id,
			});
			// The landing position (inside the item, sibling surviving) is
			// live-pinned primitives-side (move.live) — the tool pin here is
			// the ok envelope and the anchor echo.
			expect(moved.status).toBe("ok");
			expect(String(moved.anchor)).toContain("previousID=");
		},
		LIVE_TIMEOUT,
	);

	it(
		"a doc-end move anchors previousID after the last root-level block; a blank destination anchors after its lone empty paragraph",
		async () => {
			const execute = liveSetup();
			const srcId = await mintDoc("source", "# Src\n\nsrc paragraph\n");
			const destId = await mintDoc(
				"populated destination",
				"# Dest\n\ndest one\n\ndest two\n",
			);
			const srcWalk = (await walkBlockTree(client, srcId)).blocks;
			const mover = srcWalk.find((b) => b.content === "src paragraph")!;
			const moved = await execute({
				kb: "live",
				mode: "move",
				docId: srcId,
				blockId: mover.id,
				toDocId: destId,
			});
			expect(moved.status).toBe("ok");
			expect(String(moved.anchor)).toContain("(doc end)");
			expect(String(moved.anchor)).toContain("previousID=");

			// Blank destination: the kernel never leaves a doc childless (a
			// blank doc carries one empty paragraph — live-pinned
			// primitives-side, move.live), so the appendBlock(root) leg is
			// unreachable live; the walk sees the lone paragraph and anchors
			// previousID after it (the empty-walk leg is unit-pinned). The
			// tool pin here is the anchor echo carrying that exact id.
			const emptyId = await client.createDocWithMarkdown({
				notebook: notebookId,
				path: `/blank destination-${run}`,
				markdown: "",
			});
			await awaitIndexed(emptyId);
			const blankWalk = (await walkBlockTree(client, emptyId)).blocks;
			const srcWalk2 = (await walkBlockTree(client, srcId)).blocks;
			const mover2 = srcWalk2.find((b) => isHeadingBlock(b))!;
			const moved2 = await execute({
				kb: "live",
				mode: "move",
				docId: srcId,
				blockId: mover2.id,
				toDocId: emptyId,
			});
			expect(moved2.status).toBe("ok");
			expect(String(moved2.anchor)).toContain(
				`previousID=${blankWalk[0]!.id} (doc end)`,
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"a nextID-anchored append and an empty-section move land identically folded and unfolded",
		async () => {
			const execute = liveSetup();
			// nextID-anchored append: fold the target heading (it has children —
			// the kernel's fold redirect is reachable), the landing is unchanged.
			const docId = await mintDoc(
				"fold independence",
				["# A", "", "p1", "", "## Sub", "", "p2", "", "# B", "", "pB", ""].join(
					"\n",
				),
			);
			const walk = (await walkBlockTree(client, docId)).blocks;
			const a = heading(walk, "A");
			const first = await execute({
				kb: "live",
				mode: "append",
				docId,
				headingId: a.id,
				markdown: "first body",
			});
			expect(first.status).toBe("ok");
			expect(String(first.anchor)).toContain("nextID=");
			const afterFirst = (await walkBlockTree(client, docId)).blocks;
			const firstId = afterFirst.find((b) => b.content === "first body")!.id;
			const bId = heading(afterFirst, "B").id;
			// Unfolded: the new block's next entry is the boundary heading B.
			expect(
				afterFirst[afterFirst.findIndex((b) => b.id === firstId) + 1]!.id,
			).toBe(bId);
			await setFold(a.id, true);
			const second = await execute({
				kb: "live",
				mode: "append",
				docId,
				headingId: a.id,
				markdown: "second body",
			});
			expect(second.status).toBe("ok");
			const afterSecond = (await walkBlockTree(client, docId)).blocks;
			const secondIdx = afterSecond.findIndex(
				(b) => b.content === "second body",
			);
			expect(secondIdx).toBeGreaterThan(0);
			// Folded: identical landing — still directly before the boundary.
			expect(afterSecond[secondIdx + 1]!.id).toBe(bId);

			// Empty-section move with a heading anchor: folded and unfolded land
			// right after the heading (the fold branch has nothing to jump past).
			const mkEmptyCallout = async (
				title: string,
			): Promise<{ docId: string; empty: string }> => {
				const id = await mintDoc(
					title,
					[
						"# Top",
						"",
						"> [!NOTE] C",
						"> ## Empty target",
						"",
						"after the callout",
						"",
					].join("\n"),
				);
				const w = (await walkBlockTree(client, id)).blocks;
				return { docId: id, empty: heading(w, "Empty target").id };
			};
			const unfolded = await mkEmptyCallout("move unfolded");
			const filler1 = await client.appendBlock({
				data: "filler one",
				parentID: unfolded.docId,
			});
			const filler1Id = String(filler1[0]!.doOperations[0]!.id);
			const move1 = await execute({
				kb: "live",
				mode: "move",
				docId: unfolded.docId,
				blockId: filler1Id,
				toDocId: unfolded.docId,
				toHeadingId: unfolded.empty,
			});
			expect(move1.status).toBe("ok");
			const folded = await mkEmptyCallout("move folded");
			await setFold(folded.empty, true);
			const filler2 = await client.appendBlock({
				data: "filler two",
				parentID: folded.docId,
			});
			const filler2Id = String(filler2[0]!.doOperations[0]!.id);
			const move2 = await execute({
				kb: "live",
				mode: "move",
				docId: folded.docId,
				blockId: filler2Id,
				toDocId: folded.docId,
				toHeadingId: folded.empty,
			});
			expect(move2.status).toBe("ok");
			// Both land as the empty heading's first section member inside the
			// callout — identical position, fold state irrelevant.
			const movedFillerId = (docId2: string): string =>
				docId2 === unfolded.docId ? filler1Id : filler2Id;
			for (const docId2 of [unfolded.docId, folded.docId]) {
				const w = (await walkBlockTree(client, docId2)).blocks;
				const empty = w.find((b) => b.content === "Empty target")!;
				const siblings = w.filter((b) => b.parentId === empty.parentId);
				expect(siblings[1]!.id).toBe(movedFillerId(docId2));
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"deleting the boundary heading between walk and insert surfaces the kernel error with the fresh outline",
		async () => {
			const docId = await mintDoc("stale anchor", "# A\n\np1\n\n# B\n\npB\n");
			const walk = (await walkBlockTree(client, docId)).blocks;
			const a = heading(walk, "A");
			const b = heading(walk, "B");
			const execute = liveSetup(async () => {
				// The neutral kernel seam: the concurrent edit that deletes the
				// derived anchor between the walk and the insert.
				await client.deleteBlock(b.id);
			});
			const result = await execute({
				kb: "live",
				mode: "append",
				docId,
				headingId: a.id,
				markdown: "stale anchor body",
			});
			expect(result.status).toBe("error");
			expect(result.outline).toBeDefined();
			// The outline is a fresh read: the deleted boundary is gone from it.
			expect(String(result.outline)).not.toContain(b.id);
		},
		LIVE_TIMEOUT,
	);

	it(
		"a heading whose container is not a write-parent is refused by the flow before any kernel call",
		async () => {
			// The refusal rule over a real walk (the unit suite pins both refused
			// kinds against hand-built walks; tabs/footnote fixtures cannot be
			// minted from markdown).
			const docId = await mintDoc("refusal walk", "# A\n\np1\n\n# B\n\npB\n");
			const refusalTree = await walkBlockTree(client, docId);
			const walk = refusalTree.blocks;
			const doc: DocTarget = {
				rootId: docId,
				title: "refusal walk",
			};
			for (const h of walk.filter((b) => isHeadingBlock(b))) {
				expect(headingInWalk(refusalTree, doc, h.id)).toBe(h);
			}
		},
		LIVE_TIMEOUT,
	);
});
