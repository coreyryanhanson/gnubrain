// Live pins for the edit route: the absent-target refusal (a target gone
// from the live tree refuses pre-mutation over the fresh guard's completed
// walk, with that walk's outline — nothing reaches the kernel) and the
// fresh-content precondition (kernel-side change → stale_content refusal,
// the refusal payload re-baselines, the re-target applies). The edit's
// verbatim kernel-refused arm is reachable only through the TOCTOU race
// the walk-absence refusal cannot close — no deterministic live staging
// exists (a walk-present `t` row does not refuse; updateBlock acks and
// replaces the table with a paragraph) — so it stays unit-pinned in the
// primitives. Runs against the live pinned kernel over the shared
// fixtures; opt-in with SIYUAN_INTEGRATION=1, never in CI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlString, walkBlockTree } from "siyuan-kernel-primitives";
import { ContentBaselines } from "../../baselines.js";
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
	"write pins: edit (stale target + fresh content)",
	() => {
		let fixtures: IntegrationFixtures;
		let client: ReturnType<typeof makeWriteHelpers>["client"];
		let boxId: string;
		let writeSetup: ReturnType<typeof makeWriteHelpers>["writeSetup"];
		let readSetup: ReturnType<typeof makeWriteHelpers>["readSetup"];
		let paraId: ReturnType<typeof makeWriteHelpers>["paraId"];
		let outlineIds: ReturnType<typeof makeWriteHelpers>["outlineIds"];
		let walkHeadingIds: ReturnType<typeof makeWriteHelpers>["walkHeadingIds"];

		beforeAll(async () => {
			fixtures = await setupFixtures();
			const helpers = makeWriteHelpers(fixtures);
			client = helpers.client;
			boxId = helpers.boxId;
			writeSetup = helpers.writeSetup;
			readSetup = helpers.readSetup;
			paraId = helpers.paraId;
			outlineIds = helpers.outlineIds;
			walkHeadingIds = helpers.walkHeadingIds;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		it(
			"edit against a kernel-deleted block refuses pre-mutation as absent-target, with the completed walk's outline",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Stale Edit",
					"# Stale Edit\n\nvictim paragraph\n\nkeeper paragraph\n",
				);
				const victim = await paraId(docId, "victim paragraph");
				await client.deleteBlock(victim);

				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "edit",
					docId,
					blockId: victim,
					markdown: "attempted body",
				});
				// The absent-target refusal: the fresh guard's completed walk no
				// longer emits the target, so the edit refuses before any mutation
				// (updateBlock on a walk-invisible row acks a destructive body
				// wipe). The sentence never asserts deletion — it names the
				// candidate causes (deleted, moved out, tree failed to load).
				expect(result.status).toBe("refused");
				expect(String(result.message)).toContain(
					`is absent from a complete walk of 'Stale Edit'`,
				);
				expect(String(result.message)).toContain(
					"nothing was modified — re-target from the outline below",
				);
				// The completed walk's outline rides the refusal so the agent
				// re-targets without a re-fetch.
				expect(result.outline).toBeDefined();
				expect(outlineIds(result.outline)).toEqual(await walkHeadingIds(docId));
			},
			LIVE_TIMEOUT,
		);

		it(
			"kernel-side content change between kb_read and edit → stale_content refusal with current content; control run applies",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Fresh Pin",
					"# Fresh Pin\n\noriginal body\n",
				);
				// One shared baselines map across read and write — the read's
				// served heading row is the baseline the edit's re-check verifies.
				const baselines = ContentBaselines.create();
				const read = readSetup(baselines);
				const seen = await read({ kb: "fixture-a", docId });
				expect(seen.status).toBe("ok");
				const headingId = heading(
					(await walkBlockTree(client, docId)).blocks,
					"Fresh Pin",
				).id;

				// The concurrent kernel-side change (another session / UI hand-edit).
				// The precondition re-reads the live tree, which updateBlock changed
				// synchronously — no index-convergence wait is needed (or valid:
				// polling the index first would converge it and mask the very
				// index-lag race this pin exists to catch).
				await client.updateBlock({
					id: headingId,
					data: "# Fresh Pin changed",
				});

				const w = writeSetup({ baselines });
				const refused = await w.run({
					kb: "fixture-a",
					mode: "edit",
					docId,
					blockId: headingId,
					markdown: "attempted body",
				});
				expect(refused.status).toBe("refused");
				expect(refused.reason).toBe("stale_content");
				expect(String(refused.currentContent)).toContain("changed");
				expect(refused.outline).toBeDefined();
				// The kernel content is untouched by the refused write — read from
				// the live tree, not the index (the index may still be converging
				// toward the kernel-side change; the tree is the authority).
				const postTree = (await walkBlockTree(client, docId)).blocks;
				const postHeading = postTree.find((b) => b.id === headingId);
				expect(postHeading !== undefined).toBe(true);
				expect(String(postHeading!.content)).toContain("changed");
				expect(String(postHeading!.content)).not.toContain("attempted body");

				// The refusal payload's current content became the baseline — the
				// re-target applies (the promised non-refuse-loop exit).
				const retried = await w.run({
					kb: "fixture-a",
					mode: "edit",
					docId,
					blockId: headingId,
					markdown: "attempted body",
				});
				expect(retried.status).toBe("ok");

				// Control run on a fresh doc: no intervening change → applies.
				const ctrlId = await mintDoc(
					client,
					boxId,
					"/Fresh Control",
					"# Fresh Control\n\nto edit\n",
				);
				const ctrlBlock = await paraId(ctrlId, "to edit");
				const ctrl = await writeSetup().run({
					kb: "fixture-a",
					mode: "edit",
					docId: ctrlId,
					blockId: ctrlBlock,
					markdown: "edited body",
				});
				expect(ctrl.status).toBe("ok");
				// The content echo converges asynchronously after the edit.
				await pollUntil(
					"edited content reaching the blocks index",
					async () =>
						String(
							(
								await client.query(
									"SELECT content FROM blocks WHERE id = " +
										sqlString(ctrlBlock),
								)
							)[0]?.content ?? "",
						) === "edited body",
				);
			},
			LIVE_TIMEOUT,
		);
	},
);
