// The widened move flow's section arm: the wording for the batched
// section-move sequence's closed verdict union (`moveSectionVerified`
// via `moveVerified`'s row-type dispatch — every heading blockId rides
// this route, memberless or not). The primitives judge the kernel facts
// (the codec, the landed predicate, the group refusals); this module words
// them, exhaustive over the union with no default — a new arm in a
// primitives release fails typecheck here. The per-id route's wording
// stays in writeMove.ts; the untargetable destination-heading judgment
// stays flow-side there too (one owner for both routes, riding the read
// surface's headingInWalk — not an arm of this union).

import {
	STALE_TARGET_GUIDANCE,
	errorEnvelope,
	refusedEnvelope,
	unreachable,
	type Envelope,
} from "./envelope.js";
import type {
	MoveSectionDestination,
	MoveSectionOutcome,
	MoveSectionRefusal,
} from "siyuan-kernel-primitives/write";
import { destOutlinePayload, echoTail } from "./writeEcho.js";
import { batchedUnverifiedEnvelope } from "./writeLadder.js";
import {
	appendAnchorEcho,
	foreignWalkMessage,
	moveAnchorEcho,
	moveWalkTruncatedMessage,
} from "./writeVerdicts.js";
import {
	appliedButUnverifiedEnvelope,
	repairFirstLead,
	SILENT_BATCH_CAUSE_CLAUSE,
} from "./writeBatchedVerdicts.js";
import {
	staleHeadingMessage,
	type DocTarget,
	type WriteFlowBase,
} from "./writeTarget.js";
import type { BlockLevelMoveParams } from "./writeSchema.js";
import { finishWrite } from "./writeResult.js";

/** The destination label the receipts name — the destination section's
 * heading id, or the document's end on the doc-end form (the per-id
 * shape's documented omitted-toHeadingId form). */
function destLabel(dest: DocTarget, toHeadingId: string | undefined): string {
	return toHeadingId !== undefined
		? `section '${toHeadingId}' of '${dest.title}'`
		: `the end of '${dest.title}'`;
}

/** The destination relation's clause — the receipt leads the landing
 * sentence with it: the relation to the destination is the fact the move
 * asked about ("did it go under Guides?"), a level relation, not a
 * pointer. The two walked levels ride the sentence as the diagnosis
 * pair; the `destination-gone` arm words none — the destination row is
 * what is gone, and the receipt points at re-fetch instead. The gloss
 * stays inside the two compared levels — the landing is placed at the
 * moved heading's own walked level, never "the destination's
 * container's level", which the comparison does not judge. */
function destinationRelationLine(destination: MoveSectionDestination): string {
	switch (destination.relation) {
		case "nested":
			return `nested inside the destination section (moved heading level ${destination.movedLevel}, destination heading level ${destination.destinationLevel})`;
		case "sibling-after":
			return `landed as a sibling after the destination section, not nested inside it (moved heading level ${destination.movedLevel}, destination heading level ${destination.destinationLevel})`;
		case "shallower-after":
			return `landed after the destination section at the moved heading's own level, not nested inside it (moved heading level ${destination.movedLevel}, destination heading level ${destination.destinationLevel})`;
		case "destination-gone":
			return "the destination section no longer exists in the live tree — re-fetch the outline (kb_read) to see where the section landed";
	}
	destination satisfies never;
}

/** The group refusals' wording — the pre-mutation group-level refusal
 * family (judged over the moved set as a whole, zero kernel calls in the
 * refusal itself; the judgments are the primitive's, read off walks the
 * sequence already holds). The `walk-refused` arm
 * carries the per-walk gate's role discriminant: the source walk's refusals
 * are tripwires (the entry fetched it by the claimed root and dispatched
 * on this same walk), the destination walk's are the reachable legs —
 * worded per role so a gate miss reads as what it is. */
