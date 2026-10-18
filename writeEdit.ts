// The edit flow: updateBlock on an agent-supplied blockId target —
// verified against the blocks index (transaction ack + content round-
// trip), never trusted from the HTTP success alone. The mutation and the
// landed judgment are one primitive call (editVerified).

import { editVerified } from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { echoTail, mutationFailure } from "./writeEcho.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	editVerifyFailureReason,
	blockInDocRefusalKind,
	editWalkTruncatedMessage,
} from "./writeVerdicts.js";

export async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId as string;
	// No flow-side membership read: the primitive judges scoping itself,
	// and a foreign or doc-id target refuses at its pre-mutation scoping
	// arms (below) instead of a duplicate read here.
	// The fresh precondition is the primitive's: edit supplies the one
	// target's verdict — the single-target form, not the lookup (see
	// editVerified's `baseline`; the seed-path rule: baselines.ts) — and
	// the refusal builder is shared: writeFresh.ts.
	const baseline = baselines.servedBaseline(blockId);
	// The verified edit: one primitive call — the shared transport
	// contract lives in writeResult.ts's header. The judgment runs inside
	// the primitive, after its own scoping read and before the mutation.
	// An absent target is never refused here: the judgment runs on it too
	// (walk-absent → vanished → proceed), and updateBlock's synchronous
	// not-found error surfaces verbatim through the kernel-refused arm.
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
		if (outcome.kind === "foreign" || outcome.kind === "doc-id") {
			// Pre-mutation scoping refusal — the primitive's own blockInDoc
			// read; the same wording home as the delete primitives' scoping
			// arms, one sentence pair for the membership class.
			return refusedEnvelope(blockInDocRefusalKind(outcome, blockId, doc));
		}
		return mutationFailure(outcome, input, doc, { blockId });
	}
	// Post-mutation reads (see finishWrite's contract — the edit is already
	// applied). The landed predicate lives in the primitives'
	// verifyEditLanded; failure wording rides
	// writeVerdicts.editVerifyFailureReason.
	return finishWrite(name, { blockId }, async () => {
		if (outcome.verdict.kind !== "landed") {
			const failure = editVerifyFailureReason(outcome.verdict, blockId, doc);
			// No refreshBlockIds on a failure path — the edit did not land,
			// so its block gets no baseline; the tail seeds served rows from
			// the walk it serves (echoTail).
			const tail = await echoTail(input, doc);
			return errorEnvelope(
				`verified-edit failed: ${failure} — the update's outcome is ` +
					`unverified; do NOT retry blindly, re-fetch the outline (kb_read) ` +
					`and confirm the block's content before repeating it`,
				{ kb: name, blockId, ...tail },
			);
		}
		const tail = await echoTail(input, doc);
		// The landed verdict carries the stored pair it judged — baseline the
		// write's own block from it instead of a post-write read (the
		// anti-laundering invariant: baselines.ts). Remembered after the echo
		// so the stored form wins over the walk-seeded serve.
		// An `unobserved` baseline (no pre-write pair — create → edit
		// immediately) means the stored pair may still be the pre-edit row
		// arriving through the index lag, so it never seeds a baseline: the
		// block stays baseline-less and the next fresh-check reads it as
		// `unseen` instead of trusting a possibly-stale value.
		if (outcome.verdict.baseline === "observed") {
			baselines.remember(blockId, outcome.verdict.stored.content);
		}
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			blockId,
			...tail,
		};
	});
}
