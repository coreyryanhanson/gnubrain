// Live pins for the delete routes (delete + delete-section): the
// verbatim "tree not found" contract on a vanished target, the
// invalidRefs echoes (doc-level backlink, block-level orphan), the
// delete-section receipt (heading first, then the closure in judged
// order), and the fold-blind heading-delete report. The delete-generation
// fact itself is live-pinned in the primitives' delete.live; this file
// keeps the envelope pins. Runs against the live pinned kernel over the
// shared fixtures; opt-in with SIYUAN_INTEGRATION=1, never in CI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionOf, walkBlockTree } from "siyuan-kernel-primitives";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	heading,
	mintDoc,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";
import { makeWriteHelpers } from "./writePinsHelpers.js";

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"write pins: delete + delete-section (receipts + refs + reports)",
	() => {
		let fixtures: IntegrationFixtures;
		let client: ReturnType<typeof makeWriteHelpers>["client"];
		let boxId: string;
		let writeSetup: ReturnType<typeof makeWriteHelpers>["writeSetup"];
		let paraId: ReturnType<typeof makeWriteHelpers>["paraId"];
		let outlineIds: ReturnType<typeof makeWriteHelpers>["outlineIds"];
		let walkHeadingIds: ReturnType<typeof makeWriteHelpers>["walkHeadingIds"];

		beforeAll(async () => {
			fixtures = await setupFixtures();
			const helpers = makeWriteHelpers(fixtures);
			client = helpers.client;
			boxId = helpers.boxId;
			writeSetup = helpers.writeSetup;
			paraId = helpers.paraId;
			outlineIds = helpers.outlineIds;
			walkHeadingIds = helpers.walkHeadingIds;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		it(
			"delete of a kernel-deleted block surfaces the synchronous 'tree not found' error verbatim with the fresh outline",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Stale Delete",
					"# Stale Delete\n\nvictim paragraph\n\nkeeper paragraph\n",
				);
				const victim = await paraId(docId, "victim paragraph");
				await client.deleteBlock(victim);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "delete",
					docId,
					blockId: victim,
				});
				expect(result.status).toBe("error");
				expect(String(result.message)).toContain("tree not found");
				expect(result.blockId).toBe(victim);
				expect(result.outline).toBeDefined();
				// The outline is a fresh read of the post-delete tree.
				expect(outlineIds(result.outline)).toEqual(await walkHeadingIds(docId));
			},
			LIVE_TIMEOUT,
		);

		it(
			"doc-level delete backlink case — the invalidRefs echo shows the backlink count and referring hpaths; the ref reports invalid afterward",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Doc Delete Pin",
					"# Doc Delete\n\ndel body\n",
				);
				const delBlock = await paraId(docId, "del body");
				const referrerPath = "/Doc Delete Referrer";
				await mintDoc(
					client,
					boxId,
					referrerPath,
					`# Doc Delete Referrer\n\ncite: ((${delBlock} "cite"))\n`,
				);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "delete",
					docId,
					doc: true,
				});
				expect(result.status).toBe("ok");
				// invalidRefs + the deletedBlocks receipt, both built over the
				// pre-delete walk set — no doc left to outline.
				expect(result.invalidRefs).toMatchObject({
					count: 1,
					hpaths: [referrerPath],
					truncated: false,
				});
				expect(result.deletedBlocks).toContainEqual(
					expect.objectContaining({ content: "del body" }),
				);
				const invalid = await client.listInvalidBlockRefs();
				expect(JSON.stringify(invalid)).toContain(delBlock);
			},
			LIVE_TIMEOUT,
		);

		it(
			"block-level delete orphan case — planted ref to a single block deleted via the tool → invalidRefs echo",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Orphan Pin",
					"# Orphan Host\n\norphan para\n\n# B2\n\nb2 body\n",
				);
				const orphan = await paraId(docId, "orphan para");
				const referrerPath = "/Orphan Referrer";
				await mintDoc(
					client,
					boxId,
					referrerPath,
					`# Orphan Referrer\n\ncite: ((${orphan} "cite"))\n`,
				);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "delete",
					docId,
					blockId: orphan,
				});
				expect(result.status).toBe("ok");
				expect(result.invalidRefs).toMatchObject({
					count: 1,
					hpaths: [referrerPath],
					truncated: false,
				});
			},
			LIVE_TIMEOUT,
		);

		it(
			"delete-section: ok envelope shape on a live section-bearing heading — heading first, then the closure, receipt itemizes the whole removal",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Delete Section Mode",
					"# Delete Section Mode\n\nbody one\n\n## Nested\n\nnested body\n\n# Next\n\nnext body\n",
				);
				const tree = await walkBlockTree(client, docId);
				const target = heading(tree.blocks, "Delete Section Mode").id;
				const section = sectionOf(tree, target);
				expect(section.kind).toBe("section");
				const memberIds =
					section.kind === "section"
						? section.section.members.map((b) => b.id)
						: [];
				expect(memberIds).toHaveLength(3); // body one, Nested, nested body

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "delete-section",
					docId,
					headingId: target,
				});
				expect(result.status).toBe("ok");
				expect(result.headingId).toBe(target);
				// The receipt itemizes the whole removal — the heading first,
				// then the closure in document order (the verdict's judged
				// order — the fresh guard's, not the issued ops').
				expect(result.deletedBlocks).toHaveLength(4);
				expect(
					(result.deletedBlocks as { blockId: string }[]).map((b) => b.blockId),
				).toEqual([target, ...memberIds]);
				// The echo tail reflects the post-delete tree: only "# Next" and
				// its body remain.
				expect(result.outline).toBeDefined();
				expect(outlineIds(result.outline)).toEqual(
					(await walkHeadingIds(docId)).filter((id) => id !== target),
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"delete (heading) on a live section-bearing heading: the ok receipt carries the heading-delete report with the member ids",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Heading Delete Report",
					"# Heading Delete Report\n\nbody one\n\n## Nested\n\nnested body\n\n# Next\n\nnext body\n",
				);
				const tree = await walkBlockTree(client, docId);
				const target = heading(tree.blocks, "Heading Delete Report").id;
				const section = sectionOf(tree, target);
				expect(section.kind).toBe("section");
				const memberIds =
					section.kind === "section"
						? section.section.members.map((b) => b.id)
						: [];

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "delete",
					docId,
					blockId: target,
				});
				// The fold-blind fact's tool-side consequence: the delete acks ok,
				// and the receipt names exactly what stayed behind.
				expect(result.status).toBe("ok");
				expect(String(result.message)).toContain("left in place");
				expect(result.orphanedMembers).toEqual(memberIds);
				// The members really did survive the heading delete.
				const after = await walkBlockTree(client, docId);
				for (const id of memberIds) {
					expect(after.blocks.some((b) => b.id === id)).toBe(true);
				}
			},
			LIVE_TIMEOUT,
		);
	},
);