function moveSectionRefusalEnvelope(
	outcome: MoveSectionRefusal,
	input: WriteFlowBase,
	doc: DocTarget,
	dest: DocTarget,
): Envelope {
	const { name } = input;
	switch (outcome.kind) {
		case "walk-refused": {
			// The role names the walk that refused, so the subject derives
			// from the verdict — never from the flow's own params.
			const walkDoc = outcome.role === "source" ? doc : dest;
			switch (outcome.refusal.kind) {
				case "walk-truncated":
					return refusedEnvelope(moveWalkTruncatedMessage, { kb: name });
				case "heading-absent": {
					const id = outcome.refusal.headingId;
					return refusedEnvelope(
						outcome.role === "source"
							? // The source arm carries the agent's blockId param,
								// not a headingId — name the param the agent filled.
								`blockId '${id}' names no heading of doc '${walkDoc.title}' (${walkDoc.rootId}) — ${STALE_TARGET_GUIDANCE}`
							: staleHeadingMessage(id, walkDoc),
						{ kb: name },
					);
				}
				case "foreign":
					return refusedEnvelope(
						foreignWalkMessage(outcome.role, walkDoc, outcome.refusal.rootId),
						{ kb: name },
					);
			}
			outcome.refusal satisfies never;
			break;
		}
		case "own-closure":
			return refusedEnvelope(
				outcome.toHeadingId === outcome.blockId
					? `cannot move the section under heading '${outcome.blockId}' — the destination heading is the moved heading itself; choose a different destination`
					: `cannot move the section under heading '${outcome.blockId}' — the destination heading '${outcome.toHeadingId}' lies inside the section the move transports (a heading nested inside a moved member's subtree travels with the move), so the batch's anchors would be consumed by the batch itself; choose a destination heading outside the moved section`,
				{ kb: name },
			);
		case "shallower-than-boundary":
			return refusedEnvelope(
				`cannot move the section under heading '${outcome.blockId}' (heading level ${outcome.headingLevel}) — it is strictly shallower than the destination section's boundary '${outcome.boundaryId}' (heading level ${outcome.boundaryLevel}): the landing would not be terminated by that boundary, so the moved section would swallow the destination's boundary heading and every section after it into itself; choose a destination heading at the moved heading's level or deeper`,
				{ kb: name },
			);
		case "already-at-destination": {
			if (outcome.derivation === "boundary-in-set") {
				return refusedEnvelope(
					`nothing to move: the section under heading '${outcome.blockId}' already ends at its destination — the destination section's boundary is the moved heading itself`,
					{ kb: name },
				);
			}
			// The trailing-run derivation covers both the destination-section
			// and the doc-end form (the primitives' own doc-end leg) — word
			// the destination shape from the verdict's `destination`, never
			// from the flow's own params.
			const end =
				outcome.destination === "section"
					? "the destination section's end (it is the destination's trailing run)"
					: "the destination doc's end (it is the document's trailing run)";
			return refusedEnvelope(
				`nothing to move: the section under heading '${outcome.blockId}' already occupies ${end} — a move would re-insert every block exactly where it already sits`,
				{ kb: name },
			);
		}
	}
	return unreachable(outcome, "unhandled section-move refusal");
}

/** The once-only re-issue bound — shared verbatim by both nothing-moved
 * recovery arms. */
const REISSUE_ONCE_CLAUSE =
	"re-issue this move ONCE; if it rolls back again, stop and report — do not loop";

/** The `nothing-moved` sentence — the cause-free silent-rollback arm. It
 * leads with the observation and branches recovery on sameDoc, a fact the
 * flow already holds — never on a re-read: the rollback residue is
 * invisible to every read the tool surface issues (SQL and the doc walk
 * hold the pre-move truth; only by-ID resolution sees the wrong-root rows),
 * so a distinguishing re-read cannot be made. Same-doc: the rollback is
 * the mild case — ids stay resolvable, retry once from fresh walks.
 * Cross-doc: heal the SOURCE doc first (the tree that actually contains
 * the moved nodes — a destination write never walks them), then re-issue
 * once; never re-issue before the heal (a re-issued batch over residue
 * trips its own skip arms and rolls back again). */
