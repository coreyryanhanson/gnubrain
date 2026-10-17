// The delete flow: block-level deleteBlock or doc-level removeDocByID.
// The mutation, its scoping precondition and its evidence are one
// primitive call (deleteBlockVerified / deleteDocVerified — see the
// primitives' delete.ts for the scoping and generation-coupled facts).
// The refusal arms word through writeVerdicts' shared blockInDoc
// sentences (the same pair the edit flow's pre-guard uses); the
// remaining non-judged arms ride the shared mutationFailureEnvelope.

import {
	backlinkCheck,
	orphanedMembersOf,
	type OrphanedMembers,
} from "siyuan-kb-primitives";
import {
	deleteBlockVerified,
	deleteDocVerified,
} from "siyuan-kb-primitives/write";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { deletedBlocksTail, echoTail, mutationFailure } from "./writeEcho.js";
import { type DocTarget, type WriteFlowInput } from "./writeTarget.js";
import { freshContentRefusal } from "./writeFresh.js";
import { finishWrite } from "./writeResult.js";
import { blockInDocRefusalKind } from "./writeVerdicts.js";

// The heading-delete report's degraded line — shared by every arm that
// cannot state a trustworthy member set. It presumes nothing about the
// deleted block's shape: a not-in-pre-walk or unbounded block may or may
// not have been a heading with members left in place.
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
	input: WriteFlowInput,
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
			const invalidRefs = await backlinkCheck(
				kernel,
				outcome.preWalk.blocks.map((b) => b.id),
			);
			// The same walk set is the receipt: every block the doc lost,
			// itemized with its content — no outline or root row survives.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} doc(s) with orphaned refs`,
				kb: name,
				invalidRefs,
				...deletedBlocksTail(input.sessionId, outcome.preWalk.blocks),
			};
		});
	}
	const blockId = params.blockId as string;
	// Fresh-content precondition: the same concurrency guard the edit flow
	// applies — a delete's intent is formed on last-served content, and the
	// act is the least recoverable one. Doc deletes are exempt:
	// container-level destruction whose receipt itemizes every lost block.
	// No flow-side membership read: the delete primitive judges scoping
	// itself, and a block outside this doc or already absent reads as
	// `vanished` here and refuses at the primitive's scoping arms instead.
	// The judged walk rides out with the refusal pair: the heading-delete
	// report below derives from exactly the snapshot the precondition
	// certified — zero extra kernel reads.
	const { refusal, walk } = await freshContentRefusal(
		kernel,
		baselines,
		[{ blockId, baselineHash: baselines.servedHash(blockId) }],
		{ sessionId, docId: doc.rootId },
	);
	if (refusal !== null) return refusal;
	const outcome = await deleteBlockVerified(kernel, input.probe, {
		blockId,
		rootId: doc.rootId,
	});
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
			// doctrine the replace-section sweep refuses on (members-survived).
			return errorEnvelope(
				`verified-delete failed: the delete of '${blockId}' reported success but the block is still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the block by id only if it is still wanted gone`,
				{ kb: name, blockId, ...tail },
			);
		}
		// Orphan-ref evidence is only meaningful once something was deleted.
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		if (verdict.kind === "absence-unconfirmed") {
			return errorEnvelope(
				`delete applied but unverified: block '${blockId}' acked deleted, but the verification walk hit the document's depth bound — whether the target is gone could not be confirmed (it may sit past the bound). Do NOT re-run blind; re-fetch the outline (kb_read) and check the block by id first`,
				{ kb: name, blockId, invalidRefs, ...tail },
			);
		}
		// The deleted block's stored content rides the judged arm (the
		// primitive's own membership read) — the receipt is free.
		// The heading-delete report: the kernel's delete path is
		// fold-blind, so a heading-scoped delete removes ONLY the heading and
		// its section members survive it. The projection runs over the
		// snapshot the fresh-content precondition certified and the
		// delete's own post-walk evidence — zero extra kernel reads. The
		// report rides the ok arm only, and it may weaken (the degraded
		// line), never upgrade into a refusal and never silently disappear.
		let reportLine: string | undefined;
		let orphanedIds: string[] | undefined;
		if (walk === undefined) {
			// The empty-target short-circuit — unreachable for a delete (it
			// always names a target). Fail-closed: degrade to the
			// confirmation line rather than assert.
			reportLine = DEGRADED_REPORT;
		} else {
			const report = wordOrphanReport(
				orphanedMembersOf(walk, blockId, outcome.postWalk),
			);
			reportLine = report.line;
			orphanedIds = report.ids;
		}
		return {
			status: "ok",
			message:
				`deleted block ${blockId} in '${doc.title}' (KB ${name}) — target absent from the post-write tree; ${invalidRefs.count} doc(s) with orphaned refs` +
				(reportLine === undefined ? "" : `; ${reportLine}`),
			kb: name,
			blockId,
			invalidRefs,
			...(orphanedIds !== undefined ? { orphanedMembers: orphanedIds } : {}),
			...deletedBlocksTail(input.sessionId, [
				{ id: blockId, content: outcome.content },
			]),
			...tail,
		};
	});
}
