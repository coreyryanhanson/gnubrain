// writeReplaceSection tests — the replace-section mode —
// executed through the registered kb_write definition on a fake-pi
// harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import {
	SiYuanApiError,
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanRateLimitError,
	contentHash,
} from "siyuan-kernel-primitives";
import {
	REPLACE_DOC,
	SECTION_DOC,
	nestChain,
	replaceParams,
	servedHash,
	setup,
	storedContentStub,
	walkBlock,
} from "./writeHarness.js";

// ---------------------------------------------------------------------------
// replace-section — receipt wording, envelope arms, invalidRefs
// ---------------------------------------------------------------------------

const REPLACE_LIST_DOC = {
	// A section containing a container: the members are [p1, l1] (the
	// items are l1's descendants, not members) — the batch deletes the
	// members only, the kernel cascade removes the descendants with the
	// container, and issuing them explicitly would nil-panic the bulk
	// path into a rollback behind a fully-successful replace.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "old one"),
		walkBlock("l1", "l", "", "list"),
		walkBlock("h2", "h", "h1", "Details"),
	],
	l1: [
		walkBlock("i1", "i", "", "item one"),
		walkBlock("i2", "i", "", "item two"),
	],
};

describe("replace-section", () => {
	it("replace ok receipt: anchor echo, orphaned-refs doc-count wording, fresh outline", async () => {
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				// A referring doc survives the replace — pins the orphaned-refs
				// count wording (doc(s), not ref(s): backlinkCheck counts roots).
				refRows: [{ id: "ref-1", root_id: "r1" }],
				hpathRows: [{ hpath: "/lab/notebook" }],
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("ok");
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		expect(result.newBlockId).toBe("b-new");
		// The orphaned-refs wording is agent-visible and pinned here: the
		// count is of distinct referring docs, not refs.
		expect(result.message).toContain("1 doc(s) with orphaned refs");
		expect(result.invalidRefs).toEqual({
			count: 1,
			hpaths: ["/lab/notebook"],
			truncated: false,
		});
		// Outline freshness: the result outline reflects the post-write
		// tree — the deleted blocks are gone from it.
		expect(result.outline).not.toContain("old one");
		expect(result.outline).not.toContain("old two");
		// Walk-count pin: the fresh-content judgment rides the caller-held
		// enumeration walk — enumeration + insert verification + the
		// delete batch's post-write walk, no fourth.
		expect(
			harness.calls
				.filter((c) => c.method === "getChildBlocks")
				.map((c) => c.args),
		).toEqual(["d-doc", "d-doc", "d-doc"]);
	});

	it("a stale anchor's synchronous insert error is not a partial replace: error with the fresh outline, nothing deleted", async () => {
		const failing = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					throw new SiYuanApiError(500, -1, "block [h2] not found");
				},
			},
		});
		const result = await failing.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("block [h2] not found");
		expect(result.outline).toBeDefined();
		// Pre-mutation refusals carry the target heading, never an anchor —
		// the stale walk's placement is not evidence.
		expect(result.headingId).toBe("h1");
		expect(result.anchor).toBeUndefined();
		expect(failing.calls.filter((c) => c.method === "transact")).toHaveLength(
			0,
		);
	});

	it("the post-batch walk must still hold the replacement — a cascade-consumed replacement fails loud, never ok", async () => {
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				// Simulate kernel misbehavior: the batch's cascade consumed
				// the replacement the insert just landed.
				onTransact: () => {
					harness.childrenFor["d-doc"] = (
						harness.childrenFor["d-doc"] ?? []
					).filter((b) => (b as { id: string }).id !== "b-new");
				},
				// p1 survives the batch (the sub-cliff silent no-op), so the
				// outcome is a walk arm — the survival reading only attaches
				// on the delete-leg arms, never on `replaced`.
				transactPrune: (id) => id !== "p1",
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("cascade consumed the replacement");
		expect(result.message).toContain("do not retry");
		// Fully applied, judged, and lost — the derived marker is
		// appliedConsumed (the verified-consumed arm), never the unverified
		// one. The receipt splits the issued
		// set against the walk: p1 survived, p2 verifiably deleted — no
		// survivor is ever claimed deleted.
		expect(result.appliedConsumed).toBe(true);
		expect(result.appliedUnverified).toBeUndefined();
		expect(result.deletedBlockIds).toEqual(["p2"]);
		expect(result.survivedIds).toEqual(["p1"]);
		// The certified post-batch walk rides the refusal as the inline
		// outline — recovery evidence without a re-fetch round trip.
		expect(result.outline).toBeDefined();
	});

	it("a success-acked batch that left a member in the tree fails loud (members-survived), never ok", async () => {
		// The batch acks but p1 silently no-ops (the sub-cliff arm the
		// transactPrune seam models) — the post-batch walk still shows it,
		// so the members-survived refusal renders with the survivors
		// itemized, never an ok receipt.
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				transactPrune: (id) => id !== "p1",
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"the delete batch acked but 1 old-section block(s) are still present",
		);
		// The by-id cleanup instruction is safe only behind the repair-first
		// lead — the lead rides the sentence and precedes the instruction.
		expect(result.message).toContain(
			"do NOT delete the surviving block(s) by id before a repair write",
		);
		expect(result.message.indexOf("make any committed write")).toBeLessThan(
			result.message.indexOf("delete the surviving old-section block(s) by id"),
		);
		// The composite doctrine's negative clause: a re-issue would
		// duplicate the section — the replacement is already in place.
		expect(result.message).toContain("never re-run replace-section");
		// The verdict's postWalk is served inline, not pointed at kb_read.
		expect(result.message).not.toContain("re-fetch the outline");
		expect(result.outline).toBeDefined();
		// The batched doctrine: survivors are acked-but-present ids, not a
		// not-yet-applied remainder.
		expect(result.survivedIds).toEqual(["p1"]);
		expect(result.deletedBlockIds).toEqual(["p2"]);
	});

	it("members-survived on a truncated post-walk: the absent member's deletion is unconfirmed — it rides unconfirmedBlockIds, never vanishes from the receipt", async () => {
		// The batch skips p1 (the silent no-op) and deletes p2, and the doc
		// regrows past the walk bound under a surviving sibling container —
		// the survivors outrank truncation, so the members-survived arm
		// renders over a truncated post-walk where p2's absence cannot be
		// certified.
		const harness = setup({
			config: {
				childrenFor: {
					...REPLACE_DOC,
					"d-doc": [
						...REPLACE_DOC["d-doc"],
						walkBlock("c9", "", "", "container"),
					],
					c9: [],
				},
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
						walkBlock("c9", "", "", "container"),
					];
				},
				onTransact: () => {
					nestChain(harness.childrenFor, "c9", 33);
				},
				transactPrune: (id) => id !== "p1",
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain(
			"the delete batch acked but 1 old-section block(s) are still present",
		);
		// The truncated-walk clause is part of the shared sentence — the
		// wording explains the unconfirmedBlockIds payload it publishes
		// (the shared absence-unconfirmed tail, writeBatchedVerdicts.ts).
		expect(result.message).toContain("depth-truncated");
		expect(result.message).toContain("absence past the bound is unconfirmed");
		expect(result.survivedIds).toEqual(["p1"]);
		// p2's deletion acked behind the batch, but the truncated walk
		// cannot certify the absence — it is unconfirmed, not silently
		// dropped and not claimed as deletedBlockIds.
		expect(result.unconfirmedBlockIds).toEqual(["p2"]);
		expect(result.deletedBlockIds).toBeUndefined();
	});

	it("the batch's issued member set is an antichain — any by-id cleanup order works", async () => {
		// The batch call itself fails (the whole batch is one call — nothing
		// acked per member). The partial state carries the plan's issued
		// set: roots only, no container paired with its descendants, so the
		// post-repair by-id cleanup can run in any order without cascading
		// errors.
		const harness = setup({
			config: {
				childrenFor: REPLACE_LIST_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_LIST_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_LIST_DOC["d-doc"].slice(3),
					];
				},
				transactError: new SiYuanApiError(500, -1, "kernel gone mid-batch"),
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.appliedUnverified).toBe(true);
		// Nothing is claimed deleted — the batch acks nothing per member, so
		// the whole-set-unconfirmed contract carries the judged set (the
		// cascade-covered closure included), not a per-op acked/unconfirmed
		// split.
		expect(result.unconfirmedBlockIds).toEqual(["p1", "l1", "i1", "i2"]);
		// The batch never walked — no certified snapshot exists to serve —
		// so the partial arm carries no outline.
		expect(result.outline).toBeUndefined();
	});

	it("a failed delete batch after a successful insert leaves duplication, never loss", async () => {
		// The whole batch silently no-ops behind HTTP success (the ≥32
		// rollback shape the transactPrune seam models) — the walk certifies
		// the WHOLE old section still present beside the replacement, so the
		// duplication is named, never loss, and the recovery doctrine
		// forbids the re-run that would duplicate the body.
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				transactPrune: () => false,
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("nothing was deleted");
		expect(result.message).toContain("beside the replacement");
		expect(result.message).toContain(
			"do NOT delete the old-section block(s) by id before a repair write",
		);
		// The composite doctrine: the repair-first lead precedes the by-id
		// cleanup instruction, and the negative clause forbids the re-issue.
		expect(result.message.indexOf("make any committed write")).toBeLessThan(
			result.message.indexOf("delete the surviving old-section block(s) by id"),
		);
		expect(result.message).toContain("never re-run replace-section");
		expect(result.newBlockId).toBe("b-new");
		expect(result.anchor).toBe("nextID=h2 (next heading)");
		expect(result.judgedBlockIds).toEqual(["p1", "p2"]);
		expect(result.outline).toBeDefined();
	});

	it("batch transport drop after a landed insert → verificationFailed carrying the whole issued set", async () => {
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				transactError: new SiYuanNetworkError(),
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		// The delete-batch failure is a mid-write step, not a verification
		// read — the envelope must carry the partial-apply state, or a
		// re-run duplicates the replacement. The batch acks nothing per
		// member, so the whole judged set rides unconfirmedBlockIds (the
		// whole-set-unconfirmed contract — no per-op split).
		expect(result.appliedUnverified).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2"]);
		expect(result.message).toContain("applied but unverified");
		expect(result.message).toContain("do NOT re-run");
		expect(result.message).not.toContain("SiYuan unreachable");
	});

	it("post-batch walk drop after the acked batch → verificationFailed carrying the judged set", async () => {
		let arm: ((err: Error) => void) | undefined;
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				armWalkError: (set) => {
					arm = set;
				},
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				// The batch acks; the post-write walk is the next read — arm
				// its drop from the transaction hook (the ops still apply).
				onTransact: () => {
					arm?.(new SiYuanNetworkError());
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		// A fully-applied write must never read as "unreachable" — the
		// receipt rides the envelope.
		expect(result.appliedUnverified).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		// The judged set — the closure, cascade-covered descendants
		// included — rides unconfirmedBlockIds: a committed batch takes the
		// closure with the members.
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2"]);
		expect(result.deletedBlockIds).toBeUndefined();
		expect(result.message).toContain("applied but unverified");
		expect(result.message).not.toContain("SiYuan unreachable");
	});

	it("post-walk-truncated: the batch acked but the walk hit the depth bound — applied but unverified, judged set unconfirmed", async () => {
		// The batch lands (the doc gets shallower), then the tree regrows
		// past the bound under a surviving sibling container, so the
		// post-batch walk truncates while the enumeration did not.
		const harness = setup({
			config: {
				childrenFor: {
					...REPLACE_DOC,
					"d-doc": [
						...REPLACE_DOC["d-doc"],
						walkBlock("c9", "", "", "container"),
					],
					c9: [],
				},
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
						walkBlock("c9", "", "", "container"),
					];
				},
				onTransact: () => {
					nestChain(harness.childrenFor, "c9", 33);
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("applied but unverified");
		expect(result.message).toContain("depth bound");
		expect(result.message).toContain(
			"whether the old section is fully gone could not be confirmed",
		);
		// The batch acks nothing per member, so no by-id cleanup
		// instruction rides this arm — the acked ids are unconfirmed, and
		// the receipt points at the delete set, not at an instruction.
		expect(result.message).not.toContain("delete the surviving");
		expect(result.appliedUnverified).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		// Acked is not verified: on a truncated walk the judged set rides
		// unconfirmedBlockIds, never deletedBlockIds.
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2"]);
		expect(result.deletedBlockIds).toBeUndefined();
	});

	it("429 on the delete batch → cooldown refusal carrying the whole issued set", async () => {
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				transactError: new SiYuanRateLimitError(429, 30),
			},
		});
		const result = await harness.execute(replaceParams);
		// The 429 still classifies (cooldown refusal — the lock is armed), but
		// the partial-apply state rides the envelope so the post-lock recovery
		// knows the delete set is unconfirmed in full.
		expect(result.status).toBe("refused");
		expect(result.message).toContain("rate-limit lockout");
		expect(result.message).toContain("applied but unverified");
		expect(result.appliedUnverified).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2"]);
	});

	it("auth on the delete batch → classified refusal carrying the post-insert partial state", async () => {
		// The auth error classifies in the gate (breaker counting) and the
		// attached partial state merges into the envelope — the post-insert
		// posture must never render as "nothing landed".
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
				transactError: new SiYuanAuthError(401),
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.message).toContain(
			"SiYuan auth rejected the request (HTTP 401)",
		);
		expect(result.appliedUnverified).toBe(true);
		expect(result.newBlockId).toBe("b-new");
		expect(result.unconfirmedBlockIds).toEqual(["p1", "p2"]);
	});

	it("delete-bearing results carry invalidRefs", async () => {
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				refRows: [{ root_id: "d-other" }],
				hpathRows: [{ hpath: "/Other doc" }],
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		const result = await harness.execute(replaceParams);
		expect(result.invalidRefs).toEqual({
			count: 1,
			hpaths: ["/Other doc"],
			truncated: false,
		});
		// The receipt: the section's closure (members + descendants, the
		// heading survives) with the walk content verbatim.
		expect(result.deletedBlocks).toEqual([
			{ blockId: "p1", content: "old one" },
			{ blockId: "p2", content: "old two" },
		]);
	});

	it("an unresolvable insert (silent rollback) refuses the deletes — the old section is untouched", async () => {
		const { execute, calls } = setup({
			config: {
				childrenFor: REPLACE_DOC,
			},
		}); // the tree never shows the minted block
		const result = await execute(replaceParams);
		expect(result.status).toBe("error");
		expect(result.message).toContain("the old section is untouched");
		expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
	});

	it("stale delete-set content → stale_content refusal before any kernel write", async () => {
		// The dialog served an older p1 (baseline seeded from it); the live
		// tree holds the concurrently rewritten form — the precondition reads
		// the tree, so the kernel-side change lands even inside the index's
		// convergence window.
		const harness = setup({ config: { childrenFor: REPLACE_DOC } });
		harness.baselines.remember("p1", "an even older one");
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.currentContent).toBe("old one");
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "updateBlock" ||
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock" ||
					c.method === "transact",
			),
		).toHaveLength(0);
	});

	it("multi-stale delete set → one refusal naming every stale member, each re-baselined from its named content", async () => {
		// Two concurrently-rewritten members: the guard judges every target
		// (no early stop), so one refusal carries both — each extra round-
		// trip a stop-at-first design would buy nothing the all-arms shape
		// doesn't give in one turn. The re-baselined hash of each named
		// member equals contentHash(its named currentContent) — the tool-side
		// half of the anti-laundering invariant.
		const harness = setup({ config: { childrenFor: REPLACE_DOC } });
		harness.baselines.remember("p1", "an even older one");
		harness.baselines.remember("p2", "an even older two");
		const result = await harness.execute(replaceParams);
		expect(result.status).toBe("refused");
		expect(result.reason).toBe("stale_content");
		expect(result.staleTargets).toEqual([
			{ blockId: "p1", currentContent: "old one" },
			{ blockId: "p2", currentContent: "old two" },
		]);
		expect(servedHash(harness.baselines, "p1")).toBe(contentHash("old one"));
		expect(servedHash(harness.baselines, "p2")).toBe(contentHash("old two"));
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock" ||
					c.method === "transact",
			),
		).toHaveLength(0);
	});

	it("walk/blocks representation drift fails closed — the refusal re-baselines from the tree and the retry proceeds", async () => {
		// The precondition's NOW rides the live tree; a baseline seeded from
		// a divergently-rendered blocks.content form must refuse (fail
		// closed), never launder the mismatch. The refusal re-baselines the
		// target from the tree, so the retried write compares like-for-like
		// and applies.
		const harness = setup({
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		harness.baselines.remember("p1", "old **one**");
		const refused = await harness.execute(replaceParams);
		expect(refused.status).toBe("refused");
		expect(refused.reason).toBe("stale_content");
		expect(
			harness.calls.filter(
				(c) =>
					c.method === "updateBlock" ||
					c.method === "insertBlock" ||
					c.method === "appendBlock" ||
					c.method === "deleteBlock" ||
					c.method === "transact",
			),
		).toHaveLength(0);
		const retry = await harness.execute(replaceParams);
		expect(retry.status).toBe("ok");
		expect(retry.reason).toBeUndefined();
	});

	it("write results re-baseline the blocks their outline carried — a follow-up edit compares like-for-like", async () => {
		// The blocks index and the walk serve the same representation on the
		// pinned kernel, so a baseline seeded from either source compares
		// clean against the tree-riding re-check — the replace applies, and
		// the result-carried outline re-baselines the follow-up edit against
		// the refreshed form instead of the pre-write serve.
		const harness = setup({
			config: {
				blockRows: [{ id: "p2", content: "old two" }],
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...REPLACE_DOC["d-doc"].slice(0, 3),
						walkBlock("b-new", "p", "", "rewritten section"),
						...REPLACE_DOC["d-doc"].slice(3),
					];
				},
			},
		});
		harness.baselines.remember("p2", "old two");
		const first = await harness.execute(replaceParams);
		expect(first.status).toBe("ok");
		// The follow-up edit targets a block the replace left in place and
		// the result's outline serve re-baselined (h2 — a walk heading, so
		// its baseline is the serve's snapshot): the follow-up fresh check
		// compares like-for-like against that refreshed form instead of
		// refusing stale.
		const second = await harness.execute({
			kb: "recipes",
			mode: "edit",
			docId: "d-doc",
			blockId: "h2",
			markdown: "Details, corrected",
		});
		expect(second.status).toBe("ok");
	});

	it("an intervening write refreshes only blocks its result carried — a concurrently-changed unserved block still refuses", async () => {
		// p1 was served earlier this session (baseline = "served body"); the
		// kernel's stored copy has since been changed concurrently. The
		// intervening append's tail refreshes only the blocks its result
		// carried (the outline headings + the new block) — a whole-doc
		// refresh would launder the concurrent change into p1's baseline and
		// the follow-up edit would hash-match the laundered content and
		// apply. The stub answers the baseline read with rows for exactly
		// the requested IDs, so the assertion fails on any request that
		// reaches for p1.
		const stored: Record<string, string> = {
			h1: "Goals",
			p1: "changed body",
			h2: "Details",
			p2: "body two",
			"b-new": "new fact",
		};
		const harness = setup({
			config: {
				blockRows: [{ id: "p1", content: "changed body" }],
				childrenFor: SECTION_DOC,
				onInsert: () => {
					harness.childrenFor["d-doc"] = [
						...SECTION_DOC["d-doc"],
						walkBlock("b-new", "p", "", stored["b-new"] as string),
					];
				},
			},
		});
		storedContentStub(harness, stored);
		harness.baselines.remember("p1", "served body");
		const intervention = await harness.execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new fact",
		});
		expect(intervention.status).toBe("ok");
		// p1 was not in the append's result — its served baseline survives.
		expect(servedHash(harness.baselines, "p1")).toBe(
			contentHash("served body"),
		);
		const edit = await harness.execute({
			kb: "recipes",
			mode: "edit",
			docId: "d-doc",
			blockId: "p1",
			markdown: "overwrite",
		});
		expect(edit.status).toBe("refused");
		expect(edit.reason).toBe("stale_content");
	});
});