function moveSectionNothingMovedMessage(
	sameDoc: boolean,
	doc: DocTarget,
): string {
	const recovery = sameDoc
		? `the rollback leaves the doc intact and every id resolvable — re-fetch the outline (kb_read), then ${REISSUE_ONCE_CLAUSE}`
		: `${repairFirstLead(
				`the SOURCE doc '${doc.title}'`,
				"any other kb_write edit in it re-upserts the moved blocks' index rows — they resolve as not-found until then; a write to the destination doc heals nothing",
			)}${REISSUE_ONCE_CLAUSE}`;
	return (
		`move did not apply: nothing was moved — the batch rolled back ` +
		`silently behind HTTP success (${SILENT_BATCH_CAUSE_CLAUSE}); ${recovery}`
	);
}

/** The `landed-divergent` sentence — the run broke. The parts name what
 * the predicate saw, in its own order: the run absent, the copy case,
 * the unjudged presences (span and tail alike — a fold-dragged block at
 * the front of the run, a concurrent append swallowed into the tail).
 * When no evidence part fires, the verdict carries no discriminant among
 * the remaining break causes (exact member equality, the boundary, the
 * chain anchor) — the fallback words it neutrally. */
function moveSectionDivergentMessage(
	blockId: string,
	landedAtIndex: number | null,
	unjudgedIds: string[],
	stillInSourceIds: string[],
): string {
	const parts: string[] = [];
	if (landedAtIndex === null) {
		parts.push("the moved section is absent from the destination tree");
	}
	if (stillInSourceIds.length > 0) {
		parts.push(
			`block(s) '${stillInSourceIds.join("', '")}' are still present in the source doc — the kernel copied rather than moved`,
		);
	}
	if (unjudgedIds.length > 0) {
		parts.push(
			`block(s) '${unjudgedIds.join("', '")}' sit inside the landed section's span or tail but are not in the issued set — reconcile from the outline`,
		);
	}
	if (parts.length === 0) {
		parts.push(
			"the landed run does not satisfy the landing predicate — its members, the landing position, or the section's boundary changed after the plan was derived; reconcile from the outline",
		);
	}
	return `verified-move failed: the section under heading '${blockId}' did not land intact — ${parts.join("; ")}`;
}

/** The widened move's section arm — every `MoveSectionOutcome` phase,
 * worded. The phase discriminant decides the posture structurally: the
 * refusals return before the post-mutation wrapper; the unverified arms
 * render through the batched ladder (or, for the acked-walk-drop arm,
 * rethrow classified from inside `finishWrite` — a drop anywhere must
 * never read as "unreachable" or bare-error while the section may be
 * mid-move); the judged verdict sits inside `finishWrite`. */
