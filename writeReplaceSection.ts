// The replace-section flow: enumerate the section from the document-order
// walk → fresh-content precondition → one verified sequence call (the
// primitives own the insert-before-sweep ordering and the enumeration
// timing) → envelope wording. A mid-sequence failure must cost visible
// duplication, never loss — that invariant lives with the sequence now.

import {
	SiYuanKernelError,
	backlinkCheck,
	walkBlockTree,
} from "siyuan-kb-primitives";
import {
	deriveAppendAnchor,
	replaceSectionVerified,
	sectionOf,
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
	// Target resolution rides the document-order walk, never SQL. The
	// sectionOf call is the closure the fresh-content precondition reads —
	// session baselines cannot cross into the primitives, so the flow
	// derives it too; the sequence re-derives the identical section
	// internally from this same walk.
	const walk = await walkBlockTree(kernel, doc.rootId);
	const heading = headingInWalk(walk, doc, headingId);
	if ("status" in heading) return heading;
	const deleteSet = sectionOf(walk, headingId);
	// Unreachable — headingInWalk and sectionOf re-find the heading with
	// the same predicate on the same walk — kept as a fail-closed tripwire.
	if (deleteSet === undefined) {
		return refusedEnvelope(staleHeadingMessage(headingId, doc));
	}
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
	// The anchor echo is wording garnish for the failure arms — the same
	// pure projection the sequence derives internally for the mutation
	// (identical inputs, identical output).
	const echo = appendAnchorEcho(deriveAppendAnchor(walk, heading));
	const outcome = await replaceSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk,
		headingId,
		body: input.body,
	});
	// The insert leg's pre-judgment failure ladder — no mutation has landed,
	// so these map outside the finish-write wrapper.
	if (
		outcome.kind === "drift" ||
		outcome.kind === "transport-unverified" ||
		outcome.kind === "kernel-refused" ||
		outcome.kind === "verification-failed"
	) {
		return mutationFailureEnvelope(outcome, {
			kb: name,
			extra: { anchor: echo },
			tail: () => errorTail(input, doc),
		});
	}
	if (outcome.kind === "no-section") {
		// Unreachable — the sequence re-derives the same section from the
		// same walk this flow just resolved. Fail-closed tripwire.
		return refusedEnvelope(staleHeadingMessage(headingId, doc));
	}
	// Everything from here on is post-mutation — a drop anywhere in the
	// delete sweep or the echo must never read as "unreachable" while the
	// insert has landed and the sweep may be half-applied (finishWrite
	// doc). The interrupted sweep arm throws its error from in here so the
	// wrapper's classifier renders verificationFailed with the partial
	// state merged.
	return finishWrite(name, { anchor: echo }, async () => {
		switch (outcome.kind) {
			case "insert-rolled-back": {
				// No echo tail here, unlike append's rollback refusal: the tail
				// refreshes baselines from a post-write read, and a concurrent
				// change landing between the stale re-check and this walk would
				// be laundered into the baseline (the pinned timeline contract).
				// The refusal wording already carries the evidence that matters
				// — the old section is untouched.
				const rollback = insertLandedRefusal(outcome.verdict);
				return errorEnvelope(
					`verified-insert failed: ${rollback} — the transaction rolled back silently behind HTTP success; the old section is untouched`,
					{ kb: name, anchor: echo },
				);
			}
			case "sweep-interrupted":
				// Transport-class failures (429, auth, network, timeout) have
				// their own classification paths — 429/auth flow to runKbCall
				// (cooldown/breaker), network/timeout land in finishWrite
				// (verificationFailed). The insert has landed and part of the
				// old section may be swept, so the partial state rides the
				// error for the catch sites to merge into whatever envelope the
				// classifier produces. Non-kernel error classes rethrow
				// unmarked, as before.
				if (outcome.error instanceof SiYuanKernelError) {
					markPartialReplace(outcome.error, {
						partialReplace: true,
						newBlockId: outcome.insertedId,
						deletedBlockIds: outcome.deletedBlockIds,
						remainingBlockIds: outcome.remainingBlockIds,
					});
				}
				throw outcome.error;
			case "sweep-refused":
				return sweepRefusal(outcome.outcome, {
					kb: name,
					anchor: echo,
					newBlockId: outcome.insertedId,
					memberIds: outcome.memberIds,
				});
			case "swept": {
				// invalidRefs: post-write echo over the section's closure —
				// what actually got orphaned, verified.
				const invalidRefs = await backlinkCheck(
					kernel,
					outcome.closure.map((b) => b.id),
				);
				// The echo tail reflects the tree AFTER the deletes: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, outcome.postWalk, [
					outcome.insertedId,
				]);
				return {
					status: "ok",
					// The closure is what left the doc — the members the sweep
					// deleted explicitly plus the descendants their cascade
					// removed. The receipt itemizes it (ids + walk content) —
					// the post-write visibility the pre-write grant dialog
					// does not carry.
					message: `replaced the section under heading '${outcome.headingContent}' in '${doc.title}' (KB ${name}) — delete set ${outcome.closure.length} block(s), ${invalidRefs.count} doc(s) with orphaned refs`,
					kb: name,
					anchor: appendAnchorEcho(outcome.anchor),
					newBlockId: outcome.insertedId,
					invalidRefs: {
						count: invalidRefs.count,
						hpaths: invalidRefs.hpaths,
					},
					...deletedBlocksTail(sessionId, outcome.closure),
					...tail,
				};
			}
		}
		outcome satisfies never;
		return errorEnvelope("internal: unhandled replace-section verdict");
	});
}
