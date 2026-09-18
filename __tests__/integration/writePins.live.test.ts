// Sprint 5b-c: the write-side integration cases — the §10 stale-target,
// fresh-content, replace-section + delete-orphans, move, and write-result
// freshness cases. Runs against the live pinned kernel over the 5b-a
// fixtures; opt-in with SIYUAN_INTEGRATION=1, never in CI.
//
// No-honest-live-route notes (unit-pinned instead, per §10's stale-target case):
// append's walk-set rollback branch and move's tree-level-miss branch are
// unreachable live — 3.8.4 executes block writes synchronously and errors on
// unresolvable ids/anchors instead of rolling back behind an HTTP success.
// The adjacent honest route (a concurrently deleted boundary anchor → the
// kernel's synchronous error with the fresh outline attached) is live-pinned
// in writeModes.live.test.ts (L6); the rollback/tree-level-miss arms are
// unit-pinned. The container-nested move target and the doc-end move are
// likewise already live-pinned there (L2 move / L4).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { sqlString } from "../../kernel.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { sectionOf } from "../../writeAnchors.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import { walkBlockTree, type WalkedBlock } from "../../walk.js";
import { registerWriteTool } from "../../write.js";
import {
	createWriteConfirmState,
	type WriteConfirmFn,
} from "../../writeConfirm.js";
import { REFS_BACKLINK_STMT_HEAD } from "../../writeResult.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	pollUntil,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("5b-c write-side cases", () => {
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

	/** kb_write over the live client; `confirm` intercepts the dialog (only
	 * reached with hasUI — the fixture settings' allowUnattendedWrites only
	 * skips the dialog for headless sessions). `baselines` lets a case share
	 * one map between the read and write tools (the fresh-content case's served baselines). */
	function writeSetup(
		opts: {
			confirm?: WriteConfirmFn;
			hasUI?: boolean;
			baselines?: ContentBaselines;
		} = {},
	) {
		const confirms: { title: string; message: string }[] = [];
		const { pi, toolDefs } = createFakePi();
		registerWriteTool(pi, {
			getValidation: () => fixtures.validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: opts.baselines ?? ContentBaselines.create(),
			// Default: record the dialog summary and approve — the capture
			// surface the confirmation-display pins assert on.
			confirm:
				opts.confirm ??
				(async (title, message) => {
					confirms.push({ title, message });
					return true;
				}),
		});
		const { ctx } = createFakeCtx({
			...(opts.hasUI !== undefined && { hasUI: opts.hasUI }),
		});
		const run = async (
			params: Record<string, unknown>,
		): Promise<Record<string, unknown> & { status: string }> =>
			(
				await (
					toolDefs.get("kb_write") as unknown as {
						execute: (...args: unknown[]) => Promise<{
							details: Record<string, unknown> & { status: string };
						}>;
					}
				).execute("id", params, undefined, undefined, ctx)
			).details;
		return {
			run,
			confirms,
		};
	}

	/** kb_read through the tool (the outline path that seeds served
	 * baselines). */
	function readSetup(baselines?: ContentBaselines) {
		const { pi, toolDefs } = createFakePi();
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
			(
				await (
					toolDefs.get("kb_read") as unknown as {
						execute: (...args: unknown[]) => Promise<{
							details: Record<string, unknown> & { status: string };
						}>;
					}
				).execute("id", params, undefined, undefined, ctx)
			).details;
	}

	const heading = (walk: WalkedBlock[], content: string): WalkedBlock => {
		const h = walk.find((b) => b.type === "h" && b.content === content);
		expect(h, `heading '${content}' in walk`).toBeDefined();
		return h!;
	};

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
	// Stale-target contract pins (§10)
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
	// Fresh-content live pin (§10)
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
			// The blocks index converges the changed content asynchronously —
			// wait it out before issuing the edit, or the precondition's re-read
			// sees the old (baseline-matching) content and no refusal fires.
			await client.updateBlock({
				id: headingId,
				data: "# Fresh Pin changed",
			});
			await pollUntil(
				"kernel-side heading change reaching the blocks index",
				async () =>
					String(
						(
							await client.query(
								"SELECT content FROM blocks WHERE id = " + sqlString(headingId),
							)
						)[0]?.content ?? "",
					).includes("changed"),
			);

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
			// The kernel content is untouched by the refused write.
			const rows = await client.query(
				"SELECT content FROM blocks WHERE id = " + sqlString(headingId),
			);
			expect(String(rows[0]!.content)).toContain("changed");
			expect(String(rows[0]!.content)).not.toContain("attempted body");

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
								"SELECT content FROM blocks WHERE id = " + sqlString(ctrlBlock),
							)
						)[0]?.content ?? "",
					) === "edited body",
			);
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Replace-section + delete-orphans end to end (§10)
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
			// §4 write-result contract fields on a replace.
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
				async () => (await client.listInvalidBlockRefs())?.blocks?.length === 0,
			);
			// Outline ordering re-asserted from the write result and a fresh
			// walk — identical heading IDs in document order.
			expect(outlineIds(result.outline)).toEqual([rootSec.id, next.id]);
			expect(await walkHeadingIds(docId)).toEqual([rootSec.id, next.id]);
		},
		LIVE_TIMEOUT,
	);

	it(
		"final-section trailing sweep — the trailing block leaves with the section, the replacement lands at doc end, the confirmation showed it",
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

			const w = writeSetup({ hasUI: true });
			const result = await w.run({
				kb: "fixture-a",
				mode: "replace-section",
				docId,
				headingId,
				markdown: "replacement body",
			});
			expect(result.status).toBe("ok");
			// The confirmation displayed the trailing block's content before
			// the delete (the never-unseen-sweep pin, live).
			expect(w.confirms).toHaveLength(1);
			const summary = w.confirms[0]!.message;
			expect(summary).toContain("trailing para");
			expect(summary).toContain("body one");
			// Final section → no boundary → the doc-end anchor echo.
			expect(result.anchor).toBe("appendBlock(root) — doc end");
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
		"replace-section with a planted ref into a section content block — the confirmation named the inbound ref, the ref reports invalid with the invalidRefs echo",
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

			const w = writeSetup({ hasUI: true });
			const result = await w.run({
				kb: "fixture-a",
				mode: "replace-section",
				docId,
				headingId: heading(walk, "RS").id,
				markdown: "replacement body",
			});
			expect(result.status).toBe("ok");
			// The confirmation surfaced the inbound-ref count + referring hpath.
			expect(w.confirms).toHaveLength(1);
			expect(w.confirms[0]!.message).toContain("inbound refs: 1");
			expect(w.confirms[0]!.message).toContain(referrerPath);
			// The ref is orphaned: the echo carries it, and the kernel's own
			// invalid-ref report names the deleted def block.
			expect(result.invalidRefs).toEqual({ count: 1, hpaths: [referrerPath] });
			const invalid = await client.listInvalidBlockRefs();
			expect(JSON.stringify(invalid)).toContain(p1);
		},
		LIVE_TIMEOUT,
	);

	it(
		"updateBlock preserves block IDs — a ref into the edited block still resolves",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/Edit Preserve Pin",
				"# Edit Preserve\n\nbefore body\n",
			);
			const blockId = await paraId(docId, "before body");
			// A ref into the block about to be edited: ID preservation means it
			// still resolves after the edit (workspace-wide listInvalidBlockRefs
			// carries earlier cases' deliberately-orphaned refs, so the pin is
			// scoped to this block).
			await mintDoc(
				client,
				boxId,
				"/Edit Preserve Referrer",
				`# Edit Preserve Referrer\n\ncite: ((${blockId} "cite"))\n`,
			);
			const w = writeSetup();
			const result = await w.run({
				kb: "fixture-a",
				mode: "edit",
				docId,
				blockId,
				markdown: "after body",
			});
			expect(result.status).toBe("ok");
			// The same block id now carries the new content (IDs preserved); the
			// content column converges asynchronously after the edit.
			await pollUntil(
				"edited content reaching the blocks index",
				async () =>
					String(
						(
							await client.query(
								"SELECT content FROM blocks WHERE id = " + sqlString(blockId),
							)
						)[0]?.content ?? "",
					) === "after body",
			);
			// The ref into the edited block still resolves — it is not among
			// the workspace's invalid refs.
			const invalid = await client.listInvalidBlockRefs();
			expect(JSON.stringify(invalid)).not.toContain(blockId);
		},
		LIVE_TIMEOUT,
	);

	it(
		"doc-level delete backlink case — the confirmation surfaced the backlink count and referring hpaths; the ref reports invalid afterward",
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

			const w = writeSetup({ hasUI: true });
			const result = await w.run({
				kb: "fixture-a",
				mode: "delete",
				docId,
				doc: true,
			});
			expect(result.status).toBe("ok");
			expect(w.confirms).toHaveLength(1);
			expect(w.confirms[0]!.message).toContain("inbound refs: 1");
			expect(w.confirms[0]!.message).toContain(referrerPath);
			// Pinned shape: only invalidRefs — no doc left to outline.
			expect(result.invalidRefs).toEqual({ count: 1, hpaths: [referrerPath] });
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
			expect(result.invalidRefs).toEqual({ count: 1, hpaths: [referrerPath] });
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Move cases (§10): doc-level; cross-doc + same-doc block moves
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

			// Self move refused.
			const self = await w.run({
				kb: "fixture-a",
				mode: "move",
				docId: rootDoc,
				doc: true,
				toDocId: rootDoc,
			});
			expect(self.status).toBe("refused");
			expect(String(self.message)).toContain("into itself");

			// Own-descendant move: the flow's parent_id-walk pre-check is a
			// backstop (live 'd' rows carry no parent_id — the hpath chain is
			// the kernel's nesting record) — the live kernel itself rejects the
			// ancestor move synchronously, and the rejection surfaces verbatim.
			const ownDesc = await w.run({
				kb: "fixture-a",
				mode: "move",
				docId: rootDoc,
				doc: true,
				toDocId: kid2,
			});
			expect(ownDesc.status).toBe("error");
			expect(String(ownDesc.message)).toContain("Cannot move to this location");

			// Own-parent no-op: a root-level doc to the notebook root.
			const ownParent = await w.run({
				kb: "fixture-a",
				mode: "move",
				docId: kid2,
				doc: true,
			});
			expect(ownParent.status).toBe("ok");
			const stillThere = await client.query(
				"SELECT root_id FROM blocks WHERE box = " +
					sqlString(boxId) +
					" AND id = " +
					sqlString(kid2) +
					" AND type = 'd'",
			);
			expect(stillThere).toHaveLength(1);
		},
		LIVE_TIMEOUT,
	);

	it(
		"doc-level move past the kernel's depth cap surfaces the error verbatim",
		async () => {
			// A depth-7 destination chain (the kernel's creation cap): nesting
			// under a doc that deep is rejected by the kernel's own depth cap,
			// both at creation (level 8) and at move time (live-verified).
			let path = "";
			const chain: string[] = [];
			for (let i = 1; i <= 7; i++) {
				path += `/Depth Chain ${i}`;
				chain.push(
					await mintDoc(
						client,
						boxId,
						path,
						`# Depth Chain ${i}\n\ndeep ${i}\n`,
					),
				);
			}
			const mover = await mintDoc(
				client,
				boxId,
				"/Depth Mover",
				"# Depth Mover\n\nmover body\n",
			);

			const w = writeSetup();
			const result = await w.run({
				kb: "fixture-a",
				mode: "move",
				docId: mover,
				doc: true,
				toDocId: chain[6]!,
			});
			expect(result.status).toBe("error");
			// The kernel's depth-cap rejection verbatim.
			expect(String(result.message)).toContain("7 levels deep");
			expect(result.docId).toBe(mover);
		},
		LIVE_TIMEOUT,
	);

	it(
		"cross-doc block move — movedBlockId equality, destOutline freshness, provenance survives; same-doc shape pin",
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
			const afterSame = await walkBlockTree(client, srcId);
			expect(afterSame.findLast((b) => b.parentId === null)!.id).toBe(mover.id);

			// Cross-doc move of the remaining block.
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
			// Provenance survives: same block id, same content, in the
			// destination tree; gone from the source.
			const destWalk = await walkBlockTree(client, destId);
			const landed = destWalk.find((b) => b.id === stayer.id)!;
			expect(landed.content).toBe("stayer body");
			const srcAfter = await walkBlockTree(client, srcId);
			expect(srcAfter.some((b) => b.id === stayer.id)).toBe(false);
			expect(srcAfter.some((b) => b.id === mover.id)).toBe(true);
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Item 10 — write-result freshness
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
			// §4 write-result contract: the result outline matches a fresh
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
		"refs index convergence — a write-planted block ref becomes visible to the backlink query within a bounded wait",
		async () => {
			const hostId = await mintDoc(
				client,
				boxId,
				"/Ref Host",
				"# Ref Host\n\nhost body\n",
			);
			const targetId = await mintDoc(
				client,
				boxId,
				"/Ref Target",
				"# Ref Target\n\ntarget body\n",
			);
			const targetBlock = await paraId(targetId, "target body");
			const hostBlock = await paraId(hostId, "host body");

			const w = writeSetup();
			const edited = await w.run({
				kb: "fixture-a",
				mode: "edit",
				docId: hostId,
				blockId: hostBlock,
				markdown: `updated body with ref ((${targetBlock} "x"))`,
			});
			expect(edited.status).toBe("ok");
			// Zero waits would flake: the derived refs index converges on the
			// same asynchronous pass as blocks (~2–3 s live) — the pin is the
			// bounded convergence, not literal immediacy.
			await pollUntil(
				"write-planted ref reaching the refs index",
				async () =>
					(
						await client.query(
							REFS_BACKLINK_STMT_HEAD + " (" + sqlString(targetBlock) + ")",
						)
					).length >= 1,
				15_000,
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"newBlockId response-shape — the transaction's doOperations[0].id is the minted ID and resolves to the inserted content",
		async () => {
			const docId = await mintDoc(
				client,
				boxId,
				"/Shape Pin",
				"# Shape Doc\n\nshape body\n",
			);
			const tx = await client.appendBlock({
				data: "shape probe body",
				parentID: docId,
			});
			const mintedId = tx[0]!.doOperations[0]!.id;
			expect(String(mintedId)).toMatch(/^\d{14}-[0-9a-z]+$/);
			// The minted id resolves to the inserted content (content column
			// converges asynchronously after the append).
			await pollUntil(
				"appended block reaching the blocks index",
				async () =>
					String(
						(
							await client.query(
								"SELECT content FROM blocks WHERE id = " +
									sqlString(String(mintedId)),
							)
						)[0]?.content ?? "",
					) === "shape probe body",
			);
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
			expect(after2.some((x) => x.content === "after the callout")).toBe(true);
		},
		LIVE_TIMEOUT,
	);
});
