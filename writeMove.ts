// The move flow: the widened block-level move rides the primitives'
// moveVerified dispatch entry (one call, one snapshot — the entry fetches
// the source walk once, reads the row type off it, and routes: a heading
// blockId — memberless or not — to the batched section sequence, a
// non-heading block to the per-id core; both routes derive their anchors
// inside on held walks and every verdict carries the anchor it issued).
// The per-id route's wording lives here; the section route's lives in
// writeMoveSection.ts. Doc-level moves ride moveDocVerified (mutation,
// live-tree hpath judgment — the moved doc's echo hpath IS the verdict's
// evidence). Doc-target resolution stays tool-side.

import {
	errorEnvelope,
	refusedEnvelope,
	STALE_TARGET_GUIDANCE,
	unreachable,
	type Envelope,
} from "./envelope.js";
import { walkBlockTree } from "siyuan-kernel-primitives";
import {
	moveDocVerified,
	moveVerified,
	type ForeignRefusal,
	type MoveBlockLandedOutcome,
	type MoveBlockOutcome,
	type MoveDocLandedOutcome,
	type MoveDocOutcome,
	type MoveVerifiedOutcome,
} from "siyuan-kernel-primitives/write";
import { runMoveSectionOutcome } from "./writeMoveSection.js";
import { destOutlinePayload, echoTail } from "./writeEcho.js";
import { mutationFailure, mutationFailureEnvelope } from "./writeLadder.js";
import {
	headingInWalk,
	resolveDocTarget,
	staleHeadingMessage,
	type DocTarget,
	type WriteFlowBase,
	type WriteFlowInput,
} from "./writeTarget.js";
import type { BlockLevelMoveParams } from "./writeSchema.js";
import { finishWrite } from "./writeResult.js";
import {
	foreignWalkMessage,
	landedUnconfirmedClause,
	moveAnchorEcho,
	moveWalkTruncatedMessage,
} from "./writeVerdicts.js";

/** The verified block move's pre-mutation refusal frame — the wording
 * home for the per-id route's pre-mutation refusal arms (the primitives
 * judge the kernel facts; this repo words them): the placement pair
 * already-at-destination / own-subtree, the not-in-source scoping arm (the
 * kernel mutates by raw block id with no doc scoping of its own),
 * walk-truncated (incomplete pre-move walk — the entry derives both
 * routes' anchors on held walks, so the derivation's two refusal arms
 * ride the per-id union), and the wrapper-level
 * destination-walk provenance refusal (the gate precedes the row-type
 * dispatch, so the foreign arm rides the widened entry's top level). All
 * refuse before the mutation. */
function movePlacementRefusalEnvelope(
	outcome:
		| Extract<
				MoveBlockOutcome,
				{
					kind:
						| "already-at-destination"
						| "own-subtree"
						| "not-in-source"
						| "walk-truncated";
				}
		  >
		| ForeignRefusal,
	doc: { title: string; rootId: string },
	dest: { title: string; rootId: string },
	kb: string,
): Envelope {
	switch (outcome.kind) {
		case "walk-truncated":
			return refusedEnvelope(moveWalkTruncatedMessage, { kb });
		case "already-at-destination":
			return refusedEnvelope(
				`block '${outcome.blockId}' already sits at the destination position — nothing to move`,
			);
		case "own-subtree":
			return refusedEnvelope(
				`cannot move block '${outcome.blockId}' — its destination anchor sits inside the block's own subtree (the move would re-parent the block into itself); choose a destination outside the subtree`,
			);
		case "not-in-source":
			return refusedEnvelope(
				`blockId '${outcome.blockId}' is not a block of source doc '${doc.title}' (${doc.rootId}) — ${STALE_TARGET_GUIDANCE}`,
			);
		case "foreign":
			return refusedEnvelope(
				`cannot move block '${outcome.blockId}' — ${foreignWalkMessage("destination", dest, outcome.rootId)}`,
			);
	}
	return unreachable(outcome, "unhandled move placement arm");
}

/** The `judged` leg's not-landed refusal — the caller narrows on the
 * verdict (a landed verdict takes the success path, never this wording).
 * The tree's hpath is the judgment's only evidence, so the sentence
 * reports what the tree shows and claims no mechanism (an observed hpath
 * off the destination could be a rollback or a landing elsewhere; only
 * the block-level judgment's reason ladder can tell those apart). */
function moveDocJudgmentRefusalEnvelope(
	verdict: Exclude<MoveDocLandedOutcome, { kind: "landed" }>,
	ctx: { name: string; docId: string; title: string },
): Envelope {
	// `not-landed` is the negative half's only arm — a single type, so the
	// switch/satisfies-never exhaustiveness form cannot narrow it; the
	// discriminant annotation is the tripwire when the union widens.
	verdict.kind satisfies "not-landed";
	return errorEnvelope(
		`verified-move failed: doc '${ctx.title}' did not land at the destination — the tree reports hpath '${verdict.hpath}'`,
		{ kb: ctx.name, docId: ctx.docId },
	);
}

