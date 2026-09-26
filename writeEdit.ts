// The edit flow: updateBlock on an agent-supplied blockId target —
// verified against the blocks index (transaction ack + content round-
// trip), never trusted from the HTTP success alone. The mutation and the
// landed judgment are one primitive call (editVerified).

import { blockInDoc } from "siyuan-kb-primitives";
import { editVerified } from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import {
	echoTail,
	errorTail,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { finishWrite, freshContentRefusal } from "./writeResult.js";
import {
	driftRefusal,
	editVerifyFailureReason,
	blockInDocRefusal,
	mutationFailureEnvelope,
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
	// The pre-write stored pair the landed check must see move off. A block
	// the index cannot see has no pair — preWrite is omitted and the
	// primitive counts any post-write row as movement (the kernel's own
	// not-found error governs an update of a truly absent id, never this
	// path).
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
	// An absent target is never refused here — updateBlock's synchronous
	// not-found error surfaces verbatim through the kernel-refused arm.
	// The verified edit: the mutation and the landed judgment are one
	// primitive call. Transport failures in the mutation phase are outcome-
	// UNKNOWN (the edit may already be applied); auth / rate-limit errors
	// rethrow for runKbCall's classification (breaker counting, 429
	// cooldown).
	const outcome = await editVerified(kernel, input.probe, {
		blockId,
		body: input.body,
		preWrite:
			row.kind === "in-doc"
				? { content: row.content, type: row.type }
				: undefined,
		rootId: doc.rootId,
	});
	if (outcome.kind !== "judged") {
		return mutationFailureEnvelope(outcome, {
			kb: name,
			extra: { blockId },
			tail: () => errorTail(input, doc),
		});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc). The
	// landed predicate and its kernel-behavior interpretation live in the
	// primitives' verifyEditLanded (the pin-owning repo); failure wording
	// rides the shared map (writeVerdicts.editVerifyFailureReason).
	return finishWrite(name, { blockId }, async () => {
		if (outcome.verdict.kind !== "landed") {
			// Drift renders as the canonical version refusal (same wording as
			// the gate's static refusal), not the generic unverified error —
			// defence-in-depth: the gate refuses a drifted session first.
			if (outcome.verdict.kind === "drift") {
				return driftRefusal(outcome.verdict.observed);
			}
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
		const tail = await echoTail(input, doc, undefined, [blockId]);
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			...tail,
		};
	});
}
