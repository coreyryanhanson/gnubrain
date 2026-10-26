// The edit flow: updateBlock on an agent-supplied blockId target, one
// primitive call (editVerified) whose landing is verified walk-vs-walk,
// never trusted from the HTTP success alone.

import {
	editVerified,
	type EditLandedOutcome,
} from "siyuan-kernel-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { echoTail } from "./writeEcho.js";
import { mutationFailure } from "./writeLadder.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { serveOutlineFromWalk } from "./outline.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	editAbsentTargetMessage,
	editWalkTruncatedMessage,
	retryBlindlyClause,
} from "./writeVerdicts.js";

export async function runEditMode(
	input: WriteFlowInput<"edit">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId;
	// No flow-side membership read: the primitive's walk is the presence
	// authority, and the absent-target refusal carries the membership
	// diagnosis (worded below).
	// The fresh precondition is the primitive's: edit supplies the one
	// target's verdict — the single-target form, not the lookup (see
	// editVerified's `baseline`; the seed-path rule: baselines.ts) — and
	// the refusal builder is shared: writeFresh.ts.
	const baseline = baselines.servedBaseline(blockId);
	// The verified edit: one primitive call — the shared transport
	// contract lives in writeResult.ts's header. The judgment runs inside
	// the primitive, immediately before the mutation —
	// the absence arms' rationale lives on `EditOutcome`'s docstring;
	// this flow only words them.
	const outcome = await editVerified(kernel, input.probe, {
		blockId,
		body: input.body,
		rootId: doc.rootId,
		baseline,
	});
	if (outcome.kind !== "judged") {
		if (outcome.kind === "fresh-refused") {
			// The internal guard's refusal — nothing landed.
			return freshRefusalEnvelope(baselines, sessionId, name, outcome);
		}
		if (outcome.kind === "walk-truncated") {
			// The guard's walk cannot see the target: an unconfirmed absence
			// never mutates, and content it could not compare is not a fresh
			// target.
			return refusedEnvelope(editWalkTruncatedMessage, { kb: name });
		}
		if (outcome.kind === "absent-target") {
			// The complete-walk refusal: nothing was modified, the completed
			// walk rides the verdict, and the recovery re-targets from the
			// outline below — never a re-fetch of state the verdict already
			// paid for. The walk is served like every other carried-walk
			// envelope (the freshRefusalEnvelope precedent: seeded serve,
			// anti-laundering invariant: baselines.ts).
			return refusedEnvelope(
				editAbsentTargetMessage(blockId, doc, outcome.membership),
				{
					kb: name,
					blockId,
					...serveOutlineFromWalk(
						sessionId,
						"kb_write",
						outcome.walk,
						baselines,
					),
				},
			);
		}
		return mutationFailure(outcome, input, doc, { blockId });
	}
	// Post-mutation reads (see finishWrite's contract — the edit is already
	// applied). The landed judgment lives in the primitives'
	// judgeEditLanded; failure wording rides editVerifyFailureReason below.
	return finishWrite(name, { blockId }, async () => {
		if (outcome.verdict.kind !== "landed") {
			const failure = editVerifyFailureReason(outcome.verdict, doc);
			// No refreshBlockIds on a failure path — the edit did not land,
			// so its block gets no baseline; the tail serves from the walk
			// the verdict already judged over — no re-fetch of state the
			// verdict observed.
			const tail = await echoTail(input, doc, outcome.postWalk);
			return errorEnvelope(
				`verified-edit failed: ${failure} — the update's outcome is ` +
					`unverified; do NOT retry blindly, ` +
					retryBlindlyClause("the block's content"),
				{ kb: name, blockId, ...tail },
			);
		}
		// The receipt's outline is served from the walk the verdict already
		// carried — the judgment's own evidence, not a second read.
		const tail = await echoTail(input, doc, outcome.postWalk);
		// The landed verdict carries the row it judged — baseline the
		// write's own block from it unconditionally: the pre-write row is
		// the fresh guard's walk row by construction, so the judged stored
		// content is always the post-write observation (the anti-laundering
		// invariant: baselines.ts). Remembered after the echo so the stored
		// form wins over the walk-seeded serve.
		baselines.remember(blockId, outcome.verdict.stored.content);
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			blockId,
			...tail,
		};
	});
}

/** Reason wording for an edit verify failure's not-landed arms — the
 * caller narrows on the verdict (a landed edit takes the success path).
 * The judgment is walk-vs-walk, so the sentences name the live tree,
 * never the blocks index. `observed` is
 * kernel content shown verbatim — the truncation is a detail of this
 * sentence, not of the primitive. */
function editVerifyFailureReason(
	outcome: Exclude<EditLandedOutcome, { kind: "landed" }>,
	doc: { title: string },
): string {
	switch (outcome.kind) {
		case "still-pre-write":
			return (
				"the live tree still holds the pre-write row — either the " +
				"update was silently dropped, or the submitted body " +
				"renders to the content the tree already holds (a " +
				"normalized resubmit; observed: " +
				`'${outcome.observed.content.slice(0, 200)}')`
			);
		case "concurrent-move":
			return (
				"the block's parent changed under the edit — a concurrent " +
				"intra-doc move landed (the row now sits under " +
				`'${outcome.row.parentId ?? "the document root"}')`
			);
		case "concurrent-gone":
			return (
				`the block is no longer in '${doc.title}'s live tree — a ` +
				"concurrent delete or cross-doc move landed"
			);
		case "absence-unconfirmed":
			return (
				"the post-write walk could not reach the block's position, so " +
				"its state is unconfirmed"
			);
	}
	outcome satisfies never;
}
