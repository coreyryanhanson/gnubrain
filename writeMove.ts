// The move flow: block-level moveBlock with tool-derived anchors
// (self-anchor / self-descendant no-ops refused) or doc-level moveDocsByID
// (destination doc or notebook root). Every landing is verified against the
// post-move walk sets — position for same-doc moves, membership cross-doc.

import { SiYuanApiError } from "siyuan-kernel-api";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { sqlString } from "./kernel.js";
import { deriveMoveAnchor, landingId } from "./writeAnchors.js";
import {
	renderOutlineFromWalk,
	walkBlockTree,
	type WalkedBlock,
} from "./walk.js";
import {
	confirmGate,
	echoTail,
	headingInWalk,
	PARENT_DOC_STMT_HEAD,
	resolveDocTarget,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, idSet } from "./writeResult.js";
import type { WriteKernelClient } from "./kernel.js";

/** A nested doc's parent doc id (type='d' rows chain via parent_id) — the
 * doc-level self-descendant pre-check walks this. */
function parentDocStmt(docId: string): string {
	return `${PARENT_DOC_STMT_HEAD} WHERE id = ${sqlString(docId)} AND type = 'd'`;
}

/** doc-level self-descendant pre-check: walk the destination's ancestor
 * chain over type='d' rows; the source appearing means the destination is
 * the source or one of its nested descendants — the kernel silently filters
 * exactly that move (success, zero moves). Rejected here, never forwarded.
 * ponytail: assumes nested docs chain via parent_id on 'd' rows; if a
 * kernel change breaks the chain only the direct self-move is caught —
 * tighten the chain walk if the integration suite catches a nested case. */
async function isOwnDescendant(
	kernel: WriteKernelClient,
	sourceRootId: string,
	destId: string,
): Promise<boolean> {
	let current: string | undefined = destId;
	for (
		let hops = 0;
		current !== undefined && current !== "" && hops < 16;
		hops++
	) {
		if (current === sourceRootId) return true;
		const rows = await kernel.query(parentDocStmt(current));
		const parent =
			rows[0] === undefined ? undefined : String(rows[0].parent_id ?? "");
		current = parent === "" || parent === current ? undefined : parent;
	}
	return false;
}

/** Cross-doc block move's `destOutline`: fresh
 * destination outline fetched after the move lands. The walk's heading rows
 * are served content — seed the baselines so a follow-up edit on a served
 * destination heading verifies against what the agent saw here, not against
 * content read at edit time (which launders a concurrent kernel-side change
 * past the stale_content precondition). */
