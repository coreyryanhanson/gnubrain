// The edit flow: updateBlock on an agent-supplied blockId target —
// verified against the blocks index (transaction ack + content round-
// trip), never trusted from the HTTP success alone. The mutation and the
// landed judgment are one primitive call (editVerified).

import { blockInDoc } from "siyuan-kb-primitives";
import { editVerified } from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { echoTail, mutationFailure } from "./writeEcho.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { freshContentRefusal } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	editVerifyFailureReason,
	blockInDocRefusal,
	blockInDocRefusalKind,
} from "./writeVerdicts.js";

export async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc.rootId, blockId);
	const refusal = blockInDocRefusal(row, blockId, doc);
	if (refusal !== undefined) return refusedEnvelope(refusal);
	if (row.kind === "in-doc") {
		// Fresh-content precondition (writeFresh.ts). Read reuse, not a
		// seeding step: the blockInDoc row is already in hand, so
		// supplying its hash spares the judgment's own seed read — the
		// primitive reaches the same arms either way (diverged row → stale,
		// matching or absent row → the walk content is adopted).
		if (baselines.servedHash(blockId) === undefined) {
			baselines.remember(blockId, row.content);
		}
		const stale = await freshContentRefusal(
			kernel,
			baselines,
			[{ blockId, baselineHash: baselines.servedHash(blockId) }],
			{ sessionId, docId: doc.rootId },
		);
		if (stale !== null) return stale;
	}
	// The pre-write stored pair the landed check needs is read inside the
	// primitive (the representation contract — blocks-index row form,
	// never walk-rendered content — is its concern, not ours). An absent
	// target is never refused here — updateBlock's synchronous
	// not-found error surfaces verbatim through the kernel-refused arm.
	// The verified edit: one primitive call — the shared transport
	// contract lives in writeResult.ts's header.
	const outcome = await editVerified(kernel, input.probe, {
		blockId,
		body: input.body,
		rootId: doc.rootId,
	});
	if (outcome.kind !== "judged") {
		if (outcome.kind === "foreign" || outcome.kind === "doc-id") {
			// Defense-in-depth: the flow's own target read already refuses
			// this membership class above; the primitive's pre-write read is
			// the second copy of the same judgment. Same wording home as the
			// delete primitive's scoping arms — one sentence pair whichever
			// side refuses.
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
		// write's own block from it instead of a post-write read (a
		// concurrent change landing in the echo window would be laundered
		// into the baseline). Remembered after the echo so the stored form
		// wins over the walk-seeded serve.
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
