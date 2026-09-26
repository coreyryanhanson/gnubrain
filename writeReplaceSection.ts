// The replace-section flow: enumerate the section (members + closure) from
// the document-order walk → fresh-content precondition → insert-before-
// delete in one call, verified against the post-write tree — a mid-sequence
// failure must cost visible duplication, never loss.

import {
	SiYuanKernelError,
	backlinkCheck,
	walkBlockTree,
} from "siyuan-kb-primitives";
import {
	deriveAppendAnchor,
	idSet,
	insertVerified,
	sectionOf,
	sweepSectionMembers,
} from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	markPartialReplace,
	refusedEnvelope,
	type Envelope,
} from "./envelope.js";
import {
	echoTail,
	deletedBlocksTail,
	headingInWalk,
	errorTail,
	staleHeadingMessage,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, freshContentRefusal } from "./writeResult.js";
import {
	appendAnchorEcho,
	insertLandedRefusal,
	mutationFailureEnvelope,
	sweepRefusal,
} from "./writeVerdicts.js";

export async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Delete-set enumeration rides the document-order walk, never SQL.
	const walk = await walkBlockTree(kernel, doc.rootId);
	const heading = headingInWalk(walk, doc, headingId);
	if ("status" in heading) return heading;
	const deleteSet = sectionOf(walk, headingId);
	// Unreachable against the current wiring — headingInWalk and sectionOf
	// re-find the heading with the same predicate on the same walk — kept
	// as a fail-closed tripwire if those two lookups ever drift apart.
	if (deleteSet === undefined) {
		return refusedEnvelope(staleHeadingMessage(headingId, doc));
	}
	// The anchor is a sibling of the target (the boundary) or the target's
	// container — never inside a member's subtree, so the insert can never
	// land inside a block the sweep deletes (the kernel's cascade would
	// consume the replacement and the heading itself).
	const anchor = deriveAppendAnchor(walk, heading);
	const echo = appendAnchorEcho(anchor);
	// Fresh-content precondition: a concurrency guard, not a consent
	// mechanism (the grant resolved at the kb_write entry). One wrapper step
	// right before the kernel call — the judgment seeds missing baselines
	// from the SQL index and checks against the live tree in one pass (the
	// dialog's display → approval window no longer exists, so a change
	// landing since the walk is caught as stale_content, not laundered into
	// the baseline).
	const stale = await freshContentRefusal(
		kernel,
		baselines,
		deleteSet.closure.map((b) => ({
			blockId: b.id,
			baselineHash: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// insert-before-delete: a mid-sequence failure must cost visible
	// duplication, never loss. Same anchor rule as `append`. The verified
	// insert is the first mutation — a synchronous kernel rejection here is
	// NOT a partial replace; it surfaces verbatim with the fresh outline
	// attached. Transport classes carry the unverified verdict — the insert
	// may have landed even though no tx came back.
	const outcome = await insertVerified(kernel, input.probe, {
		anchor,
		body: input.body,
		rootId: doc.rootId,
		preIds: idSet(walk),
	});
	if (outcome.kind !== "judged") {
		return mutationFailureEnvelope(outcome, {
			kb: name,
			extra: { anchor: echo },
			tail: () => errorTail(input, doc),
		});
	}
	// Everything from here on is post-mutation — a drop anywhere in the
	// delete sweep or the echo must never read as "unreachable" while the
	// insert has landed and the sweep may be half-applied (finishWrite
	// doc). The verdict's postWalk IS the post-insert tree — reused below,
	// never re-traversed.
	return finishWrite(name, { anchor: echo }, async () => {
		if (outcome.verdict.kind !== "landed") {
			// No echo tail here, unlike append's rollback refusal: writeEchoTail
			// refreshes baselines from a post-write read, and a concurrent
			// change landing between the stale re-check and this walk would be
			// laundered into the baseline (the pinned timeline contract). The
			// refusal wording already carries the evidence that matters — the
			// old section is untouched.
			const rollback = insertLandedRefusal(outcome.verdict);
			return errorEnvelope(
				`verified-insert failed: ${rollback} — the transaction rolled back silently behind HTTP success; the old section is untouched`,
				{ kb: name, anchor: echo },
			);
		}
		// The kernel-returned id is present in the post-write tree (the landed
		// arm guarantees it), so the partial-apply evidence can name it.
		const landedId = outcome.verdict.blockId;
		// The verified delete sweep, whole: the pre-enumerated members in
		// document order (a post-insert re-enumeration would sweep the
		// replacement into the delete set), the post-sweep judgment, and the
		// post-sweep walk as the verdict's evidence — the echo tail below
		// reuses it, never re-traverses. The members are siblings, so each is
		// already a forest root: the kernel's cascade removes a container
		// member's descendants with it, and sweeping those explicitly would
		// error (tree not found) behind a fully-successful replace.
		const memberIds = deleteSet.members.map((b) => b.id);
		const sweep = await sweepSectionMembers(kernel, {
			rootId: doc.rootId,
			memberIds,
			newBlockId: landedId,
		});
		if (sweep.kind === "interrupted") {
			// Transport-class failures (429, auth, network, timeout) have their
			// own classification paths — 429/auth flow to runKbCall
			// (cooldown/breaker), network/timeout land in finishWrite
			// (verificationFailed). The insert has landed and part of the old
			// section may be swept, so the partial state rides the error for
			// the catch sites to merge into whatever envelope the classifier
			// produces. Non-kernel error classes rethrow unmarked, as before.
			if (sweep.error instanceof SiYuanKernelError) {
				markPartialReplace(sweep.error, {
					partialReplace: true,
					newBlockId: landedId,
					deletedBlockIds: sweep.deletedBlockIds,
					remainingBlockIds: sweep.remainingBlockIds,
				});
			}
			throw sweep.error;
		}
		if (sweep.kind !== "swept")
			return sweepRefusal(sweep, {
				kb: name,
				anchor: echo,
				newBlockId: landedId,
				memberIds,
			});
		// invalidRefs: post-write echo over the section's closure — what
		// actually got orphaned, verified.
		const invalidRefs = await backlinkCheck(
			kernel,
			deleteSet.closure.map((b) => b.id),
		);
		// The echo tail must reflect the tree AFTER the deletes: the verdict's
		// postWalk IS that tree — reused, not re-traversed.
		const tail = await echoTail(input, doc, sweep.postWalk, [landedId]);
		return {
			status: "ok",
			// The closure is what left the doc — the members the sweep deleted
			// explicitly plus the descendants their cascade removed. The
			// receipt itemizes it (ids + walk content) — the post-write
			// visibility the pre-write grant dialog does not carry.
			message: `replaced the section under heading '${heading.content}' in '${doc.title}' (KB ${name}) — delete set ${deleteSet.closure.length} block(s), ${invalidRefs.count} doc(s) with orphaned refs`,
			kb: name,
			anchor: echo,
			newBlockId: landedId,
			invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
			...deletedBlocksTail(sessionId, deleteSet.closure),
			...tail,
		};
	});
}
