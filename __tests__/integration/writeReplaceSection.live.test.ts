// Live pins for the replace-section route: the boundary rule over a
// list/quote-ending section (the heading ID survives with its block ref),
// the final section's closure reaching doc end (the receipt itemizes it),
// and the planted-ref invalidRefs echo. Runs against the live
// pinned kernel over the shared fixtures; opt-in with
// SIYUAN_INTEGRATION=1, never in CI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionOf, walkBlockTree } from "siyuan-kernel-primitives";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	heading,
	mintDoc,
	pollUntil,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";
import { makeWriteHelpers } from "./writePinsHelpers.js";

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"write pins: replace-section (boundary rule + receipts + refs)",
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
			"replace-section on a list/quote-ending section — boundary rule, heading ID survives with its ref, outline ordering re-asserted",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Replace Pin",
					[
						"# Root Sec",
						"",
						"lead para",
						"",
						"- item 1",
						"- item 2",
						"",
						"## Deep Sub",
						"",
						"sub body",
						"",
						"# Next",
						"",
						"next body",
						"",
					].join("\n"),
				);
				const walk = (await walkBlockTree(client, docId)).blocks;
				const rootSec = heading(walk, "Root Sec");
				const deepSub = heading(walk, "Deep Sub");
				const next = heading(walk, "Next");
				// Outline ordering before the write: document order across the
				// list-ending section.
				expect(await walkHeadingIds(docId)).toEqual([
					rootSec.id,
					deepSub.id,
					next.id,
				]);

				// A block ref into the heading from a referrer doc — the heading ID
				// must survive the replace with the ref resolving.
				const referrerId = await mintDoc(
					client,
					boxId,
					"/Replace Referrer",
					`# Replace Referrer\n\ncite: ((${rootSec.id} "heading cite"))\n`,
				);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "replace-section",
					docId,
					headingId: rootSec.id,
					markdown: "replacement body",
				});
				expect(result.status).toBe("ok");
				// Write-result contract fields on a replace.
				expect(result.anchor).toBeDefined();
				expect(result.newBlockId).toBeDefined();
				expect(result.outline).toBeDefined();

				const afterTree = await walkBlockTree(client, docId);
				const after = afterTree.blocks;
				for (const gone of ["lead para", "item 1", "sub body"]) {
					expect(after.some((b) => b.content === gone)).toBe(false);
				}
				// The deeper heading went with the section (boundary rule); the
				// boundary heading survives with the same ID.
				expect(after.some((b) => b.id === deepSub.id)).toBe(false);
				expect(heading(after, "Next").id).toBe(next.id);
				expect(after.some((b) => b.id === rootSec.id)).toBe(true);
				// The new body sits directly under the heading.
				const rootSection = sectionOf(afterTree, rootSec.id);
				expect(
					rootSection.kind === "section"
						? rootSection.section.members[0]!.content
						: "no section",
				).toBe("replacement body");
				// The heading's block ref still resolves — scoped to this
				// referrer: the global report also carries user-workspace rot
				// this case doesn't own. (The report lags the replace; poll it
				// out.)
				await pollUntil("invalid refs clearing after the replace", async () => {
					const rows = (await client.listInvalidBlockRefs())?.blocks ?? [];
					return !rows.some((b) => b.rootID === referrerId);
				});
				// Outline ordering re-asserted from the write result and a fresh
				// walk — identical heading IDs in document order.
				expect(outlineIds(result.outline)).toEqual([rootSec.id, next.id]);
				expect(await walkHeadingIds(docId)).toEqual([rootSec.id, next.id]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"final-section closure to doc end — the trailing block leaves with the section, the replacement lands at doc end, the delete receipt itemizes it",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Trail Pin",
					"# Last Sec\n\nbody one\n\ntrailing para\n",
				);
				const headingId = heading(
					(await walkBlockTree(client, docId)).blocks,
					"Last Sec",
				).id;

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "replace-section",
					docId,
					headingId,
					markdown: "replacement body",
				});
				expect(result.status).toBe("ok");
				// Final section → no boundary → the doc-end anchor echo.
				expect(result.anchor).toBe("appendBlock(root) — doc end");
				// The receipt: the judged closure's ids + walk content — the
				// visibility the pre-write grant dialog does not carry.
				expect(result.deletedBlocks).toEqual([
					{ blockId: expect.any(String), content: "body one" },
					{ blockId: expect.any(String), content: "trailing para" },
				]);
				const after = (await walkBlockTree(client, docId)).blocks;
				expect(after.some((b) => b.content === "trailing para")).toBe(false);
				expect(after.some((b) => b.content === "body one")).toBe(false);
				expect(heading(after, "Last Sec").id).toBe(headingId);
				// The replacement is the doc's last root-level block.
				expect(after.findLast((b) => b.parentId === null)!.content).toBe(
					"replacement body",
				);
			},
			LIVE_TIMEOUT,
		);

		it(
			"replace-section with a planted ref into a section content block — the ref reports invalid with the invalidRefs echo",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Ref Replace Pin",
					"# RS\n\npara p1\n\n# Bound\n\nb body\n",
				);
				const walk = (await walkBlockTree(client, docId)).blocks;
				const p1 = await paraId(docId, "para p1");
				const referrerPath = "/Ref Replace Referrer";
				await mintDoc(
					client,
					boxId,
					referrerPath,
					`# Ref Replace Referrer\n\ncite: ((${p1} "cite"))\n`,
				);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "replace-section",
					docId,
					headingId: heading(walk, "RS").id,
					markdown: "replacement body",
				});
				expect(result.status).toBe("ok");
				// The ref is orphaned: the echo carries it, and the kernel's own
				// invalid-ref report names the deleted def block.
				expect(result.invalidRefs).toMatchObject({
					count: 1,
					hpaths: [referrerPath],
					truncated: false,
				});
				const invalid = await client.listInvalidBlockRefs();
				expect(JSON.stringify(invalid)).toContain(p1);
			},
			LIVE_TIMEOUT,
		);
	},
);
