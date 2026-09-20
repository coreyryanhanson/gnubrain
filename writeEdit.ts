// The edit flow: updateBlock on an agent-supplied blockId target —
// verified against the blocks index (transaction ack + content round-
// trip), never trusted from the HTTP success alone.

import type { BlockTransaction } from "siyuan-kernel-api";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { VERIFY_RETRY_DELAYS_MS } from "./kernel.js";
import {
	blockInDoc,
	echoTail,
	runMutation,
	type DocTarget,
	type WriteFlowInput,
} from "./writeFlow.js";
import { assertFreshContent, finishWrite } from "./writeResult.js";

/** The edit landed predicate. Edit changes no tree shape, so the insert
 * modes' walk-set diff cannot apply. Landed is defined as STATE MOVEMENT:
 * the block's stored (content, type) pair must leave its pre-write value —
 * a silently-dropped update leaves the pre-write block in place, which is
 * the only observationally available signal. The kernel normalizes
 * submitted markdown (live-probed: a ref token `((id "x"))` stores as
 * `x`, `**bold**` as `bold`; plain bodies round-trip byte-exact), so
 * equality against the submitted body is not a landed predicate — and an
 * edit whose normalized form equals the pre-write content (an identical
 * resubmit, the plain-body case) is a success no-op: the tx ack is the
 * only evidence, and the index already satisfies the post-write state.
 * A NORMALIZED-equivalent resubmit (submitted markdown that renders to the
 * stored form, e.g. `**bold**` over stored `bold`) cannot be distinguished
 * from a silent drop without the kernel's normalizer, so it exhausts the
 * window and fails loud — the conservative direction; the envelope sends
 * the agent to re-fetch, where the already-correct content ends the loop.
 * The exact-match exemption only covers the byte-equal case. The check
 * rides blocks.content: the landed predicate asserts the INDEX moved off
 * the pre-write form (the fresh-content precondition rides the live tree,
 * whose plain walk-form differs from blocks.content on a drifted kernel —
 * comparing the index against it would false-fail on representation
 * drift). The blocks index converges asynchronously after updateBlock, so
 * the re-reads retry inside a fixed window (the verified-create table). */
async function editRollbackReason(
	input: WriteFlowInput,
	doc: DocTarget,
	tx: BlockTransaction[],
	blockId: string,
	preWrite: { content: string; type: string },
): Promise<string | undefined> {
	if (!tx.some((t) => t.doOperations.some((op) => op.id === blockId))) {
		return "the kernel returned no update operation for the block";
	}
	// Identical resubmit: the stored form already IS the requested content,
	// so landed and no-op are observationally identical — pass on the ack.
	if (preWrite.content === input.body) return undefined;
	let lastServed = "";
	for (let attempt = 0; ; attempt++) {
		const row = await blockInDoc(input.kernel, doc, blockId);
		if ("refusal" in row) {
			// The index already resolves the block outside this doc — a
			// concurrent move landed mid-write; never report this as ok.
			return `the block no longer resolves in '${doc.title}': ${row.refusal}`;
		}
		if (row.content === null) {
			return "the block is absent from the blocks index after the update";
		}
		if (row.content !== preWrite.content || row.type !== preWrite.type) {
			return undefined;
		}
		lastServed = row.content;
		const delay = VERIFY_RETRY_DELAYS_MS[attempt];
		if (delay === undefined) break;
		await new Promise((resolve) => setTimeout(resolve, delay));
	}
	return (
		"the blocks index never moved off the pre-write content within the " +
		`verification window (last served: '${lastServed.slice(0, 200)}')`
	);
}

export async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if ("refusal" in row) return refusedEnvelope(row.refusal);
	// The pre-write stored pair the landed check must see move off. A block
	// the index cannot see has no pair — the sentinel makes any post-write
	// row count as movement (the kernel's own not-found error governs an
	// update of a truly absent id, never this path).
	const preWrite = { content: row.content ?? "", type: row.type ?? "" };
	if (row.content !== null) {
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
	// not-found error surfaces verbatim below.
	const tx = await runMutation(input, {}, doc, () =>
		kernel.updateBlock({ id: blockId, data: input.body }),
	);
	if ("status" in tx) return tx;
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc).
	return finishWrite(name, {}, async () => {
		const rollback = await editRollbackReason(
			input,
			doc,
			tx,
			blockId,
			preWrite,
		);
		if (rollback !== undefined) {
			// The failure tail must not launder a concurrent change past the
			// precondition — no refreshBlockIds on this path.
			const tail = await echoTail(input, doc);
			return errorEnvelope(
				`verified-edit failed: ${rollback} — the update's outcome is ` +
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
