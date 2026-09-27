// Live kernel-fact and result-evidence pins on the write path — verbatim
// kernel errors (edit/delete of a vanished block, tree-not-found), the
// stale/fresh-content precondition, delete receipts + invalidRefs echoes,
// move/append echo shapes, and the walk-set diffs. Runs against the live
// pinned kernel over the shared fixtures; opt-in with
// SIYUAN_INTEGRATION=1, never in CI.
//
// No-honest-live-route notes (unit-pinned instead, primitives-side):
// append's walk-set rollback branch and move's tree-level-miss branch are
// unreachable live — 3.8.4 executes block writes synchronously and errors on
// unresolvable ids/anchors instead of rolling back behind an HTTP success.
// The adjacent honest route (a concurrently deleted boundary anchor → the
// kernel's synchronous error with the fresh outline attached) is live-pinned
// in writePlacement.live.test.ts; the rollback/tree-level-miss arms are
// unit-pinned in the primitives' write.test.ts. The move landing facts
// (block-level judgment, placement-through-move, depth cap) are live-pinned
// in the primitives' move.live; this file keeps the move envelope pins.
// The delete-generation fact (3.8.3 success no-op vs 3.8.4 "tree not found")
// is live-pinned in the primitives' delete.live; this file keeps the delete
// envelope pins (the verbatim kernel message + fresh outline). The insert
// transaction's response shape (one insert op carrying the whole body in its
// data; doOperations[0].id as the minted id and its SQL convergence) is
// live-pinned in the primitives' writePins.live; this file keeps the
// tool-path walk-diff and envelope pins.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	SiYuanKernelClient,
	sqlString,
	walkBlockTree,
} from "siyuan-kb-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { sectionOf } from "siyuan-kb-primitives/write";
import { registerReadToolsAndToolset } from "../../tools.js";
import { registerWriteToolAndToolset } from "../../write.js";
import { createWriteGrantState } from "../../writeConfirm.js";
import {
	heading,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	pollUntil,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")(
	"write kernel-fact and evidence pins",
	() => {
		let fixtures: IntegrationFixtures;
		let client: SiYuanKernelClient;
		let boxId: string;

		beforeAll(async () => {
			fixtures = await setupFixtures();
			client = fixtures.client;
			boxId = fixtures.notebookIds.fixtureA;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

		/** kb_write over the live client. `baselines` lets a case share one map
		 * between the read and write tools (the fresh-content case's served
		 * baselines). The grant dialog is skipped via allowUnattendedWrites —
		 * the live suite drives the flows, not the dialog. */
		function writeSetup(
			opts: {
				baselines?: ContentBaselines;
			} = {},
		) {
			const { pi, runToolDetails } = createFakePi();
			registerWriteToolAndToolset(pi, {
				getValidation: () => fixtures.validation,
				getKernel: () => client,
				breaker: new CircuitBreaker(),
				grantState: createWriteGrantState(),
				baselines: opts.baselines ?? ContentBaselines.create(),
			});
			const { ctx } = createFakeCtx({ select: async () => "Yes" });
			return {
				run: async (
					params: Record<string, unknown>,
				): Promise<Record<string, unknown> & { status: string }> =>
					runToolDetails("kb_write", params, ctx),
			};
		}

		/** kb_read through the tool (the outline path that seeds served
		 * baselines). */
		function readSetup(baselines?: ContentBaselines) {
			const { pi, runToolDetails } = createFakePi();
			registerReadToolsAndToolset(pi, {
				getValidation: () => fixtures.validation,
				getKernel: () => client,
				breaker: new CircuitBreaker(),
				baselines: baselines ?? ContentBaselines.create(),
			});
			const { ctx } = createFakeCtx();
			return async (
				params: Record<string, unknown>,
			): Promise<Record<string, unknown> & { status: string }> =>
				runToolDetails("kb_read", params, ctx);
		}

		const paraId = async (docId: string, content: string): Promise<string> => {
			// The paragraph row lags the doc's ownership row — poll for it.
			await pollUntil(
				`paragraph '${content}' reaching the blocks index`,
				async () =>
					(
						await client.query(
							"SELECT id, content FROM blocks WHERE root_id = " +
								sqlString(docId) +
								" AND type = 'p' AND content = " +
								sqlString(content),
						)
					).length === 1,
			);
			const rows = await client.query(
				"SELECT id, content FROM blocks WHERE root_id = " +
					sqlString(docId) +
					" AND type = 'p' AND content = " +
					sqlString(content),
			);
			return String(rows[0]!.id);
		};

		const outlineIds = (outline: unknown): string[] =>
			[...String(outline).matchAll(/→ (\S+)/g)].map((m) => m[1]!);

		const walkHeadingIds = async (docId: string): Promise<string[]> =>
			(await walkBlockTree(client, docId))
				.filter((b) => b.type === "h")
				.map((b) => b.id);

		// -------------------------------------------------------------------
		// Stale-target contract pins
		// -------------------------------------------------------------------

		it(
			"edit against a kernel-deleted block surfaces the kernel's synchronous error verbatim with the fresh outline",
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
				expect(result.status).toBe("error");
				// The kernel error verbatim (3.8.4's synchronous not-found), never
				// a silent success or a bare transport message.
				expect(String(result.message)).toContain("tree not found");
				// The fresh outline rides the error so the agent re-targets.
				expect(result.outline).toBeDefined();
				expect(outlineIds(result.outline)).toEqual(await walkHeadingIds(docId));
			},
			LIVE_TIMEOUT,
		);

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

		// -------------------------------------------------------------------
		// Fresh-content live pin
		// -------------------------------------------------------------------

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
					await walkBlockTree(client, docId),
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
				const postTree = await walkBlockTree(client, docId);
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

		// -------------------------------------------------------------------
		// Replace-section + delete-orphans end to end
		// -------------------------------------------------------------------

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
				const walk = await walkBlockTree(client, docId);
				const rootSec = heading(walk, "Root Sec");
				const deepSub = heading(walk, "Deep Sub");
				const next = heading(walk, "Next");
				// Outline ordering before the write: document order across the
				// list-ending section (the load-bearing case where the superseded
				// SQL outline provably broke).
				expect(await walkHeadingIds(docId)).toEqual([
					rootSec.id,
					deepSub.id,
					next.id,
				]);

				// A block ref into the heading from a referrer doc — the heading ID
				// must survive the replace with the ref resolving.
				await mintDoc(
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

				const after = await walkBlockTree(client, docId);
				// Old body gone (paragraph, list, deeper heading's section).
				for (const gone of ["lead para", "item 1", "sub body"]) {
					expect(after.some((b) => b.content === gone)).toBe(false);
				}
				// The deeper heading went with the section (boundary rule); the
				// boundary heading survives with the same ID.
				expect(after.some((b) => b.id === deepSub.id)).toBe(false);
				expect(heading(after, "Next").id).toBe(next.id);
				expect(after.some((b) => b.id === rootSec.id)).toBe(true);
				// The new body sits directly under the heading.
				expect(sectionOf(after, rootSec.id)!.members[0]!.content).toBe(
					"replacement body",
				);
				// The heading's block ref still resolves — zero invalid refs (the
				// invalid-ref report lags the replace's index rebuild; poll it out).
				await pollUntil(
					"invalid refs clearing after the replace",
					async () =>
						(await client.listInvalidBlockRefs())?.blocks?.length === 0,
				);
				// Outline ordering re-asserted from the write result and a fresh
				// walk — identical heading IDs in document order.
				expect(outlineIds(result.outline)).toEqual([rootSec.id, next.id]);
				expect(await walkHeadingIds(docId)).toEqual([rootSec.id, next.id]);
			},
			LIVE_TIMEOUT,
		);

		it(
			"final-section trailing sweep — the trailing block leaves with the section, the replacement lands at doc end, the delete receipt itemizes it",
			async () => {
				const docId = await mintDoc(
					client,
					boxId,
					"/Trail Pin",
					"# Last Sec\n\nbody one\n\ntrailing para\n",
				);
				const headingId = heading(
					await walkBlockTree(client, docId),
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
				// The receipt: the swept closure's ids + walk content — the
				// visibility the pre-write grant dialog does not carry.
				expect(result.deletedBlocks).toEqual([
					{ id: expect.any(String), content: "body one" },
					{ id: expect.any(String), content: "trailing para" },
				]);
				const after = await walkBlockTree(client, docId);
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
				const walk = await walkBlockTree(client, docId);
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
				expect(result.invalidRefs).toEqual({
					count: 1,
					hpaths: [referrerPath],
				});
				const invalid = await client.listInvalidBlockRefs();
				expect(JSON.stringify(invalid)).toContain(p1);
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
				expect(result.invalidRefs).toEqual({
					count: 1,
					hpaths: [referrerPath],
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
				expect(result.targetGone).toBe(true);
				expect(result.invalidRefs).toEqual({
					count: 1,
					hpaths: [referrerPath],
				});
			},
			LIVE_TIMEOUT,
		);

		// -------------------------------------------------------------------
		// Move cases: doc-level; cross-doc + same-doc block moves
		// -------------------------------------------------------------------

		it(
			"doc-level move — IDs survive, echo shows the new hpath, follow-up write by echoed docId, self/own-descendant refused, own-parent no-op",
			async () => {
				const rootDoc = await mintDoc(
					client,
					boxId,
					"/Mv Root",
					"# Mv Root\n\nroot body\n",
				);
				const kid = await mintDoc(
					client,
					boxId,
					"/Mv Root/Mv Kid",
					"# Mv Kid\n\nkid body\n",
				);
				const kid2 = await mintDoc(
					client,
					boxId,
					"/Mv Root/Mv Kid2",
					"# Mv Kid2\n\nkid2 body\n",
				);
				const dest = await mintDoc(
					client,
					boxId,
					"/Mv Dest",
					"# Mv Dest\n\ndest body\n",
				);

				const w = writeSetup();
				// Doc-level move under the destination doc.
				const moved = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: kid,
					doc: true,
					toDocId: dest,
				});
				expect(moved.status).toBe("ok");
				// Pinned shape: outline + title/hpath echo, no anchor/newBlockId/
				// destOutline (doc-level record).
				expect(moved.docId).toBe(kid);
				expect(moved.title).toBe("Mv Kid");
				expect(moved.hpath).toBe("/Mv Dest/Mv Kid");
				expect(moved.outline).toBeDefined();
				expect(moved.anchor).toBeUndefined();
				expect(moved.newBlockId).toBeUndefined();
				expect(moved.destOutline).toBeUndefined();

				// Follow-up write by the echoed docId.
				const followUp = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId: kid,
					markdown: "post-move body",
				});
				expect(followUp.status).toBe("ok");

				// Identity move: the kernel's synchronous ancestor-move class
				// (the identity member included) surfaces verbatim through the
				// kernel-refused arm — the flow carries no pre-mutation
				// self-check of its own.
				const self = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: rootDoc,
					doc: true,
					toDocId: rootDoc,
				});
				expect(self.status).toBe("error");
				expect(String(self.message)).toContain("Cannot move to this location");

				// Own-descendant move: the primitive's kernel-refused arm surfaces
				// the kernel's synchronous ancestor-move rejection verbatim (the
				// rejection fact itself is live-pinned primitives-side, move.live).
				const ownDesc = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: rootDoc,
					doc: true,
					toDocId: kid2,
				});
				expect(ownDesc.status).toBe("error");
				expect(String(ownDesc.message)).toContain(
					"Cannot move to this location",
				);

				// Own-parent no-op: a root-level doc to the notebook root — the
				// tool maps the primitive's landed judgment to ok (the landed
				// judgment itself is live-pinned primitives-side, move.live).
				const ownParent = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: kid2,
					doc: true,
				});
				expect(ownParent.status).toBe("ok");
			},
			LIVE_TIMEOUT,
		);

		it(
			"cross-doc block move — movedBlockId equality, anchor echo, destOutline freshness; same-doc shape pin",
			async () => {
				const srcId = await mintDoc(
					client,
					boxId,
					"/Mx Src",
					"# Src H\n\nmover body\n\nstayer body\n",
				);
				const destId = await mintDoc(
					client,
					boxId,
					"/Mx Dest",
					"# Dest H\n\ndest body\n",
				);
				const srcWalk = await walkBlockTree(client, srcId);
				const mover = srcWalk.find((b) => b.content === "mover body")!;
				const stayer = srcWalk.find((b) => b.content === "stayer body")!;

				const w = writeSetup();

				// Same-doc move first: shape pin — anchor + movedBlockId, NO
				// destOutline. The mover lands after the section's last member.
				const sameDoc = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: srcId,
					blockId: mover.id,
					toDocId: srcId,
					toHeadingId: heading(srcWalk, "Src H").id,
				});
				expect(sameDoc.status).toBe("ok");
				expect(sameDoc.movedBlockId).toBe(mover.id);
				expect(String(sameDoc.anchor)).toContain("(end of section)");
				expect(sameDoc.destOutline).toBeUndefined();

				// Cross-doc move of the remaining block. The landing judgment
				// (membership cross-doc, position same-doc, provenance) is
				// live-pinned primitives-side (move.live) — the tool pins here are
				// the envelope fields only.
				const moved = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: srcId,
					blockId: stayer.id,
					toDocId: destId,
				});
				expect(moved.status).toBe("ok");
				expect(moved.movedBlockId).toBe(stayer.id);
				expect(String(moved.anchor)).toContain("previousID=");
				// destOutline is fresh: the destination's post-move heading set.
				const destOutline = String(moved.destOutline);
				expect(destOutline).toContain("Dest H");
			},
			LIVE_TIMEOUT,
		);

		// -------------------------------------------------------------------
		// Write-result freshness
		// -------------------------------------------------------------------

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
					(await walkBlockTree(client, docId)).map((b) => b.id),
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
					(await walkBlockTree(client, docId)).map((b) => b.id),
				);
				const diff = [...postIds].filter((id) => !preIds.has(id));
				expect(diff.length).toBeGreaterThanOrEqual(2);
				expect(diff).toContain(multi.newBlockId);
				// Write-result contract: the result outline matches a fresh
				// post-write query (heading IDs and order).
				expect(outlineIds(multi.outline)).toEqual(await walkHeadingIds(docId));

				// Single-block: a diff of exactly one ID.
				const pre2 = new Set(
					(await walkBlockTree(client, docId)).map((b) => b.id),
				);
				const single = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId,
					markdown: "single para",
				});
				expect(single.status).toBe("ok");
				const post2 = new Set(
					(await walkBlockTree(client, docId)).map((b) => b.id),
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
				const headingId = heading(
					await walkBlockTree(client, docId),
					"Anchor Echo",
				).id;
				const w = writeSetup();
				const result = await w.run({
					kb: "fixture-a",
					mode: "append",
					docId,
					headingId,
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
				const listWalk = await walkBlockTree(client, listDoc);
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
				const after = await walkBlockTree(client, listDoc);
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
				const calloutWalk = await walkBlockTree(client, calloutDoc);
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
				const after2 = await walkBlockTree(client, calloutDoc);
				const nestedAfter = heading(after2, "Nested");
				const containerId = sectionOf(after2, nestedAfter.id)!.containerId;
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