/** The verified doc move's pre-mutation scoping refusal — the blocks index
 * names no row for the moved doc in the claimed KB (the same class the
 * block move refuses as its own not-in-source arm; the doc judgment rides
 * moveDocVerified). Unreachable through a fresh resolveDocTarget — it is
 * the stale-target race, worded as such. */
function moveDocScopingRefusalEnvelope(
	outcome: Extract<MoveDocOutcome, { kind: "not-in-source" }>,
	ctx: { name: string },
): Envelope {
	return refusedEnvelope(
		`doc '${outcome.docId}' is not a doc of KB '${ctx.name}' — the blocks index names no row for it — ${STALE_TARGET_GUIDANCE}`,
	);
}

export async function runMoveMode(
	input: WriteFlowInput<"move">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, name, boxId, params } = input;
	if (params.doc === true) {
		// Doc-level move: moveDocsByID — destination doc or the notebook
		// id (un-nest). Intra-KB by construction (single-kb write contract).
		let destId = boxId;
		let destLabel = "the notebook root";
		if (params.toDocId !== undefined) {
			const dest = await resolveDocTarget(kernel, boxId, name, params.toDocId);
			if ("status" in dest) return dest;
			destId = dest.rootId;
			destLabel = `'${dest.title}' (${dest.rootId})`;
		}
		// The verified doc-level move: the mutation and the live-tree hpath
		// judgment (over the kernel's stored title — ground truth, never the
		// tool-side form) are one primitive call. Identity and ancestor moves
		// and the 7-level depth cap reject synchronously kernel-side and
		// surface verbatim (the kernel-refused arm) — the flows carry no
		// pre-mutation check of their own.
		const outcome = await moveDocVerified(kernel, input.probe, {
			docId: doc.rootId,
			boxId,
			destRootId: destId === boxId ? undefined : destId,
		});
		// The doc-level record carries no echo tail on any failure leg (the
		// pinned shape — the doc move runs with no doc target), so the tail
		// is empty.
		if (outcome.kind === "not-in-source") {
			// The blocks index names no row for the moved doc.
			return moveDocScopingRefusalEnvelope(outcome, { name });
		}
		if (outcome.kind !== "judged") {
			return mutationFailureEnvelope(outcome, {
				kb: name,
				extra: { docId: doc.rootId },
				tail: async () => ({}),
			});
		}
		if (outcome.verdict.kind !== "landed") {
			return moveDocJudgmentRefusalEnvelope(outcome.verdict, {
				name,
				docId: doc.rootId,
				title: doc.title,
			});
		}
		// The move landed — the hpath echo rides the verdict's own evidence
		// (the live-tree read the judgment ran on), never a second read that
		// could observe a concurrent rename between "verified" and "served".
		return finishWrite(name, {}, async () => {
			const tail = await echoTail(input, doc);
			// Pinned shape: outline + title/hpath echo, no anchor/newBlockId/
			// destOutline (doc-level record).
			return {
				status: "ok",
				message: `moved doc '${doc.title}' to ${destLabel} (KB ${name})`,
				kb: name,
				...tail,
				hpath: outcome.verdict.hpath,
			};
		});
	}
	const blockId = params.blockId;
	const dest = await resolveDocTarget(kernel, boxId, name, params.toDocId);
	if ("status" in dest) return dest;
	// Destination walk: cross-doc fetches the destination doc; same-doc the
	// source walk serves (one walk, both roles — the entry's walk rule).
	// Cross-doc the flow holds no source walk: the entry fetches it itself
	// (the single fetch both the row-type dispatch and the routes' judgments
	// read). The destination heading's targetable judgment (untargetable
	// containers — tabs, unnamed containers) is flow-side here, ONE owner
	// for both routes: the outline notation marks those headings
	// (not targetable), so accepting one would contradict the read surface.
	// Read-surface policy, not kernel legality — the kernel accepts such an
	// anchor (move ops skip CheckContainerParent); the refusal keeps the
	// tool's reads and writes telling one story.
	const destWalk = await walkBlockTree(kernel, dest.rootId);
	if (params.toHeadingId !== undefined) {
		const heading = headingInWalk(destWalk, dest, params.toHeadingId);
		if ("status" in heading) return heading;
	}
	// The widened move's one primitive call: the row-type dispatch lives in
	// the primitives (the tool layer neither sequences kernel mutations nor
	// re-derives placement) — a heading blockId rides the batched section
	// sequence (memberless or not; the memberless degenerate is the same
	// route at its degenerate shape), a non-heading block the per-id core.
	const outcome = await moveVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
		destRootId: dest.rootId,
		preDestWalk: destWalk,
		...(params.toHeadingId !== undefined && {
			toHeadingId: params.toHeadingId,
		}),
	});
	// The pre-dispatch refusals ride the wrapper's top level — drift (the
	// probe gate precedes any dispatch) and the destination-walk provenance
	// gate (it precedes the row-type dispatch). Route-agnostic wording,
	// the same envelopes the routes render for their own arms.
	switch (outcome.kind) {
		case "drift":
			return mutationFailure(outcome, input, doc, { blockId });
		case "foreign":
			return movePlacementRefusalEnvelope(outcome, doc, dest, input.name);
		case "section":
			return runMoveSectionOutcome(
				{ ...input, params },
				doc,
				dest,
				outcome.outcome,
			);
		case "per-id":
			return runPerIdMoveOutcome({ ...input, params }, doc, dest, outcome);
	}
	outcome satisfies never;
}