export async function runMoveSectionOutcome(
	input: WriteFlowBase & { params: BlockLevelMoveParams },
	doc: DocTarget,
	dest: DocTarget,
	outcome: MoveSectionOutcome,
): Promise<Envelope> {
	const { name, params } = input;
	const blockId = params.blockId;
	const toHeadingId = params.toHeadingId;
	const sameDoc = dest.rootId === doc.rootId;
	// Refused: the group refusals — nothing applied, safe to retry.
	if (outcome.kind === "refused") {
		return moveSectionRefusalEnvelope(outcome.refusal, input, doc, dest);
	}
	// Unverified: the shared batched-route ladder (batchedUnverifiedEnvelope,
	// writeLadder.ts) — the refused-by-HTTP / transport arms through the
	// route's binding, the acked-walk-drop arm classified inside the
	// finish-write wrapper over the whole judged set. Drift is absent:
	// moveVerified refuses it at its entry, before any route dispatch —
	// the section union carries no drift arm to word.
	if (outcome.kind === "unverified") {
		return batchedUnverifiedEnvelope(outcome.outcome, input, doc, {
			blockId,
		});
	}
	// Judged: the batch acked and the landed judgment rendered — one echo
	// pair serves the receipt, built from the verdict's own evidence —
	// never a re-fetch. Same-doc one walk serves both halves and the
	// destination payload is empty (the per-id precedent). The landed
	// arm seeds its refreshed ids; the others reseed nothing.
	const verdict = outcome.verdict;
	return finishWrite(name, { blockId }, async () => {
		const srcTail = await echoTail(
			input,
			doc,
			verdict.postSourceWalk,
			verdict.kind === "landed" ? verdict.landedIds : undefined,
		);
		const destPayload = sameDoc
			? {}
			: await destOutlinePayload(input, verdict.postDestWalk);
		switch (verdict.kind) {
			case "post-walk-truncated":
				// The walks the verdict carries are served whatever they
				// certify — the receipt's outlines are the evidence it holds.
				return appliedButUnverifiedEnvelope({
					mode: "move",
					observation: "the batch acked",
					question: "the section landed intact",
					reconcile:
						"reconcile the moved set (unconfirmedBlockIds) against the attached outlines",
					kb: name,
					unconfirmedBlockIds: verdict.judgedBlockIds,
					extra: { blockId },
					tail: { ...srcTail, ...destPayload },
				});
			case "nothing-moved":
				return errorEnvelope(moveSectionNothingMovedMessage(sameDoc, doc), {
					kb: name,
					blockId,
					// The judged set, in the batch's issued order — the same
					// ordering `unconfirmedBlockIds` uses on the other arms.
					judgedBlockIds: verdict.judgedBlockIds,
					...srcTail,
					...destPayload,
				});
			case "landed-divergent":
				return errorEnvelope(
					moveSectionDivergentMessage(
						blockId,
						verdict.landedAtIndex,
						verdict.unjudgedIds,
						verdict.stillInSourceIds,
					),
					{
						kb: name,
						blockId,
						unjudgedIds: verdict.unjudgedIds,
						...(verdict.stillInSourceIds.length > 0 && {
							stillInSourceIds: verdict.stillInSourceIds,
						}),
						...srcTail,
						...destPayload,
					},
				);
			case "landed": {
				// The landed receipt: the relation to the destination leads
				// (the doc-end form carries no relation and no clause), then
				// the owner report and the anchor echo, over the hoisted
				// echo pair.
				const relationLine =
					verdict.destination === undefined
						? ""
						: `${destinationRelationLine(verdict.destination)}; `;
				// The codec anchor the verdict carries, rendered through the
				// shared append/move vocabularies (one phrase per position).
				const anchor =
					verdict.anchor.kind === "insert"
						? appendAnchorEcho(verdict.anchor)
						: moveAnchorEcho(verdict.anchor);
				const owner = verdict.owner;
				let ownerLine: string;
				if (owner === null) {
					ownerLine =
						"the landing is a top-level section of its container (no heading owns it)";
				} else {
					// The owner names the landing heading by its own words — the
					// title the verdict carries (the id stays beside it; the
					// title is what the agent can find in the outline). Degrades
					// to the bare id when the title is empty.
					const label = owner.content
						? `${owner.content} (${owner.headingId})`
						: owner.headingId;
					ownerLine = `landed under heading '${label}' (heading level ${owner.level})`;
				}
				const tailClause =
					verdict.tailExtensionId !== undefined
						? `, a heading appended after the section's end now bounds it ('${verdict.tailExtensionId}')`
						: "";
				// The moved section names the heading by its own words — same
				// degrade-to-bare-id rule as the owner line: an empty heading
				// title renders the id instead of an empty quoted string.
				const sectionLabel = verdict.headingContent || blockId;
				return {
					status: "ok",
					message: `moved the section under heading '${sectionLabel}' to ${destLabel(dest, toHeadingId)} (KB ${name}) — ${relationLine}${ownerLine}${tailClause}`,
					kb: name,
					blockId,
					anchor,
					landedIds: verdict.landedIds,
					landedOwner: verdict.owner,
					...(verdict.destination !== undefined && {
						destination: verdict.destination,
					}),
					...(verdict.tailExtensionId !== undefined && {
						tailExtensionId: verdict.tailExtensionId,
					}),
					...srcTail,
					...destPayload,
				};
			}
		}
		return unreachable(verdict, "unhandled section-move verdict");
	});
}
