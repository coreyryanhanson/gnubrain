// The delete flow: block-level deleteBlock or doc-level removeDocByID.
// The mutation, its scoping precondition and its evidence are one
// primitive call (deleteBlockVerified / deleteDocVerified — see the
// primitives' delete.ts for the scoping and generation-coupled facts,
// and for the internal fresh-content guard the block path judges under).
// The refusal arms word through writeVerdicts' shared blockInDoc
// sentences (the same pair the edit flow's pre-guard uses); the
// remaining non-judged arms ride the shared mutationFailureEnvelope.

import {
	orphanedMembersOf,
	type OrphanedMembers,
} from "siyuan-kernel-primitives";
import {
	deleteBlockVerified,
	deleteDocVerified,
} from "siyuan-kernel-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { deletedBlocksTail, echoTail, orphanedRefs } from "./writeEcho.js";
import { mutationFailure } from "./writeLadder.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { freshRefusalEnvelope } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import {
	blockInDocRefusalKind,
	deleteBlockWalkTruncatedMessage,
} from "./writeVerdicts.js";

// The degraded line — one sentence for every arm that cannot state a
// trustworthy member set; the arms are unreachable here (the guard's
// stake walk is complete) but the switch stays exhaustive.
const DEGRADED_REPORT =
	"the walk could not bound the deleted block's section, so members left in place may go unreported — re-fetch the outline (kb_read) and check the block's section members by id";

/** The heading-delete report's wording over the projection's closed
 * union — the flow words arms only; the arm semantics live in the
 * primitives. Suppression keys on the empty member set: an empty
 * member report disappears rather than wearing a placeholder. The
 * report only runs on the judged-gone arm, whose post-walk is always
 * complete (a truncated one refuses as absence-unconfirmed before any
 * report), so the projection's unconfirmed-survivor half is empty here
 * and the presences are the whole story. */
function wordOrphanReport(orphans: OrphanedMembers): {
	line?: string;
	ids?: string[];
} {
	switch (orphans.kind) {
		case "ids":
			if (orphans.ids.length === 0) {
				// A section-less heading: present, empty member set — nothing
				// to report.
				return {};
			}
			return {
				ids: orphans.ids,
				line: `${orphans.ids.length} body block(s) left in place; they no longer belong to this heading: ${orphans.ids.join(", ")}`,
			};
		case "not-a-heading":
			// A plain block holds no section members — nothing to report.
			return {};
		case "not-in-pre-walk":
		case "bound-unconfirmed":
			// No trustworthy member set: degrade, never silence.
			return { line: DEGRADED_REPORT };
	}
	orphans satisfies never;
	return {};
}

export async function runDeleteMode(
	input: WriteFlowInput<"delete">,
	doc: DocTarget,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	if (params.doc === true) {
		const outcome = await deleteDocVerified(kernel, input.probe, {
			docId: doc.rootId,
		});
		if (outcome.kind !== "mutated") {
			// The union has no verification-failed arm: the primitive's
			// evidence walk runs before the mutation (raw throws), and the
			// post-mutation reads live in this flow's finishWrite leg.
			return mutationFailure(outcome, input, doc, { docId: doc.rootId });
		}
		return finishWrite(name, {}, async () => {
			// The doc's pre-delete walk set is the invalidRefs evidence.
			const refs = await orphanedRefs(
				kernel,
				outcome.preWalk.blocks.map((b) => b.id),
			);
			// The same walk set is the receipt: every block the doc lost,
			// itemized with its content — no outline or root row survives.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${refs.clause}`,
				kb: name,
				invalidRefs: refs.invalidRefs,
				...deletedBlocksTail(input.sessionId, outcome.preWalk.blocks),
			};
		});
	}
	const blockId = params.blockId;
	// The fresh precondition is the primitive's, over the session lookup
	// (writeFresh.ts; the judged stake derives inside the primitive — see
	// deleteBlockVerified's `baselineFor`). Doc deletes are exempt:
	// container-level destruction whose receipt itemizes every lost block.
	const outcome = await deleteBlockVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
		baselineFor: baselines.servedBaseline,
	});
	if (outcome.kind === "fresh-refused") {
		return freshRefusalEnvelope(baselines, sessionId, name, outcome);
	}
	if (outcome.kind === "walk-truncated") {
		// The primitive's stake walk hit the depth bound — the cascade
		// stake cannot be enumerated from complete evidence. Refused before
		// any mutation, so the outline is re-readable on demand.
		return refusedEnvelope(deleteBlockWalkTruncatedMessage, { kb: name });
	}
	if (outcome.kind === "foreign" || outcome.kind === "doc-id") {
		return refusedEnvelope(blockInDocRefusalKind(outcome, blockId, doc));
	}
	if (outcome.kind !== "judged") {
		// The shared pre-judgment ladder, worded once in writeVerdicts.
		// The lazy tail supplier keeps the per-arm garnish rule — only the
		// arms that attach the echo reads fire them.
		return mutationFailure(outcome, input, doc, { blockId });
	}
	const verdict = outcome.verdict;
	return finishWrite(name, { blockId }, async () => {
		const tail = await echoTail(input, doc, outcome.postWalk);
		if (verdict.kind === "still-present") {
			// A silent no-op behind HTTP success is a failed delete — the
			// doctrine the section-delete core refuses on (members-survived).
			return errorEnvelope(
				`verified-delete failed: the delete of '${blockId}' reported success but the block is still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the block by id only if it is still wanted gone`,
				{ kb: name, blockId, ...tail },
			);
		}
		// Orphan-ref evidence is only meaningful once something was deleted.
		const refs = await orphanedRefs(kernel, [blockId]);
		if (verdict.kind === "absence-unconfirmed") {
			return errorEnvelope(
				`delete applied but unverified: block '${blockId}' acked deleted, but the verification walk hit the document's depth bound — whether the target is gone could not be confirmed (it may sit past the bound). Do NOT re-run blind; re-fetch the outline (kb_read) and check the block by id first`,
				{ kb: name, blockId, invalidRefs: refs.invalidRefs, ...tail },
			);
		}
		// The deleted block's stored content rides the judged arm (the
		// primitive's own membership read) — the receipt is free.
		// The heading-delete report: the kernel's delete path is
		// fold-blind, so a heading-scoped delete removes ONLY the heading and
		// its section members survive it. The projection runs over the
		// snapshot the fresh-content guard certified (the primitive's
		// judgedWalk — complete by the guard's own truncation refusal) and
		// the delete's own post-walk evidence — zero extra kernel reads. The
		// report rides the ok arm only, and it may weaken (the degraded
		// line), never upgrade into a refusal and never silently disappear.
		const report = wordOrphanReport(
			orphanedMembersOf(outcome.judgedWalk, blockId, outcome.postWalk),
		);
		return {
			status: "ok",
			message:
				`deleted block ${blockId} in '${doc.title}' (KB ${name}) — target absent from the post-write tree; ${refs.clause}` +
				(report.line === undefined ? "" : `; ${report.line}`),
			kb: name,
			blockId,
			invalidRefs: refs.invalidRefs,
			...(report.ids !== undefined ? { orphanedMembers: report.ids } : {}),
			...deletedBlocksTail(input.sessionId, [
				{ id: blockId, content: outcome.content },
			]),
			...tail,
		};
	});
}
