// The delete-section flow: enumerate the section from the document-order
// walk → fresh-content precondition over the whole delete set → one
// verified sequence call (the primitives own the per-id delete ordering
// and the first-mutation phase rule) → envelope wording. A mid-sequence
// failure must cost visible, itemized loss — the receipt names the acked
// set (unverified) and what remains, never an ok.

import {
	backlinkCheck,
	partitionByAbsence,
	sectionOf,
	walkBlockTree,
} from "siyuan-kb-primitives";
import { deleteSectionVerified } from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	partialApplyMarker,
	refusedEnvelope,
	type Envelope,
} from "./envelope.js";
import {
	deletedBlocksTail,
	echoTail,
	mutationFailure,
	rethrowClassified,
} from "./writeEcho.js";
import {
	anchorRefusal,
	type DocTarget,
	type WriteFlowInput,
} from "./writeTarget.js";
import { freshContentRefusal } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	blockInDocRefusalKind,
	deleteSectionWalkTruncatedMessage,
	sweepMembersSurvivedFields,
	sweepMembersSurvivedMessage,
} from "./writeVerdicts.js";

export async function runDeleteSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Resolves through `sectionOf` alone, never `headingInWalk`: its
	// `untargetable` arm models the kernel's insert/append write-parent set
	// only — see the primitives' `deleteSection.ts` docstring.
	const tree = await walkBlockTree(kernel, doc.rootId);
	const section = sectionOf(tree, headingId);
	// Inline narrowing: the fail-closed arms word in anchorRefusal
	// (writeTarget.ts).
	if (section.kind === "walk-truncated" || section.kind === "heading-absent") {
		return anchorRefusal(
			section.kind,
			doc,
			headingId,
			name,
			deleteSectionWalkTruncatedMessage,
		);
	}
	// Fresh-content precondition over the WHOLE delete set — the closure
	// plus the heading (the replace-section precedent: the cascade makes
	// the descendants part of what is at stake), while the issued deletes
	// stay members + the heading (the cascade fact). Guarded like the
	// block-delete path, deliberately: the agent's intent is the section's
	// content, and the members are enumerated by the walk, never named by
	// the agent. Baselines seed from heading rows only, so a member
	// refuses only within the SQL-index divergence window or when the
	// session explicitly holds a member baseline — an out-of-window
	// member edit rides `unseen` adoption, never a refusal.
	const { refusal } = await freshContentRefusal(
		kernel,
		baselines,
		[
			{
				blockId: section.section.heading.id,
				baselineHash: baselines.servedHash(section.section.heading.id),
			},
			...section.section.closure.map((b) => ({
				blockId: b.id,
				baselineHash: baselines.servedHash(b.id),
			})),
		],
		{ sessionId, docId: doc.rootId },
	);
	if (refusal !== null) return refusal;
	// The whole removal — what the receipt itemizes (the members the sweep
	// deletes explicitly, the descendants their cascade takes, and the
	// heading itself), in the delete set's own order: members first, the
	// heading last.
	const deleteSet = [...section.section.closure, section.section.heading];
	const outcome = await deleteSectionVerified(kernel, input.probe, {
		rootId: doc.rootId,
		walk: tree,
		headingId,
	});
	// The pre-mutation failure ladder — the first-mutation phase rule
	// guarantees these arms mean nothing IS KNOWN to have landed, so they
	// map outside the finish-write wrapper.
	if (
		outcome.kind === "drift" ||
		outcome.kind === "transport-unverified" ||
		outcome.kind === "kernel-refused"
	) {
		return mutationFailure(outcome, input, doc, { headingId });
	}
	if (outcome.kind === "foreign") {
		// Pre-mutation scoping refusal — the shared wording home for the
		// membership class both delete flows refuse on (writeVerdicts doc).
		// The section flow's foreign arm comes from the walk-rootId check:
		// the enumeration walk's root is not the claimed doc. (`doc-id` is
		// unreachable here — sectionOf requires a heading row.)
		return refusedEnvelope(blockInDocRefusalKind(outcome, headingId, doc));
	}
	if (outcome.kind === "walk-truncated" || outcome.kind === "heading-absent") {
		// Unreachable — the sequence re-derives the same section from the
		// same walk this flow just enumerated. Fail-closed tripwire.
		return anchorRefusal(
			outcome.kind,
			doc,
			headingId,
			name,
			deleteSectionWalkTruncatedMessage,
		);
	}
	// Everything from here on is post-mutation — deletes may have landed,
	// so a drop anywhere must never read as "unreachable" or bare-error
	// while the section may be half-removed (finishWrite doc). The
	// interrupted and walk-failed arms throw from in here with the partial
	// state attached, so the wrapper's classifier renders
	// verificationFailed over the merged state.
	return finishWrite(name, { headingId }, async () => {
		switch (outcome.kind) {
			case "judged": {
				const invalidRefs = await backlinkCheck(
					kernel,
					deleteSet.map((b) => b.id),
				);
				// The echo tail reflects the tree AFTER the deletes: the
				// verdict's postWalk IS that tree — reused, not re-traversed.
				const tail = await echoTail(input, doc, outcome.postWalk);
				return {
					status: "ok",
					message: `deleted the section under heading '${section.section.heading.content}' in '${doc.title}' (KB ${name}) — delete set ${deleteSet.length} block(s), ${invalidRefs.count} doc(s) with orphaned refs`,
					kb: name,
					headingId,
					invalidRefs,
					...deletedBlocksTail(sessionId, deleteSet),
					...tail,
				};
			}
			case "members-survived": {
				const tail = await echoTail(input, doc, outcome.postWalk);
				// Presence is sound on any walk; absence only on a complete
				// one — the shared primitives projection, never re-encoded here.
				const split = partitionByAbsence(
					deleteSet.map((b) => b.id),
					outcome.postWalk,
				);
				return errorEnvelope(
					sweepMembersSurvivedMessage(
						outcome.survivedIds,
						split.kind === "unconfirmed",
					),
					{
						kb: name,
						headingId,
						...sweepMembersSurvivedFields(split),
						...tail,
					},
				);
			}
			case "partial":
				return errorEnvelope(
					`delete-section partially applied: the deletes of ${outcome.deletedBlockIds.length} earlier block(s) acked unverified (no verification walk ran), and the delete of '${outcome.failedId}' failed (${outcome.message}) — a member may already have been removed elsewhere (the kernel reports 'tree not found' for an id no longer present); do NOT re-run; delete the remaining section block(s) to finish: ${outcome.remainingBlockIds.join(", ")}`,
					{
						kb: name,
						headingId,
						...partialApplyMarker({
							remainingBlockIds: outcome.remainingBlockIds,
						}),
						unconfirmedBlockIds: outcome.deletedBlockIds,
						remainingBlockIds: outcome.remainingBlockIds,
					},
				);
			case "interrupted":
				// Transport-class failures have their own classification paths
				// (429/auth → runKbCall cooldown/breaker; network/timeout →
				// finishWrite's verificationFailed). The partial state rides the
				// error for the catch sites to merge — the acked deletes ride
				// unconfirmedBlockIds, no walk verified them.
				return rethrowClassified(outcome.error, {
					remainingBlockIds: outcome.remainingBlockIds,
					unconfirmedBlockIds: outcome.deletedBlockIds,
				});
			case "walk-failed":
				// Every section delete acked but the verification walk itself
				// failed — the sweep is complete but unjudged, so it must never
				// surface as a raw transport error while the whole section is
				// applied. The acked set rides unconfirmedBlockIds; nothing
				// remains pending; the classifier renders verificationFailed.
				return rethrowClassified(outcome.error, {
					remainingBlockIds: [],
					unconfirmedBlockIds: outcome.deletedBlockIds,
				});
			case "sweep-truncated":
				// The deletes acked but the post-sweep walk hit the depth
				// bound: the judgment's absence facts are unconfirmed — and
				// survivors outrank truncation in the core, so no issued id is
				// visible either. The receipt over-lists the whole delete set —
				// the closure's cascade-inferred descendants were never
				// individually acked (the sweep issues only members + the
				// heading), so the receipt set is wider than the sweep's own
				// record and over-listing is the conservative direction.
				// Applied-but-unverified — never ok, never a rollback.
				return errorEnvelope(
					`delete-section applied but unverified: every section delete acked, but the verification walk hit the document's depth bound — whether the section is fully gone could not be confirmed. Do NOT re-run; re-fetch the outline (kb_read) and check the delete set (unconfirmedBlockIds) before any cleanup`,
					{
						kb: name,
						headingId,
						...partialApplyMarker({ remainingBlockIds: [] }),
						unconfirmedBlockIds: deleteSet.map((b) => b.id),
					},
				);
		}
		outcome satisfies never;
		return errorEnvelope("internal: unhandled delete-section verdict");
	});
}
