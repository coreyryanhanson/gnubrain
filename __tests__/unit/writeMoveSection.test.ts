// writeMoveSection tests — the widened move mode's section arm —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub. The per-id route's tests stay
// in writeMove.test.ts.

import { describe, expect, it } from "vitest";
import {
	contentHash,
	SiYuanApiError,
	SiYuanNetworkError,
} from "siyuan-kernel-primitives";
import { statementKind } from "siyuan-kernel-primitives/testing";
import {
	MOVE_DOC_ROOTS,
	moveHarness,
	nestChain,
	servedHash,
	sectionMoveTrees,
	storedContentStub,
	walkBlock,
	type StubConfig,
} from "./writeHarness.js";

/** The standard section-move harness: the base two-doc tree (fresh per
 * call) over the shared doc roots; stub overrides pass through. */
function sectionMoveHarness(stub?: Partial<StubConfig>) {
	return moveHarness(undefined, {
		childrenFor: sectionMoveTrees(),
		docRoots: MOVE_DOC_ROOTS,
		...stub,
	});
}

// The widened section arm: every heading blockId routes to the batched
// section sequence (the row-type dispatch lives in the primitives).
describe("section move (the widened arm)", () => {
	// h1's section here IS the doc's trailing run and the move targets
	// doc end — the already-at-destination refusal (trailing-run
	// derivation) fires pre-mutation with zero kernel mutations. (The arm
	// shapes are falsified down-repo; this pins the refusal wording.)
	it("a section blockId rides the section route: a move whose group already occupies the destination's end is refused with zero kernel mutations (already-at-destination, trailing-run)", async () => {
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "h1", content: "A" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "h1",
			toDocId: "d-doc",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("nothing to move");
		expect(result.message).toContain(
			"already occupies the destination doc's end",
		);
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
		expect(harness.calls.filter((c) => c.method === "transact")).toHaveLength(
			0,
		);
	});

	// The widened capability's landing: a heading blockId moves its WHOLE
	// section in ONE transaction of raw move ops (members in document order
	// onto the destination section's boundary, then the heading anchored
	// before the first member), and the ok receipt LEADS with the relation
	// to the destination ("did it go under Dest?") before the owner line —
	// a deeper moved heading nests inside the destination's section, and
	// the owner names it.
	it("cross-doc section move lands whole: one transact of move ops, relation leads the receipt, boundary anchor echo", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h3", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("p2", "p", "", "m2"),
				],
				"d-other": [
					walkBlock("oh1", "h", "h2", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("oh2", "h", "h2", "Tail"),
					walkBlock("t1", "p", "", "t1"),
				],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("ok");
		// The receipt names the moved section by its own words, like the other
		// section flows; the blockId stays beside it in the payload.
		expect(result.message).toContain("moved the section under heading 'H' to");
		// The relation to the destination leads the landing sentence — the
		// fact the move asked about — with the level pair beside it; the
		// owner line follows.
		expect(result.message).toContain(
			"nested inside the destination section (moved heading level 3, destination heading level 2)",
		);
		expect(
			result.message.indexOf("nested inside the destination section"),
		).toBeLessThan(result.message.indexOf("landed under heading"));
		expect(result.destination).toEqual({
			relation: "nested",
			movedLevel: 3,
			destinationLevel: 2,
		});
		// The owner line rides message (inline), not just the outline payload;
		// the title rides beside the id (read off the verdict's post-write walk).
		expect(result.message).toContain(
			"landed under heading 'Dest (oh1)' (heading level 2)",
		);
		expect(result.anchor).toBe("nextID=oh2 (next heading)");
		expect(result.landedIds).toEqual(["hH", "p1", "p2"]);
		expect(result.landedOwner).toEqual({
			headingId: "oh1",
			level: 2,
			content: "Dest",
		});
		expect(result.destOutline).toContain("Dest");
		// The route: one batched transaction, never the per-id moveBlock.
		expect(harness.calls.filter((c) => c.method === "moveBlock")).toHaveLength(
			0,
		);
		expect(harness.calls.filter((c) => c.method === "transact")).toHaveLength(
			1,
		);
		// The batch carried the whole judged set in one transaction (the op
		// ORDER is the codec's fact, falsified down-repo — not re-pinned here).
		const ops = harness.calls
			.filter((c) => c.method === "transact")
			.flatMap((c) =>
				(c.args as { doOperations: { id: string }[] }[]).flatMap((tx) =>
					tx.doOperations.map((op) => op.id),
				),
			)
			.filter((id): id is string => id !== undefined);
		expect([...ops].sort()).toEqual(["hH", "p1", "p2"]);
	});

	// The anti-laundering invariant on the widened route: the landed
	// receipt's refresh list carries the whole run (heading + members),
	// and every heading among them was just served from the post-move
	// walk — the refresh must skip the served rows and SQL-read only the
	// non-heading members (an asynchronously-converged index row must
	// never overwrite a served baseline).
	it("section move: served headings keep their walk baseline — the refresh SQL-reads members only", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hA", "h", "h1", "A"),
					walkBlock("hH", "h", "h2", "Move me"),
					walkBlock("s1", "p", "", "m1"),
					walkBlock("hS", "h", "h3", "Sub"),
					walkBlock("s2", "p", "", "m2"),
					walkBlock("hB", "h", "h2", "B"),
					walkBlock("b1", "p", "", "b1"),
				],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		storedContentStub(harness, {
			// Divergent index rows for the served headings — never asked
			// for, never remembered. The members ride their true stored
			// form (the stub answers block-contents from this map only).
			hH: "index-lag Move me",
			hS: "index-lag Sub",
			s1: "m1",
			s2: "m2",
		});
		const requestedIds: string[][] = [];
		const baseQuery = harness.client.query.bind(harness.client);
		harness.client.query = async (stmt: string) => {
			if (statementKind(stmt) === "block-contents") {
				requestedIds.push(
					[...stmt.matchAll(/'([^']*)'/g)].flatMap((m) =>
						m[1] === undefined ? [] : [m[1]],
					),
				);
			}
			return baseQuery(stmt);
		};
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-doc",
			toHeadingId: "hB",
		});
		expect(result.status).toBe("ok");
		// Only the non-heading members are SQL-read, in landed order.
		expect(requestedIds).toEqual([["s1", "s2"]]);
		// Served headings keep the walk form they were shown.
		expect(servedHash(harness.baselines, "hH")).toBe(contentHash("Move me"));
		expect(servedHash(harness.baselines, "hS")).toBe(contentHash("Sub"));
		// Non-heading members baseline from stored form.
		expect(servedHash(harness.baselines, "s1")).toBe(contentHash("m1"));
		expect(servedHash(harness.baselines, "s2")).toBe(contentHash("m2"));
	});

	// The doc-end form (no destination heading): the codec's chain anchors
	// after the destination's last root-level block and marks `doc-end` —
	// the echo reads the append vocabulary's doc end, not a section end.
	it("cross-doc section move in the doc-end form: the chain echo reads (doc end)", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h3", "H"),
					walkBlock("p1", "p", "", "m1"),
				],
				"d-other": [walkBlock("p0", "p", "", "tail")],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
		});
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("previousID=p0 (doc end)");
	});

	// The owner line's null arm, at the destination's own level: a moved
	// heading at the destination heading's level lands AFTER the
	// destination's section — a sibling section of it, a top-level section
	// of the container no heading owns. The receipt leads with that
	// relation (sibling-after, the reordering capability), then the owner
	// line names the container.
	it("cross-doc section move at the destination's level: sibling-after leads, the owner line names the container (owner null)", async () => {
		const harness = sectionMoveHarness();
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).toContain(
			"landed as a sibling after the destination section, not nested inside it (moved heading level 1, destination heading level 1)",
		);
		expect(result.message.indexOf("landed as a sibling after")).toBeLessThan(
			result.message.indexOf("the landing is a top-level section"),
		);
		expect(result.destination).toEqual({
			relation: "sibling-after",
			movedLevel: 1,
			destinationLevel: 1,
		});
		expect(result.message).toContain(
			"the landing is a top-level section of its container (no heading owns it)",
		);
		expect(result.landedOwner).toBeNull();
	});

	// The session's own shape: a ## section under a # doc-root heading,
	// moved to the end of a sibling ## section — it lands as a sibling
	// after the destination (the receipt's lead sentence), while the owner
	// is the unrelated # heading above (a true fact, but not what the move
	// asked about — which is why the relation leads).
	it("same-level landing with an unrelated shallower owner: sibling-after leads, the owner names the # heading above", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h2", "H"),
					walkBlock("p1", "p", "", "m1"),
				],
				"d-other": [
					walkBlock("ohR", "h", "h1", "Root"),
					walkBlock("r1", "p", "", "r1"),
					walkBlock("ohB", "h", "h2", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("ohZ", "h", "h2", "Tail"),
				],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "ohB",
		});
		expect(result.status).toBe("ok");
		// The lead sentence is pinned by the sibling case above; this case
		// pins only the owner arm's distinct data — the shallower # owner.
		expect(result.destination).toEqual({
			relation: "sibling-after",
			movedLevel: 2,
			destinationLevel: 2,
		});
		expect(result.landedOwner).toEqual({
			headingId: "ohR",
			level: 1,
			content: "Root",
		});
	});

	// A shallower landing on the boundary arm: the boundary may sit at a
	// shallower level than the destination — a # closing a ## destination
	// lets a # move land shallower than it through the boundary arm (the
	// guard only refuses strictly-shallower-than-BOUNDARY).
	it("boundary-arm shallower landing: a # move onto a ## destination whose section closes at a #", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("p1", "p", "", "m1"),
				],
				"d-other": [
					walkBlock("oh1", "h", "h2", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("ohC", "h", "h1", "C"),
					walkBlock("c1", "p", "", "c1"),
				],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).toContain(
			"landed after the destination section at the moved heading's own level, not nested inside it (moved heading level 1, destination heading level 2)",
		);
		expect(result.destination).toEqual({
			relation: "shallower-after",
			movedLevel: 1,
			destinationLevel: 2,
		});
		// The boundary arm's own anchor echo, beside the relation — anchor
		// and owner read as one story.
		expect(result.anchor).toBe("nextID=ohC (next heading)");
	});

	// A concurrent delete of the destination heading leaves the landed
	// clauses satisfiable while the level relation goes unjudgeable — the
	// fourth arm words it and points at re-fetch; never a throw, never a
	// silent omission.
	it("destination-gone: a concurrently deleted destination heading is worded, not omitted", async () => {
		const tree = sectionMoveTrees();
		const harness = sectionMoveHarness({
			childrenFor: tree,
			transactMoveSkips: () => true,
			onTransact: () => {
				harness.childrenFor["d-doc"] = [];
				harness.childrenFor["d-other"] = [
					walkBlock("o1", "p", "", "o1"),
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("oh2", "h", "h1", "Tail"),
				];
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).toContain(
			"the destination section no longer exists in the live tree — re-fetch the outline (kb_read) to see where the section landed",
		);
		expect(
			result.message.indexOf("no longer exists in the live tree"),
		).toBeLessThan(
			result.message.indexOf("the landing is a top-level section"),
		);
		expect(result.destination).toEqual({
			relation: "destination-gone",
		});
	});

	// The identity refusal (the section route's own-closure arm), flow-side
	// wording over the primitive's judgment: the destination heading is the
	// moved heading itself.
	it("a heading blockId moved onto itself is refused via the section route's own-closure arm, zero kernel mutations", async () => {
		const harness = moveHarness(undefined, {
			blockRows: [{ id: "h1", content: "A" }],
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "h1",
			toDocId: "d-doc",
			toHeadingId: "h1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain(
			"the destination heading is the moved heading itself",
		);
		expect(harness.calls.filter((c) => c.method === "transact")).toHaveLength(
			0,
		);
	});

	// The level refusal (shallower-than-boundary): a moved heading strictly
	// shallower than the
	// destination section's boundary would swallow that boundary and every
	// section after it — refused pre-mutation, zero kernel mutations.
	it("a moved heading strictly shallower than the destination section's boundary is refused (shallower-than-boundary)", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("m1", "p", "", "m1"),
				],
				"d-other": [
					walkBlock("oh1", "h", "h2", "Dest"),
					walkBlock("d1", "p", "", "d1"),
					walkBlock("oh2", "h", "h2", "Tail"),
				],
			},
			docRoots: MOVE_DOC_ROOTS,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("refused");
		expect(result.message).toContain("strictly shallower");
		expect(result.message).toContain(
			"swallow the destination's boundary heading",
		);
		expect(harness.calls.filter((c) => c.method === "transact")).toHaveLength(
			0,
		);
	});

	// The silent-rollback arm, both recovery branches: the batch acks behind
	// HTTP success with nothing applied (every move op silently no-ops —
	// the skip-class rollback shape), and the wording branches on sameDoc —
	// a fact the flow holds, never a re-read.
	it("nothing-moved cross-doc: cause-free wording, heal-the-SOURCE-doc-first recovery", async () => {
		const harness = sectionMoveHarness({ transactMoveSkips: () => true });
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("move did not apply: nothing was moved");
		expect(result.message).toContain(
			"rolled back silently behind HTTP success",
		);
		expect(result.message).toContain("SOURCE doc 'Docker Networking'");
		expect(result.message).toContain("heals nothing");
		expect(result.judgedBlockIds).toEqual(["p1", "hH"]);
	});

	it("nothing-moved same-doc: the mild branch — retry-once recovery, no heal step", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hA", "h", "h1", "A"),
					walkBlock("a1", "p", "", "a1"),
					walkBlock("hH", "h", "h2", "H"),
					walkBlock("m1", "p", "", "m1"),
					walkBlock("hB", "h", "h2", "B"),
					walkBlock("b1", "p", "", "b1"),
				],
				"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
			},
			docRoots: MOVE_DOC_ROOTS,
			transactMoveSkips: () => true,
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-doc",
			toHeadingId: "hB",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("nothing was moved");
		expect(result.message).toContain("re-issue this move ONCE");
		expect(result.message).not.toContain("SOURCE doc");
	});

	// The unjudged-presence arm: a block inside the landed run's span that
	// is not in the issued set — the drag-at-front / swallowed-append
	// shape — is named, never silent.
	it("landed-divergent: an unjudged block inside the landed section's span is named in the receipt", async () => {
		const tree = sectionMoveTrees();
		tree["d-doc"].push(walkBlock("p2", "p", "", "m2"));
		const harness = sectionMoveHarness({
			childrenFor: tree,
			// The generic move application is suppressed; the hook lays the
			// divergent landing by hand: the run landed but a concurrent block
			// sits inside its span (between the members).
			transactMoveSkips: () => true,
			onTransact: () => {
				harness.childrenFor["d-doc"] = [];
				harness.childrenFor["d-other"] = [
					walkBlock("oh1", "h", "h1", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("x", "p", "", "extra"),
					walkBlock("p2", "p", "", "m2"),
					walkBlock("oh2", "h", "h1", "Tail"),
				];
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("did not land intact");
		expect(result.message).toContain("'x'");
		expect(result.message).toContain("span or tail");
		expect(result.unjudgedIds).toEqual(["x"]);
	});

	it("walk-failed: the batch acked but the post-write walk failed — appliedUnverified over the whole judged set", async () => {
		let arm: ((err: Error) => void) | undefined;
		const harness = sectionMoveHarness({
			armWalkError: (set) => {
				arm = set;
			},
			onTransact: () => {
				arm?.(new SiYuanNetworkError());
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		// Wiring: the move's judged set rides unconfirmedBlockIds in issued
		// order through the shared applied-but-unverified frame — the frame's
		// own wording/payload shape is pinned in the delete-section suite.
		expect(result.status).toBe("error");
		expect(result.appliedUnverified).toBe(true);
		expect(result.unconfirmedBlockIds).toEqual(["p1", "hH"]);
	});

	it("post-walk-truncated: the batch acked but the post-write walk hit the depth bound — applied but unverified, do-not-rerun wording", async () => {
		const tree = sectionMoveTrees();
		// The container precedes the moved heading, so it is not a
		// section member; it only carries the depth the post-write
		// walk will truncate on.
		tree["d-doc"] = [
			walkBlock("c9", "", "", "container"),
			...tree["d-doc"],
			walkBlock("p2", "p", "", "m2"),
		];
		const harness = sectionMoveHarness({
			childrenFor: tree,
			onTransact: () => {
				nestChain(harness.childrenFor, "c9", 33);
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		// The move applied but the post-write walk truncated: the receipt is
		// the applied-but-unverified frame with the do-not-rerun instruction,
		// and the whole judged set rides unconfirmedBlockIds.
		expect(result.status).toBe("error");
		expect(result.appliedUnverified).toBe(true);
		expect(result.verificationFailed).toBe(true);
		expect(result.message).toContain("applied but unverified");
		expect(result.message).toContain("Do NOT re-run");
		// The walks the verdict carries are served — the receipt points at
		// the attached outlines, never at a re-fetch (the replace flow's
		// members-survived precedent).
		expect(result.message).toContain("attached outlines");
		expect(result.message).not.toContain("re-fetch");
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2", "hH"]);
		expect(result.outline).toBeDefined();
		expect(result.destOutline).toBeDefined();
	});

	it("landed: a concurrent tail heading that bounds the landed run is named in the receipt (tailExtensionId)", async () => {
		const harness = moveHarness(undefined, {
			childrenFor: {
				"d-doc": [
					walkBlock("hH", "h", "h2", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("p2", "p", "", "m2"),
				],
				"d-other": [
					walkBlock("oh1", "h", "h1", "Dest"),
					walkBlock("o1", "p", "", "o1"),
				],
			},
			docRoots: MOVE_DOC_ROOTS,
			onTransact: () => {
				// A concurrent writer appends a heading to the destination
				// between the walk and the batch — after the chain anchor's
				// landing position, so it bounds the landed run instead of
				// breaking it (the benign-extension arm).
				harness.childrenFor["d-other"] = [
					walkBlock("oh1", "h", "h1", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("EH", "h", "h1", "Tail"),
				];
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("ok");
		expect(result.message).toContain(
			"a heading appended after the section's end now bounds it ('EH')",
		);
		expect(result.tailExtensionId).toBe("EH");
		expect(result.landedIds).toEqual(["hH", "p1", "p2"]);
		expect(result.landedOwner).toEqual({
			headingId: "oh1",
			level: 1,
			content: "Dest",
		});
	});

	it("landed-divergent: a member still present in the source doc is named as the copy case (stillInSourceIds)", async () => {
		const tree = sectionMoveTrees();
		tree["d-doc"].push(walkBlock("p2", "p", "", "m2"));
		tree["d-other"].pop(); // no trailing heading in the copy case's dest
		const harness = sectionMoveHarness({
			childrenFor: tree,
			// The generic move application is suppressed and the hook lays the
			// copy case by hand: the run landed whole in the destination, but a
			// member's copy stayed behind in the source. (No stub lever can
			// produce this from the ops themselves — the kernel's only skip
			// class rolls the whole batch back, which is the nothing-moved arm
			// instead; only tree surgery reaches the divergent state.)
			transactMoveSkips: () => true,
			onTransact: () => {
				harness.childrenFor["d-doc"] = [walkBlock("p2", "p", "", "m2")];
				harness.childrenFor["d-other"] = [
					walkBlock("oh1", "h", "h1", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("p2", "p", "", "m2"),
					walkBlock("oh2", "h", "h1", "Tail"),
				];
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("did not land intact");
		expect(result.message).toContain("copied rather than moved");
		expect(result.message).toContain("'p2'");
		expect(result.stillInSourceIds).toEqual(["p2"]);
	});

	// The no-evidence fallback: the run landed exact (every member in
	// order, none left behind) but the section's boundary heading differs
	// from the plan's anchor — a concurrent insert closed the moved
	// section early. No evidence part fires, so the receipt carries the
	// fallback sentence alone, and neither evidence field names a block.
	it("landed-divergent: a changed section boundary over an exact landed run emits the no-evidence fallback", async () => {
		const harness = sectionMoveHarness({
			// The generic move application is suppressed; the hook lays the
			// boundary change by hand: the run landed whole in the
			// destination, with a new same-level heading between the run's
			// tail and the planned boundary (oh2).
			transactMoveSkips: () => true,
			onTransact: () => {
				harness.childrenFor["d-doc"] = [];
				harness.childrenFor["d-other"] = [
					walkBlock("oh1", "h", "h1", "Dest"),
					walkBlock("o1", "p", "", "o1"),
					walkBlock("hH", "h", "h1", "H"),
					walkBlock("p1", "p", "", "m1"),
					walkBlock("nx", "h", "h1", "Sneak"),
					walkBlock("oh2", "h", "h1", "Tail"),
				];
			},
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("did not land intact");
		expect(result.message).toContain(
			"boundary changed after the plan was derived",
		);
		expect(result.unjudgedIds).toEqual([]);
		expect(result.stillInSourceIds).toBeUndefined();
	});

	it("a kernel rejection on the batch call surfaces verbatim through the shared ladder (wiring; the refusal note is pinned in the delete-section suite)", async () => {
		const harness = sectionMoveHarness({
			transactError: new SiYuanApiError(-1, -1, "tree not found"),
		});
		const result = await harness.execute({
			kb: "recipes",
			mode: "move",
			docId: "d-doc",
			blockId: "hH",
			toDocId: "d-other",
			toHeadingId: "oh1",
		});
		expect(result.status).toBe("error");
		expect(result.message).toContain("tree not found");
	});
});
