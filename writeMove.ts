// The move flow: block-level moves ride the primitives' moveBlockVerified
// (mutation, post-move walks, landed judgment — one call, one snapshot;
// the pre-mutation refusals are all verdict arms of that call, framed
// here from writeVerdicts' wording fragments); doc-level moves ride
// moveDocVerified (mutation, live-tree hpath judgment — the moved doc's
// echo hpath IS the verdict's evidence). Doc-target resolution stays
// tool-side.

import {
	errorEnvelope,
	refusedEnvelope,
	STALE_TARGET_GUIDANCE,
	type Envelope,
} from "./envelope.js";
import {
	deriveMoveAnchor,
	walkBlockTree,
	type WalkedTree,
} from "siyuan-kb-primitives";
import {
	moveBlockVerified,
	moveDocVerified,
	type MoveBlockOutcome,
	type MoveDocLandedOutcome,
	type MoveDocOutcome,
} from "siyuan-kb-primitives/write";
import { serveOutlineFromWalk } from "./outline.js";
import { echoTail, mutationFailure } from "./writeEcho.js";
import {
	headingInWalk,
	resolveDocTarget,
	staleHeadingMessage,
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import {
	moveAnchorEcho,
	moveLandedRefusal,
	moveWalkTruncatedMessage,
	mutationFailureEnvelope,
} from "./writeVerdicts.js";

/** The verified block move's pre-mutation refusal frame — the wording
 * home for moveBlockVerified's pre-mutation refusal arms (the primitives
 * judge the kernel facts; this repo words them): the placement pair
 * already-at-destination / own-subtree, the two fold-blind heading arms
 * (target and move anchor), the not-in-source scoping arm (the kernel
 * mutates by raw block id with no doc scoping of its own), and
 * walk-truncated (incomplete pre-move walk). All refuse before the
 * mutation. */
function movePlacementRefusalEnvelope(
	outcome: Extract<
		MoveBlockOutcome,
		{
			kind:
				| "already-at-destination"
				| "own-subtree"
				| "not-in-source"
				| "heading-with-section"
				| "heading-anchor-with-section"
				| "walk-truncated";
		}
	>,
	doc: { title: string; rootId: string },
): Envelope {
	switch (outcome.kind) {
		case "walk-truncated":
			return refusedEnvelope(moveWalkTruncatedMessage);
		case "heading-anchor-with-section":
			return refusedEnvelope(
				`cannot move to anchor '${outcome.anchorId}' — the anchor is a heading with a section body, and the kernel can land the move after that anchor's whole section instead of directly after it (the redirect depends on the anchor's fold state), so the anchor is refused instead of resolved from hidden state. The destination changed between the anchor's derivation and the move — re-issue the move to re-derive the anchor, or use append for section-start placement`,
			);
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
		case "heading-with-section":
			return refusedEnvelope(
				`cannot move block '${outcome.blockId}' — it is a heading with a section body (${outcome.memberIds.length} block(s) under it); the kernel's move scope for such a heading depends on its fold state (folded, the whole section travels with it; unfolded, the heading moves alone and the body is left behind), so the move is refused instead of resolved from hidden state. Move the body blocks individually against a derived section-end anchor, or use append for section-start placement`,
			);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled move placement arm");
}

/** The `judged` leg of the doc-move flow — the not-landed sentence, or
 * undefined when the move landed (the success path takes over). The tree's
 * hpath is the judgment's only evidence, so the sentence reports what the
 * tree shows and claims no mechanism (an observed hpath off the destination
 * could be a rollback or a landing elsewhere; only the block-level
 * judgment's reason ladder can tell those apart). */
function moveDocJudgmentRefusalEnvelope(
	verdict: MoveDocLandedOutcome,
	ctx: { name: string; docId: string; title: string },
): Envelope | undefined {
	switch (verdict.kind) {
		case "landed":
			return undefined;
		case "not-landed":
			return errorEnvelope(
				`verified-move failed: doc '${ctx.title}' did not land at the destination — the tree reports hpath '${verdict.hpath}'`,
				{ kb: ctx.name, docId: ctx.docId },
			);
	}
	verdict satisfies never;
	return undefined;
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

/** Cross-doc block move's `destOutline`: the destination outline served
 * from the verified move's post-move walk (the judgment's own evidence —
 * consumed verbatim, never re-fetched). The walk's heading rows are served
 * content — seed the baselines from the serve, per the anti-laundering
 * invariant (baselines.ts). */
async function destOutlinePayload(
	input: WriteFlowInput,
	destWalk: WalkedTree,
): Promise<Record<string, unknown>> {
	const outline = serveOutlineFromWalk(
		input.sessionId,
		"kb_write-dest",
		destWalk,
		input.baselines,
	);
	return outline.fullOutlinePath === undefined
		? { destOutline: outline.outline }
		: {
				destOutline: outline.outline,
				destFullOutlinePath: outline.fullOutlinePath,
			};
}

export async function runMoveMode(
	input: WriteFlowInput,
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
		// The doc-level verdict frames (scoping, shared ladder, not-landed
		// judgment) live with the flow — the words come from writeVerdicts.
		// The doc-level record carries no echo tail on any failure
		// leg (the pinned shape — the doc move runs with no doc target), so
		// the tail is empty.
		// The pre-mutation scoping refusal (the blocks index names no row for
		// the moved doc) words beside the MutationFailure ladder.
		if (outcome.kind === "not-in-source") {
			return moveDocScopingRefusalEnvelope(outcome, { name });
		}
		if (outcome.kind !== "judged") {
			return mutationFailureEnvelope(outcome, {
				kb: name,
				extra: { docId: doc.rootId },
				tail: async () => ({}),
			});
		}
		const failed = moveDocJudgmentRefusalEnvelope(outcome.verdict, {
			name,
			docId: doc.rootId,
			title: doc.title,
		});
		if (failed !== undefined) return failed;
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
	const blockId = params.blockId as string;
	const dest = await resolveDocTarget(
		kernel,
		boxId,
		name,
		params.toDocId as string,
	);
	if ("status" in dest) return dest;
	const sameDoc = dest.rootId === doc.rootId;
	// Destination outline: cross-doc fetches the destination walk; same-doc
	// derives from the source walk — no extra call. Cross-doc the flow
	// holds no source walk: the foreign-blockId scoping refusal rides the
	// verified move's pre-mutation arm (the kernel mutates by raw block id
	// with no doc scoping of its own — the same fact blockInDoc refuses
	// foreign on), and that primitive fetches the source walk itself.
	const sourceWalk = sameDoc
		? await walkBlockTree(kernel, doc.rootId)
		: undefined;
	const destWalk = sourceWalk ?? (await walkBlockTree(kernel, dest.rootId));
	if (params.toHeadingId !== undefined) {
		const heading = headingInWalk(destWalk, dest, params.toHeadingId);
		if ("status" in heading) return heading;
	}
	// Anchor: tool-derived, never agent-supplied. The placement refusals
	// (self-anchor no-op, own-subtree ancestor — kernel behaviors the
	// primitives own) ride the verified move as closed arms, judged against
	// this pre-move walk; their frame lives above. Inline narrowing: a new
	// primitives arm fails typecheck here; heading-absent is a fail-closed
	// tripwire (headingInWalk refused on this walk).
	const anchor = deriveMoveAnchor(destWalk, params.toHeadingId);
	if (anchor.kind === "walk-truncated") {
		return movePlacementRefusalEnvelope(anchor, doc);
	}
	if (anchor.kind === "heading-absent") {
		return refusedEnvelope(
			staleHeadingMessage(params.toHeadingId as string, dest),
			{ kb: name },
		);
	}
	const echo = moveAnchorEcho(anchor);
	const outcome = await moveBlockVerified(kernel, input.probe, {
		blockId,
		anchor,
		rootId: doc.rootId,
		destRootId: dest.rootId,
		// The walk in hand is the pre-move tree — same-doc it doubles as the
		// source walk and feeds the placement refusals; cross-doc the flow
		// holds no pre-walk and the primitive fetches its own walks (the
		// source for scoping/target, the destination for a move anchor's
		// anchor-arm read — the placement refusals still cannot fire
		// cross-doc).
		...(sameDoc
			? { sameDoc: true, preDestWalk: destWalk }
			: { sameDoc: false }),
	});
	if (
		outcome.kind === "already-at-destination" ||
		outcome.kind === "own-subtree" ||
		outcome.kind === "not-in-source" ||
		outcome.kind === "heading-with-section" ||
		outcome.kind === "heading-anchor-with-section" ||
		outcome.kind === "walk-truncated"
	) {
		return movePlacementRefusalEnvelope(outcome, doc);
	}
	if (outcome.kind === "heading-absent") {
		// Unreachable through moveBlockVerified: the flow derives the anchor
		// above and words its refusal there — the arm rides the union for
		// the widened dispatch entry, worded here with the same
		// stale-heading sentence.
		return refusedEnvelope(
			staleHeadingMessage(params.toHeadingId as string, dest),
			{ kb: name },
		);
	}
	if (outcome.kind !== "judged") {
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
