// The edit flow: updateBlock on an agent-supplied blockId target —
// verified against the blocks index (transaction ack + content round-
// trip), never trusted from the HTTP success alone. The mutation and the
// landed judgment are one primitive call (editVerified).

import { blockInDoc } from "siyuan-kb-primitives";
import { editVerified } from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	echoTail,
	mutationFailure,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, freshContentRefusal } from "./writeResult.js";
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
		// Fresh-content precondition: a concurrency guard, not a consent
		// mechanism (the grant resolved at the kb_write entry). Served content
		// where the session has seen this block, else the block's current
		// content — seed + check are one wrapper step right before the
		// kernel call (the dialog's display → approval window no longer
		// exists).
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
	// primitive now (the representation contract — blocks-index row form,
	// never walk-rendered content — is its concern, not ours). An absent
	// target is never refused here — updateBlock's synchronous
	// not-found error surfaces verbatim through the kernel-refused arm.
	// The verified edit: the mutation and the landed judgment are one
	// primitive call. Transport failures in the mutation phase are outcome-
	// UNKNOWN (the edit may already be applied); auth / rate-limit errors
	// rethrow for runKbCall's classification (breaker counting, 429
	// cooldown).
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
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc). The
	// landed predicate and its kernel-behavior interpretation live in the
	// primitives' verifyEditLanded (the pin-owning repo); failure wording
	// rides the shared map (writeVerdicts.editVerifyFailureReason).
	return finishWrite(name, { blockId }, async () => {
		if (outcome.verdict.kind !== "landed") {
			const failure = editVerifyFailureReason(outcome.verdict, blockId, doc);
			// The failure tail must not launder a concurrent change past the
			// precondition — no refreshBlockIds on this path.
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
		// write's own block from it instead of the SQL refresh (a concurrent
		// change landing in the echo window would be laundered into the
		// baseline). Remembered after the echo so the index form wins over
		// the walk seeding, exactly as the refresh did.
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
			...tail,
		};
	});
}