async function destOutlinePayload(
	input: WriteFlowInput,
	sessionId: string,
	destWalk: WalkedBlock[],
): Promise<Record<string, unknown>> {
	const outline = renderOutlineFromWalk(
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
		if (await isOwnDescendant(kernel, doc.rootId, destId)) {
			return refusedEnvelope(
				`destination ${destLabel} is inside doc '${doc.title}''s own subtree — the kernel silently filters such moves; choose a destination outside the subtree`,
			);
		}
		const summary = `Move doc '${doc.title}' (${doc.rootId}) to ${destLabel} (KB ${name})`;
		const gate = await confirmGate(input, summary);
		if (gate !== null) return gate;
		try {
			await kernel.moveDocsByID({ fromIDs: [doc.rootId], toID: destId });
		} catch (err) {
			// The 7-level depth cap and other kernel rejections surface
			// verbatim (doc-level record).
			if (!(err instanceof SiYuanApiError)) throw err;
			return errorEnvelope(err.message, { kb: name, docId: doc.rootId });
		}
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the move may already be applied (finishWrite doc).
		return finishWrite(name, {}, async () => {
			const tail = await echoTail(input, doc);
			// Pinned shape: outline + title/hpath echo, no anchor/newBlockId/
			// destOutline (doc-level record).
			return {
				status: "ok",
				message: `moved doc '${doc.title}' to ${destLabel} (KB ${name})`,
				kb: name,
				...tail,
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
	// Anchor: tool-derived, never agent-supplied.
	const anchor = deriveMoveAnchor(destWalk, params.toHeadingId);
	// Self-anchor no-op (mirrors the doc-level own-parent case): a block
	// that already sits in the destination position refuses — the kernel
	// no-ops (or re-parents nothing) while the walk-set check would
	// misreport a successful move. The self-anchor clause covers "move the
	// anchor block itself"; `landingId` covers "the landing position is
	// already occupied" (kernel placement: next sibling of the anchor's
	// subtree end / last top-level for doc end).
	const alreadyAtDest =
		(anchor.kind === "move" && anchor.previousID === blockId) ||
		landingId(destWalk, anchor) === blockId;
	if (sameDoc && alreadyAtDest) {
		return refusedEnvelope(
			`block '${blockId}' already sits at the destination position — nothing to move`,
		);
	}
	const summary = `Move block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	const gate = await confirmGate(input, summary);
	if (gate !== null) return gate;
	try {
		if (anchor.kind === "appendRoot") {
			await kernel.moveBlock({ id: blockId, parentID: dest.rootId });
		} else {
			await kernel.moveBlock({ id: blockId, previousID: anchor.previousID });
		}
	} catch (err) {
		// moveBlock's blocktree index check rejects a
		// missing source/anchor synchronously — surface verbatim with the
		// fresh outline attached. Network classes rethrow for runKbCall's
		// unreachable classification — correct here, the move did not land.
		if (!(err instanceof SiYuanApiError)) throw err;
		const tail = await echoTail(input, doc);
		return errorEnvelope(err.message, {
			kb: name,
			anchor: anchor.anchor,
			...tail,
		});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the move may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// Verified, not trusted: a tree-level miss rolls back silently
		// behind HTTP success — movedBlockId must appear in the destination's
		// post-move walk set (and, cross-doc, be gone from the source's).
		const postSourceWalk = await walkBlockTree(kernel, doc.rootId);
		const postDestWalk = sameDoc
			? postSourceWalk
			: await walkBlockTree(kernel, dest.rootId);
		// Same-doc `move` verifies POSITION, not presence: the block was
		// already in this walk before the move, so set membership cannot
		// distinguish "landed" from a silent kernel no-op behind HTTP success
		// (e.g. a stale anchor after a concurrent edit). Position = the
		// anchor's `landingId` in the post-move walk — undefined there means
		// the landing position is EMPTY (the anchor's subtree ends the walk),
		// a verified miss. Only a vanished anchor (concurrent delete) makes
		// the position unverifiable — fall back to presence rather than
		// false-failing on a check that can no longer run.
		const anchorPresent =
			anchor.kind === "appendRoot" ||
			postSourceWalk.some((b) => b.id === anchor.previousID);
		// Same-doc with a present anchor: position. Otherwise (cross-doc, or
		// a vanished anchor — the walk IS the same-doc destination) block IDs
		// are globally unique, so membership discriminates.
		const movedInDest =
			sameDoc && anchorPresent
				? landingId(postSourceWalk, anchor) === blockId
				: idSet(postDestWalk).has(blockId);
		const movedGoneFromSource = sameDoc || !idSet(postSourceWalk).has(blockId);
		const destPayload = sameDoc
			? {}
			: await destOutlinePayload(input, sessionId, postDestWalk);
		if (!movedInDest || !movedGoneFromSource) {
			// The move did not land — refresh nothing (the failure tail must
			// not launder a concurrent change past the precondition).
			const srcTail = await echoTail(input, doc, postSourceWalk);
			const postDestIds = idSet(postDestWalk);
			let why = "still present in the source tree";
			if (!postDestIds.has(blockId)) why = "absent from the destination tree";
			else if (sameDoc && !movedInDest)
				why =
					anchor.kind === "appendRoot"
						? "present but not the doc's last top-level block"
						: "present but not at its landing position after the anchor";
			return errorEnvelope(
				`verified-move failed: block '${blockId}' is ${why} — the transaction rolled back silently behind HTTP success`,
				{
					kb: name,
					anchor: anchor.anchor,
					...srcTail,
					...destPayload,
				},
			);
		}
		// The move landed — movedBlockId is what the result carried, so its
		// baseline refresh rides this path only (the failure path above
		// refreshes nothing).
		const srcTail = await echoTail(input, doc, postSourceWalk, [blockId]);
		return {
			status: "ok",
			message: `moved block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})`,
			kb: name,
			anchor: anchor.anchor,
			movedBlockId: blockId,
			...srcTail,
			...destPayload,
		};
	});
}
