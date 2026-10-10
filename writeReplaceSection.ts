// The replace-section flow: enumerate the section from the document-order
// walk → fresh-content precondition → one verified sequence call (the
// primitives own the insert-before-sweep ordering and the enumeration
// timing) → envelope wording. A mid-sequence failure must cost visible
// duplication, never loss — that invariant lives with the sequence now.

import {
	SiYuanKernelError,
	appendAnchorOf,
	backlinkCheck,
	rootEcho,
	sectionOf,
	walkBlockTree,
} from "siyuan-kb-primitives";
import { replaceSectionVerified } from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	markPartialReplace,
	refusedEnvelope,
	type Envelope,
} from "./envelope.js";
import { serveOutlineFromWalk } from "./outline.js";
import {
	echoTail,
	deletedBlocksTail,
	headingInWalk,
	mutationFailure,
	staleHeadingMessage,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, freshContentRefusal } from "./writeResult.js";
import {
	appendAnchorEcho,
	insertLandedRefusal,
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
	const tree = await walkBlockTree(kernel, doc.rootId);
	const resolved = headingInWalk(tree, doc, headingId);
	if ("status" in resolved) return resolved;
	const deleteSet = sectionOf(tree, headingId);
	if (deleteSet.kind === "walk-truncated") {
		// The projection refuses the truncated tree the sequence's own gate
		// would — refuse here, before any kernel call.
		return refusedEnvelope(
			`the document nests past the walk depth bound, so the section enumeration and the insert anchor cannot be derived from complete evidence — replace-section refused before any kernel call; restructure the document (or edit the target block directly) instead`,
			{ kb: name },
		);
	}
	// Unreachable — headingInWalk and sectionOf re-find the heading with
	// the same predicate on the same tree — kept as a fail-closed tripwire.
	if (deleteSet.kind === "heading-absent") {
		return refusedEnvelope(staleHeadingMessage(headingId, doc));
	}
	const section = deleteSet.section;
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
		section.closure.map((b) => ({
			blockId: b.id,
			baselineHash: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// The anchor echo is wording garnish for the failure arms — projected
	// from the section this flow already enumerated, the same projection
	// the sequence derives internally for the mutation.
	const echo = appendAnchorEcho(appendAnchorOf(section));
	const outcome = await replaceSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
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
		return mutationFailure(outcome, input, doc, { anchor: echo });
	}
	if (outcome.kind === "walk-truncated") {
		// The sequence refuses a truncated pre-mutation walk before any
		// kernel call — the enumeration, anchor, and pre-write id set would
		// derive from incomplete evidence.
		return refusedEnvelope(
			`the document nests past the walk depth bound, so the section enumeration and the insert anchor cannot be derived from complete evidence — replace-section refused before any kernel call; restructure the document (or edit the target block directly) instead`,
			{ kb: name, anchor: echo },
		);
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
			case "insert-unlanded": {
				// No echo tail here, unlike append's unlanded refusal: the tail
				// refreshes baselines from a post-write read, and a concurrent
				// change landing between the stale re-check and this walk would
				// be laundered into the baseline (the pinned timeline contract).
				// The refusal wording already carries the evidence that matters
				// — the old section is untouched.
				const unlanded = insertLandedRefusal(outcome.verdict);
				return errorEnvelope(
					`verified-insert failed: ${unlanded} — the old section is untouched`,
					{ kb: name, anchor: appendAnchorEcho(outcome.anchor) },
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
			case "sweep-walk-failed":
				// Every member delete acked but the verification walk itself
				// failed — the sweep is complete but unjudged, so this must
				// never surface as a raw transport error ("SiYuan unreachable")
				// while the whole write is applied. Rethrow inside the
				// finish-write wrapper with the partial state attached: the
				// fully-swept delete set rides as the receipt, nothing remains
				// pending, and the classifier renders verificationFailed.
				if (outcome.error instanceof SiYuanKernelError) {
					markPartialReplace(outcome.error, {
						partialReplace: true,
						newBlockId: outcome.insertedId,
						deletedBlockIds: outcome.deletedBlockIds,
						remainingBlockIds: [],
					});
				}
				throw outcome.error;
			case "sweep-refused": {
				// Any refusal arm carrying a certified post-sweep walk serves
				// it as the inline outline — the recovery evidence the
				// wording used to send the agent to re-fetch — and seeds the
				// baselines from that walk (the snapshot the judgment was
				// rendered from). Derived from the arm's own payload, not its
				// kind, so a future arm carrying a walk serves the outline too;
				// `partial` declares none and stops before its verification
				// walk — no certified snapshot to serve. Deliberately not
				// echoTail: its SQL refresh is a post-walk read that could
				// launder a concurrent change into the baseline on a failure
				// path, and would add a fourth SQL-form seed site (contrast
				// insert-unlanded above; the success path is safe because
				// the write landed). The root echo is addressing info, never a
				// baseline.
				const certifiedWalk =
					"postWalk" in outcome.outcome ? outcome.outcome.postWalk : undefined;
				const refusalCtx = {
					kb: name,
					anchor: appendAnchorEcho(outcome.anchor),
					newBlockId: outcome.insertedId,
					memberIds: outcome.memberIds,
				};
				if (certifiedWalk === undefined) {
					return sweepRefusal(outcome.outcome, refusalCtx);
				}
				const outline = serveOutlineFromWalk(
					sessionId,
					"kb_write",
					certifiedWalk,
					baselines,
				);
				const root = await rootEcho(kernel, input.boxId, doc.rootId);
				return sweepRefusal(outcome.outcome, {
					...refusalCtx,
					tail:
						root === undefined
							? outline
							: {
									...outline,
									docId: root.docId,
									title: root.title,
									hpath: root.hpath,
								},
				});
			}
			case "sweep-truncated":
				// The deletes acked but the post-sweep walk hit the depth
				// bound: the swept judgment's absence facts are unconfirmed.
				// Applied-but-unverified — never ok, never a rollback.
				return errorEnvelope(
					`replace applied but unverified: the replacement (block '${outcome.insertedId}') is in place and every member delete acked, but the verification walk hit the document's depth bound — whether the old section is fully gone could not be confirmed. Do NOT re-run; re-fetch the outline (kb_read) and check the old section's blocks by id before any cleanup`,
					{
						kb: name,
						anchor: appendAnchorEcho(outcome.anchor),
						newBlockId: outcome.insertedId,
					},
				);
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
					invalidRefs,
					...deletedBlocksTail(sessionId, outcome.closure),
					...tail,
				};
			}
		}
		outcome satisfies never;
		return errorEnvelope("internal: unhandled replace-section verdict");
	});
}
