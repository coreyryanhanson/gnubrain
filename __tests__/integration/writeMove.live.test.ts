// Live pins for the move routes: the doc-level record shape (outline +
// title/hpath echo, no anchor), the per-id block move envelope (anchor
// echo, destOutline freshness), and the widened section move's tool
// envelope (owner line inline, anchor echo, landed run, source emptied,
// shallower-than-boundary refusal). The landing facts themselves (codec,
// landed predicate, owner projection, ancestor-move rejection,
// placement-through-move, depth cap) are live-pinned in the primitives'
// move.live + moveSection.live; this file keeps the envelope pins. Runs
// against the live pinned kernel over the shared fixtures; opt-in with
// SIYUAN_INTEGRATION=1, never in CI.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { walkBlockTree } from "siyuan-kernel-primitives";
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
	"write pins: move (doc-level, per-id, widened section)",
	() => {
		let fixtures: IntegrationFixtures;
		let client: ReturnType<typeof makeWriteHelpers>["client"];
		let boxId: string;
		let writeSetup: ReturnType<typeof makeWriteHelpers>["writeSetup"];

		beforeAll(async () => {
			fixtures = await setupFixtures();
			const helpers = makeWriteHelpers(fixtures);
			client = helpers.client;
			boxId = helpers.boxId;
			writeSetup = helpers.writeSetup;
		}, LIVE_TIMEOUT);

		afterAll(async () => {
			if (fixtures === undefined) return;
			await fixtures.teardown();
		}, LIVE_TIMEOUT);

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
				const srcWalk = (await walkBlockTree(client, srcId)).blocks;
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

		it(
			"widened section move — heading blockId moves the whole section in one call: owner line inline, boundary anchor echo, source emptied; a shallower moved heading refuses pre-mutation",
			async () => {
				const srcId = await mintDoc(
					client,
					boxId,
					"/Ms Src",
					"# Sec Src\n\nintro\n\n### Moved H\n\nm1\n\nm2\n",
				);
				const destId = await mintDoc(
					client,
					boxId,
					"/Ms Dest",
					"# Sec Dest\n\n## Dest H\n\nd1\n\n## Tail H\n\nt1\n",
				);
				const srcWalk = (await walkBlockTree(client, srcId)).blocks;
				const movedH = heading(srcWalk, "Moved H");
				const destWalk = (await walkBlockTree(client, destId)).blocks;

				const w = writeSetup();
				const moved = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: srcId,
					blockId: movedH.id,
					toDocId: destId,
					toHeadingId: heading(destWalk, "Dest H").id,
				});
				expect(moved.status).toBe("ok");
				// The owner line rides message (inline): the deeper landing nests
				// inside the destination's section, and the owner names it.
				expect(String(moved.message)).toContain("landed under heading");
				expect(String(moved.message)).toContain("Dest H");
				expect(String(moved.anchor)).toContain("(next heading)");
				expect(moved.landedIds).toHaveLength(3); // heading + two members
				expect((moved.landedIds as string[])[0]).toBe(movedH.id);
				// destOutline is fresh: the destination's post-move tree holds
				// the landed section before Tail H.
				const destOutline = String(moved.destOutline);
				expect(destOutline).toContain("Moved H");
				expect(destOutline.indexOf("Moved H")).toBeLessThan(
					destOutline.indexOf("Tail H"),
				);
				// The source echo tail reflects the post-move source: emptied of
				// the run.
				expect(String(moved.outline)).not.toContain("Moved H");

				// The shallower refusal: a level-1 moved heading onto a section
				// whose boundary is level-2 — refused pre-mutation, zero kernel
				// mutations, the source layout unchanged.
				const shallowSrc = await mintDoc(
					client,
					boxId,
					"/Ms Shallow",
					"# Shallow H\n\ns1\n",
				);
				const shallowWalk = (await walkBlockTree(client, shallowSrc)).blocks;
				const refused = await w.run({
					kb: "fixture-a",
					mode: "move",
					docId: shallowSrc,
					blockId: heading(shallowWalk, "Shallow H").id,
					toDocId: destId,
					toHeadingId: heading(destWalk, "Dest H").id,
				});
				expect(refused.status).toBe("refused");
				expect(String(refused.message)).toContain("strictly shallower");
				expect(String(refused.message)).toContain(
					"swallow the destination's boundary heading",
				);
				// Zero mutations: the source still holds its section.
				const after = (await walkBlockTree(client, shallowSrc)).blocks;
				expect(heading(after, "Shallow H").id).toBe(
					heading(shallowWalk, "Shallow H").id,
				);
			},
			LIVE_TIMEOUT,
		);
	},
);
