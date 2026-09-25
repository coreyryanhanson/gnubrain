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
import { assertFreshContent, finishWrite } from "./writeResult.js";
import {
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
	// the index cannot see has no pair — the sentinel makes any post-write
	// row count as movement (the kernel's own not-found error governs an
	// update of a truly absent id, never this path).
	const preWrite =
		row.kind === "in-doc"
			? { content: row.content, type: row.type }
			: { content: "", type: "" };
	if (row.kind === "in-doc") {
		// Fresh-content precondition: a concurrency guard, not a consent
		// mechanism (the grant resolved at the kb_write entry). Served content
		// where the session has seen this block, else the block's current
		// content — establish + check are one step right before the kernel
		// call (the dialog's display → approval window no longer exists).
		if (baselines.servedHash(blockId) === undefined) {
			baselines.remember(blockId, row.content);
		}
		const stale = await assertFreshContent(
			kernel,
			baselines,
			[{ blockId, baseline: baselines.servedHash(blockId) }],
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
		preWrite,
		rootId: doc.rootId,
	});
	switch (outcome.kind) {
		case "drift":
		case "transport-unverified":
		case "kernel-refused":
		case "verification-failed":
			return mutationFailureEnvelope(outcome, {
				kb: name,
				tail: () => errorTail(input, doc),
			});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc). The
	// landed predicate and its kernel-behavior interpretation live in the
	// primitives' verifyEditLanded (the pin-owning repo); failure wording
	// rides the shared map (writeVerdicts.editVerifyFailureReason).
	return finishWrite(name, {}, async () => {
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
		const tail = await echoTail(input, doc, undefined, [blockId]);
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			...tail,
		};
	});
}
