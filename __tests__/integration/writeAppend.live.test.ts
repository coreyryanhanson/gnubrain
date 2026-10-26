// Live pins for the append route: the walk-set diff receipt (every new ID
// present, newBlockId among them, exactly one for a single-block append),
// the doc-end anchor echo, and anchor placement against the AST traps
// (list-ending section, final-section container). The append rollback
// branch itself is unreachable live and unit-pinned in the primitives'
// insert.test.ts. Runs against the live pinned kernel over the shared
// fixtures; opt-in with SIYUAN_INTEGRATION=1, never in CI.
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
	"write pins: append (walk-set diff + anchor echo/placement)",
	() => {
		let fixtures: IntegrationFixtures;
		let client: ReturnType<typeof makeWriteHelpers>["client"];
		let boxId: string;
		let writeSetup: ReturnType<typeof makeWriteHelpers>["writeSetup"];
		let outlineIds: ReturnType<typeof makeWriteHelpers>["outlineIds"];
		let walkHeadingIds: ReturnType<typeof makeWriteHelpers>["walkHeadingIds"];

		beforeAll(async () => {
			fixtures = await setupFixtures();
			const helpers = makeWriteHelpers(fixtures);
			client = helpers.client;
			boxId = helpers.boxId;
			writeSetup = helpers.writeSetup;
			outlineIds = helpers.outlineIds;
			walkHeadingIds = helpers.walkHeadingIds;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		it(
			"multi-block append's walk-set diff contains every new ID with newBlockId among them; single-block yields exactly one; the result outline matches a fresh post-write query",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Diff Pin",
					"# Diff Doc\n\ndh body\n",
				);

				const w = writeSetup();
				// Multi-block: a paragraph followed by a list.
				const preIds = new Set(
					(await walkBlockTree(client, docId)).blocks.map((b) => b.id),
				);
				const multi = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId,
					markdown: "diff para one\n\n- diff item\n",
				});
				expect(multi.status).toBe("ok");
				expect(multi.newBlockId).toBeDefined();
				const postIds = new Set(
					(await walkBlockTree(client, docId)).blocks.map((b) => b.id),
				);
				const diff = [...postIds].filter((id) => !preIds.has(id));
				expect(diff.length).toBeGreaterThanOrEqual(2);
				expect(diff).toContain(multi.newBlockId);
				// Write-result contract: the result outline matches a fresh
				// post-write query (heading IDs and order).
				expect(outlineIds(multi.outline)).toEqual(await walkHeadingIds(docId));

				// Single-block: a diff of exactly one ID.
				const pre2 = new Set(
					(await walkBlockTree(client, docId)).blocks.map((b) => b.id),
				);
				const single = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId,
					markdown: "single para",
				});
				expect(single.status).toBe("ok");
				const post2 = new Set(
					(await walkBlockTree(client, docId)).blocks.map((b) => b.id),
				);
				const diff2 = [...post2].filter((id) => !pre2.has(id));
				expect(diff2).toHaveLength(1);
				expect(diff2).toContain(single.newBlockId);
				expect(outlineIds(single.outline)).toEqual(await walkHeadingIds(docId));
			},
			LIVE_TIMEOUT,
		);

		it(
			"anchor-echo pin — append onto a trailing-content-after-last-heading doc reports the doc-end anchor",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Anchor Echo Pin",
					"# Anchor Echo\n\ntrailing paragraph\n",
				);
				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId,
					headingId: heading(
						(await walkBlockTree(client, docId)).blocks,
						"Anchor Echo",
					).id,
					markdown: "appended body",
				});
				expect(result.status).toBe("ok");
				expect(result.anchor).toBe("appendBlock(root) — doc end");
			},
			LIVE_TIMEOUT,
		);

		it(
			"anchor-placement pin — nextID lands where the outline says: a list-ending section (AST-sibling nesting trap) and a final-section container target",
			async () => {
				// Section ending in a list: the insert must land at the section's
				// level (before the boundary heading), never inside the list.
				const listDoc = await mintDoc(
					client,
					boxId,
					"/Anchor List Pin",
					"# A\n\nlead\n\n- i1\n- i2\n\n# B\n\nb body\n",
				);
				const listWalk = (await walkBlockTree(client, listDoc)).blocks;
				const a = heading(listWalk, "A");
				const b = heading(listWalk, "B");
				const w = writeSetup();
				const first = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId: listDoc,
					headingId: a.id,
					markdown: "appended before boundary",
				});
				expect(first.status).toBe("ok");
				expect(first.anchor).toBe(`nextID=${b.id} (next heading)`);
				const after = (await walkBlockTree(client, listDoc)).blocks;
				const landed = after.find(
					(x) => x.content === "appended before boundary",
				)!;
				// Doc level — a sibling of the boundary, not inside the list.
				expect(landed.parentId).toBeNull();
				expect(after[after.findIndex((x) => x.id === landed.id) + 1]!.id).toBe(
					b.id,
				);

				// Final section inside a container: appendBlock to the container,
				// the container's following siblings survive.
				const calloutDoc = await mintDoc(
					client,
					boxId,
					"/Anchor Callout Pin",
					[
						"# Top",
						"",
						"> [!NOTE] C",
						"> ## Nested",
						"> nested body",
						"",
						"after the callout",
						"",
					].join("\n"),
				);
				const calloutWalk = (await walkBlockTree(client, calloutDoc)).blocks;
				const nested = heading(calloutWalk, "Nested");
				const second = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId: calloutDoc,
					headingId: nested.id,
					markdown: "appended into callout",
				});
				expect(second.status).toBe("ok");
				expect(String(second.anchor)).toContain("appendBlock(");
				expect(String(second.anchor)).toContain("— end of section");
				const after2 = (await walkBlockTree(client, calloutDoc)).blocks;
				const nestedAfter = heading(after2, "Nested");
				const nestedTree = await walkBlockTree(client, calloutDoc);
				const nestedSection = sectionOf(nestedTree, nestedAfter.id);
				const containerId =
					nestedSection.kind === "section"
						? nestedSection.section.containerId
						: null;
				expect(containerId).not.toBeNull();
				expect(
					after2.find((x) => x.content === "appended into callout")!.parentId,
				).toBe(containerId);
				expect(after2.some((x) => x.content === "after the callout")).toBe(
					true,
				);
			},
			LIVE_TIMEOUT,
		);
	},
);
