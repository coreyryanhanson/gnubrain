// The move flow: block-level moves ride the primitives' moveBlockVerified
// (mutation, post-move walks, landed judgment — one call, one snapshot;
// the placement refusals — self-anchor no-op, own-subtree ancestor — are
// pre-mutation verdict arms of that call, worded in writeVerdicts); doc-level
// moves ride moveDocVerified (mutation, live-tree hpath judgment — the moved
// doc's echo hpath IS the verdict's evidence). Tool-surface scoping stays
// here.

import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	deriveMoveAnchor,
	moveBlockVerified,
	moveDocVerified,
} from "siyuan-kb-primitives/write";
import { serveOutlineFromWalk } from "./outline.js";
import { walkBlockTree, type WalkedBlock } from "siyuan-kb-primitives";
import {
	echoTail,
	headingInWalk,
	resolveDocTarget,
	errorTail,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite } from "./writeResult.js";
import {
	moveAnchorEcho,
	moveDocJudgmentRefusal,
	moveDocVerdictEnvelope,
	moveLandedRefusal,
	movePlacementRefusal,
	mutationFailureEnvelope,
} from "./writeVerdicts.js";

/** Cross-doc block move's `destOutline`: the destination outline served
 * from the verified move's post-move walk (the judgment's own evidence —
 * consumed verbatim, never re-fetched). The walk's heading rows are served
 * content — seed the baselines so a follow-up edit on a served destination
 * heading verifies against what the agent saw here, not against content
 * read at edit time (which launders a concurrent kernel-side change past
 * the stale_content precondition). */
async function destOutlinePayload(
	input: WriteFlowInput,
	sessionId: string,
	destWalk: WalkedBlock[],
): Promise<Record<string, unknown>> {
	const outline = serveOutlineFromWalk(
		sessionId,
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
	const { kernel, sessionId, name, boxId, params } = input;
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
		if (destId === doc.rootId) {
			return refusedEnvelope(
				`cannot move doc '${doc.title}' (${doc.rootId}) into itself — choose a destination outside the doc's own subtree`,
			);
		}
		// The verified doc-level move: the mutation and the live-tree hpath
		// judgment are one primitive call. The self-target case is pre-checked
		// above (a zero-kernel-call identity check); the 7-level depth cap and
		// ancestor moves reject synchronously kernel-side and surface verbatim
		// (the kernel-refused arm).
		const outcome = await moveDocVerified(kernel, input.probe, {
			docId: doc.rootId,
			title: doc.title,
			boxId,
			destRootId: destId === boxId ? undefined : destId,
		});
		// The outcome→envelope map lives in writeVerdicts (the exhaustive
		// wording home for every primitives union, the createVerdictEnvelope
		// pattern).
		if (outcome.kind !== "judged") {
			return moveDocVerdictEnvelope(outcome, { name, docId: doc.rootId });
		}
		const failed = moveDocJudgmentRefusal(outcome.verdict, {
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
	// Destination outline: cross-doc fetches the destination walk;
	// same-doc derives from the already-in-hand source walk — no extra call.
	const sourceWalk = await walkBlockTree(kernel, doc.rootId);
	// Doc scoping: the kernel mutates by raw block id with no doc scoping of
	// its own, so a foreign id (another doc or KB) would move a block the
	// user never saw into the destination and read as success. The walk is
	// already in hand — membership is the scoping check.
	if (!sourceWalk.some((b) => b.id === blockId)) {
		return refusedEnvelope(
			`blockId '${blockId}' is not a block of source doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
		);
	}
	const destWalk = sameDoc
		? sourceWalk
		: await walkBlockTree(kernel, dest.rootId);
	if (params.toHeadingId !== undefined) {
		const heading = headingInWalk(destWalk, dest, params.toHeadingId);
		if ("status" in heading) return heading;
	}
	// Anchor: tool-derived, never agent-supplied. The placement refusals
	// (self-anchor no-op, own-subtree ancestor — kernel behaviors the
	// primitives own) ride the verified move as closed arms, judged against
	// this pre-move walk; their wording lives in writeVerdicts.
	const anchor = deriveMoveAnchor(destWalk, params.toHeadingId);
	const echo = moveAnchorEcho(anchor);
	const outcome = await moveBlockVerified(kernel, input.probe, {
		blockId,
		anchor,
		sameDoc,
		rootId: doc.rootId,
		destRootId: dest.rootId,
		// The walk in hand is the pre-move tree — the placement refusals
		// judge position against it (same-doc it doubles as the source walk).
		preDestWalk: destWalk,
	});
	if (
		outcome.kind === "already-at-destination" ||
		outcome.kind === "own-subtree"
	) {
		return movePlacementRefusal(outcome);
	}
	switch (outcome.kind) {
		case "drift":
		case "transport-unverified":
		case "kernel-refused":
		case "verification-failed":
			return mutationFailureEnvelope(outcome, {
				kb: name,
				extra: { anchor: echo },
				tail: () => errorTail(input, doc),
			});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the move may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: echo }, async () => {
		// The verified move's outcome carries its evidence: the post-move
		// walks are the judgment's snapshot — the tails below consume them
		// verbatim instead of re-fetching between "verified" and "served".
		const destPayload = sameDoc
			? {}
			: await destOutlinePayload(input, sessionId, outcome.postDestWalk);
		if (outcome.verdict.kind !== "landed") {
			// The move did not land — refresh nothing (the failure tail must
			// not launder a concurrent change past the precondition).
			const srcTail = await echoTail(input, doc, outcome.postSourceWalk);
			return errorEnvelope(
				`verified-move failed: block '${blockId}' is ${moveLandedRefusal(outcome.verdict)} — the transaction rolled back silently behind HTTP success`,
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