/** The per-id route's wording — every `MoveBlockOutcome` arm. The anchors
 * ride the verdicts (the entry derives them on held walks): the
 * failure ladder and the echoes spread the verdict's anchor, never a
 * pre-derived one. */
async function runPerIdMoveOutcome(
	input: WriteFlowBase & { params: BlockLevelMoveParams },
	doc: DocTarget,
	dest: DocTarget,
	wrapped: Extract<MoveVerifiedOutcome, { kind: "per-id" }>,
): Promise<Envelope> {
	const outcome = wrapped.outcome;
	const { name, params } = input;
	const blockId = params.blockId;
	const sameDoc = dest.rootId === doc.rootId;
	if (
		outcome.kind === "already-at-destination" ||
		outcome.kind === "own-subtree" ||
		outcome.kind === "not-in-source" ||
		outcome.kind === "walk-truncated"
	) {
		return movePlacementRefusalEnvelope(outcome, doc, dest, input.name);
	}
	if (outcome.kind === "heading-absent") {
		// The anchor-derivation arm, fed by the verdict (the entry derives
		// the anchor; headingInWalk refused this walk above, so this is the
		// fail-closed tripwire) — the same stale-heading sentence, keyed on
		// the id the verdict carries.
		return refusedEnvelope(staleHeadingMessage(outcome.headingId, dest), {
			kb: name,
		});
	}
	const echo = moveAnchorEcho(outcome.anchor);
	if (outcome.kind !== "judged") {
		// The shared ladder — the post-derivation arms carry the anchor the
		// move issued (drift is wrapper-level and already handled above;
		// every arm remaining here is anchor-bearing).
		return mutationFailure(outcome, input, doc, { anchor: echo });
	}
	// Post-mutation reads (see finishWrite's contract — the move may
	// already be applied).
	return finishWrite(name, { anchor: echo }, async () => {
		// The verified move's outcome carries its evidence: the post-move
		// walks are the judgment's snapshot — the tails below consume them
		// verbatim instead of re-fetching between "verified" and "served".
		const destPayload = sameDoc
			? {}
			: await destOutlinePayload(input, outcome.postDestWalk);
		if (outcome.verdict.kind !== "landed") {
			// The move did not land — no refreshBlockIds: its block gets no
			// baseline from a write that did not land (the tail seeds served
			// rows from the walk it serves).
			const srcTail = await echoTail(input, doc, outcome.postSourceWalk);
			return errorEnvelope(
				`verified-move failed: block '${blockId}' ${moveLandedRefusal(outcome.verdict)}`,
				{
					kb: name,
					anchor: echo,
					...srcTail,
					...destPayload,
				},
			);
		}
		// The move landed — movedBlockId is what the result carried, so its
		// baseline refresh rides this path only (the failure path above
		// refreshes nothing).
		const srcTail = await echoTail(input, doc, outcome.postSourceWalk, [
			blockId,
		]);
		return {
			status: "ok",
			message: `moved block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})`,
			kb: name,
			anchor: echo,
			movedBlockId: blockId,
			...srcTail,
			...destPayload,
		};
	});
}

/** Reason wording for a verifyMoveLanded outcome's not-landed arms — the
 * caller narrows on the verdict (a landed move takes the success path).
 * The judgment lives in the primitives' verifyMoveLanded; these fragments
 * are its wording — each a full sentence, spliced into the move flow's
 * `block '${blockId}' …` frame. */
function moveLandedRefusal(
	outcome: Exclude<MoveBlockLandedOutcome, { kind: "landed" }>,
): string {
	switch (outcome.kind) {
		case "absent-from-destination":
			return "is absent from the destination tree — the transaction rolled back silently behind HTTP success";
		case "landing-unconfirmed":
			return `could not be confirmed landed: the verification walk hit the document's depth bound — ${landedUnconfirmedClause}`;
		case "still-in-source":
			return "is still present in the source tree — the kernel copied rather than moved";
		case "misplaced":
			return outcome.append
				? "is present but not the doc's last top-level block — the transaction silently no-opped behind HTTP success"
				: "is present but not at its landing position after the anchor — the transaction silently no-opped behind HTTP success";
	}
	outcome satisfies never;
}
