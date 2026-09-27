// Typed-reason → agent-facing wording for the write-path verdict unions
// siyuan-kb-primitives returns. The primitives speak in closed `{ kind,
// …detail }` unions, never agent-facing sentences; this module owns every
// word. Each union gets an exhaustive switch on `kind` — no default case;
// the trailing never-check makes a new kind in a primitives release fail
// typecheck until its wording is written here (the byte-identity contract:
// a map that forgets an arm changes the rendered message and fails the
// suites, which is the catch, not the hazard).
//
// Tool-side policy refusals (grant, breaker, 429 cooldown, mint title)
// never cross the boundary and keep their existing homes; the fresh-content
// judgment itself moved down (the primitives' checkFreshContent) — only
// its refusal envelope stays tool-side (freshContentRefusal, writeResult).

import {
	PINNED_SIYUAN_VERSION,
	type BlockInDocResult,
} from "siyuan-kb-primitives";
import type {
	AppendAnchor,
	CreateDocOutcome,
	EditJudgedVerdict,
	InsertLandedOutcome,
	MutationFailure,
	MoveAnchor,
	MoveBlockOutcome,
	MoveDocJudgment,
	MoveLandedOutcome,
	SweepRefusal,
} from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	refusedEnvelope,
	versionRefusalEnvelope,
	STALE_TARGET_GUIDANCE,
	type Envelope,
} from "./envelope.js";

/** Drift refusal for a primitives verdict — the same wording as the
 * gate's static refusal. Unreachable through the flows: the gate refuses a
 * drifted verdict before any flow runs, so every arm here is
 * defense-in-depth behind the gate order — but worded once, so it can
 * never diverge from the gate's own refusal. The pin resolves from the
 * module constant, deliberately: this arm only renders if the gate order
 * is ever violated, and in production the effective pin IS the constant
 * (the session override is a test seam) — the gate stays the one home for
 * the resolution. Exported for the flows' defence-in-depth arms that must
 * render the canonical refusal rather than the generic unverified error. */
export function driftRefusal(observed: string): Envelope {
	return versionRefusalEnvelope(observed, PINNED_SIYUAN_VERSION);
}

/** The transport-unverified sentence — tool-surface wording for the one
 * hazard the verified flows share: the mutation's kernel call failed at
 * the transport layer, so the write may already be applied and a blind
 * retry duplicates it. Rendered only by mutationFailureEnvelope; its
 * sibling verificationReadsFailedMessage is the twin the finishWrite
 * catch reuses from the flow side of the primitives boundary. */
function transportUnverifiedMessage(detail: string): string {
	return (
		`the write's outcome is unverified: the kernel call failed at the ` +
		`transport layer (${detail}) — ` +
		`the request may have been delivered and the write may already be ` +
		`applied; do NOT retry blindly — re-fetch the outline (kb_read) and ` +
		`confirm whether it landed before repeating it`
	);
}

/** The verification-failed sentence — the twin of the transport-unverified
 * contract for the other unverified leg: the call returned success but the
 * post-write verification reads failed, so the outcome is unknown. Written
 * once here and reused by writeResult's finishWrite catch, which reaches
 * the same hazard from the flow side of the primitives boundary. */
export function verificationReadsFailedMessage(detail: string): string {
	return (
		`the write call returned success but the post-write verification reads failed: ` +
		`${detail} — the write's ` +
		`outcome is unverified; do NOT retry blindly, re-fetch the outline ` +
		`(kb_read) and confirm the write landed before repeating it`
	);
}

/** The shared failure ladder for the verified mutation flows — the four
 * pre-judgment arms every mutation outcome union carries (edit, append,
 * block move, replace-section, and the block-delete half of
 * DeleteBlockOutcome — that half IS MutationFailure by type, so the block
 * delete shares this ladder rather than copying it), worded once so a new
 * arm in a primitives release fails typecheck here instead of diverging
 * across every flow.
 * Per-arm doctrine:
 * - drift: the gate refuses first; this is defense-in-depth. Zero kernel
 *   calls — the tail thunk is never awaited on this arm.
 * - transport-unverified: the write may already be applied — never render
 *   this as "unreachable", whose retry invitation would duplicate an
 *   applied write. The error-path echo reads run best-effort (tail).
 * - kernel-refused: a synchronous kernel rejection is not in-flight; it
 *   surfaces verbatim with the fresh outline attached (tail).
 * - verification-failed: the mutation's transport succeeded — the write
 *   may already be applied. Same never-retry-blindly contract, no garnish
 *   tail: the echo reads just failed and the message stands alone.
 * The tail is a thunk, not a value: errorTail performs kernel reads and
 * must stay off the arms that refuse without them. */
export async function mutationFailureEnvelope(
	outcome: MutationFailure,
	opts: {
		kb: string;
		/** The flow's own verdict key — the placement anchor echo, the
		 * block delete's blockId, or the doc move's docId — spread verbatim,
		 * never re-worded here. */
		extra?: { anchor: string } | { blockId: string } | { docId: string };
		tail: () => Promise<Record<string, unknown>>;
	},
): Promise<Envelope> {
	switch (outcome.kind) {
		case "drift":
			return driftRefusal(outcome.observed);
		case "transport-unverified":
			return errorEnvelope(transportUnverifiedMessage(outcome.detail), {
				kb: opts.kb,
				verificationFailed: true,
				...opts.extra,
				...(await opts.tail()),
			});
		case "kernel-refused":
			return errorEnvelope(outcome.message, {
				kb: opts.kb,
				...opts.extra,
				...(await opts.tail()),
			});
		case "verification-failed":
			return errorEnvelope(verificationReadsFailedMessage(outcome.detail), {
				kb: opts.kb,
				...opts.extra,
				verificationFailed: true,
			});
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled mutation failure");
}

/** Anchor echo wording — the agent-facing rendering of the placement
 * primitives' evidence-only unions (kind + ids + the move `at`). Byte
 * pinning lives in writeModes.test.ts; the unions' shape contract lives in
 * the primitives' placement corpus. */
export function appendAnchorEcho(anchor: AppendAnchor): string {
	switch (anchor.kind) {
		case "insert":
			return `nextID=${anchor.nextID} (next heading)`;
		case "append":
			return anchor.containerId === null
				? "appendBlock(root) — doc end"
				: `appendBlock(${anchor.containerId}) — end of section`;
	}
	anchor satisfies never;
	return "";
}

export function moveAnchorEcho(anchor: MoveAnchor): string {
	switch (anchor.kind) {
		case "move":
			return anchor.at === "doc-end"
				? `previousID=${anchor.previousID} (doc end)`
				: `previousID=${anchor.previousID} (end of section)`;
		case "append":
			// The empty destination — the doc root's parentID append, spec
			// echo identical to the append vocabulary's doc end.
			return "appendBlock(root) — doc end";
	}
	anchor satisfies never;
	return "";
}

/** The refusal half of blockInDoc's union — the two kinds that always
 * word. Split from blockInDocRefusal so consumers holding only the refusal
 * half (the edit verify's concurrent-move inner) get a total `string`, not
 * a type that permits an undefined to interpolate into a sentence. */
function blockInDocRefusalKind(
	outcome: Extract<BlockInDocResult, { kind: "doc-id" | "foreign" }>,
	blockId: string,
	doc: { title: string; rootId: string },
): string {
	switch (outcome.kind) {
		case "doc-id":
			return `'${blockId}' is a document id, not a block — use a doc-level op or re-target a block from the outline (kb_read)`;
		case "foreign":
			return `block '${blockId}' belongs to another doc (root ${outcome.rootId}), not '${doc.title}' (${doc.rootId}) — ${STALE_TARGET_GUIDANCE}`;
	}
	outcome satisfies never;
}

export function blockInDocRefusal(
	outcome: BlockInDocResult,
	blockId: string,
	doc: { title: string; rootId: string },
): string | undefined {
	if (outcome.kind === "doc-id" || outcome.kind === "foreign") {
		return blockInDocRefusalKind(outcome, blockId, doc);
	}
	return undefined;
}

/** Refusal wording for an insertLanded outcome, or undefined when the
 * insert landed. The predicate moved to the primitives' insertLanded
 * judgment; these two sentences are its shared wording — one home so the
 * refusal cannot drift between the insert-bearing modes. */
export function insertLandedRefusal(
	outcome: InsertLandedOutcome,
): string | undefined {
	switch (outcome.kind) {
		case "no-id":
			return "the kernel returned no block id";
		case "absent-from-tree":
			return `the kernel returned '${outcome.blockId}' but it is absent from the post-write tree`;
		case "landed":
			return undefined;
	}
	outcome satisfies never;
	return undefined;
}

/** The verified block move's pre-mutation refusal family — the placement
 * arms judged on the caller-held pre-move walk, plus the not-in-source
 * scoping arm (the kernel mutates by raw block id with no doc scoping of
 * its own; the judgment rides moveBlockVerified). The primitives own the
 * kernel facts — the no-op self-anchor class and the own-subtree ancestor
 * class the kernel mishandles — and refuse before the mutation, zero
 * kernel calls; every arm words here. */
export function movePlacementRefusal(
	outcome: Extract<
		MoveBlockOutcome,
		{ kind: "already-at-destination" | "own-subtree" | "not-in-source" }
	>,
	doc: { title: string; rootId: string },
): Envelope {
	switch (outcome.kind) {
		case "already-at-destination":
			return refusedEnvelope(
				`block '${outcome.blockId}' already sits at the destination position — nothing to move`,
			);
		case "own-subtree":
			return refusedEnvelope(
				`cannot move block '${outcome.blockId}' — its destination anchor sits inside the block's own subtree (the move would re-parent the block into itself); choose a destination outside the subtree`,
			);
		case "not-in-source":
			return refusedEnvelope(
				`blockId '${outcome.blockId}' is not a block of source doc '${doc.title}' (${doc.rootId}) — ${STALE_TARGET_GUIDANCE}`,
			);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled move placement arm");
}

/** Reason wording for a verifyMoveLanded outcome, or undefined when the
 * move landed. The judgment moved to the primitives' verifyMoveLanded;
 * these fragments are its wording — the enclosing sentence lives in the
 * move flow. */
export function moveLandedRefusal(
	outcome: MoveLandedOutcome,
): string | undefined {
	switch (outcome.kind) {
		case "absent-from-destination":
			return "absent from the destination tree";
		case "still-in-source":
			return "still present in the source tree";
		case "misplaced":
			return outcome.append
				? "present but not the doc's last top-level block"
				: "present but not at its landing position after the anchor";
		case "landed":
			return undefined;
	}
	outcome satisfies never;
	return undefined;
}

/** Reason wording for an edit verify failure, or undefined when the edit
 * landed. `lastServed` is kernel content shown verbatim — the truncation
 * is a detail of this sentence, not of the primitive. */
export function editVerifyFailureReason(
	outcome: EditJudgedVerdict,
	blockId: string,
	doc: { title: string; rootId: string },
): string | undefined {
	switch (outcome.kind) {
		case "no-update-op":
			return "the kernel returned no update operation for the block";
		case "concurrent-move":
			// The nested blockInDoc refusal wording — the inner union is
			// blockInDoc's refusal half, total by construction.
			return `the block no longer resolves in '${doc.title}': ${blockInDocRefusalKind(outcome.inner, blockId, doc)}`;
		case "absent-from-index":
			return "the block is absent from the blocks index after the update";
		case "never-converged":
			return (
				"the blocks index never moved off the pre-write content within the " +
				`verification window (last served: '${outcome.lastServed.slice(0, 200)}')`
			);
		case "landed":
			return undefined;
	}
	outcome satisfies never;
	return undefined;
}

/** Envelope mapping for a guarded-create outcome other than `created` —
 * byte-identical to the flow-refusal sentences the create flow issued
 * before the extraction. The create mint runs with no doc target, so the
 * transport/kernel-refused legs carry no echo tail (the errorTail rule for
 * a missing doc). */
export function createVerdictEnvelope(
	outcome: Exclude<CreateDocOutcome, { kind: "created" }>,
	ctx: { name: string },
): Envelope {
	switch (outcome.kind) {
		case "parent-missing":
			return errorEnvelope(
				`parentId '${outcome.parentId}' does not resolve to a doc in KB '${ctx.name}' (stale or foreign target)`,
			);
		case "unconfirmable":
			return errorEnvelope(
				`verified-create failed: the kernel returned doc id '${outcome.returnedId}' but no type='d' row exists for it in KB '${ctx.name}' — the mint is unconfirmable; do not retry blindly`,
			);
		case "ghost-intermediate":
			return errorEnvelope(
				`verified-create failed: parent '${outcome.parentId}' was deleted or renamed between the hpath read-back and the create — the kernel minted a ghost intermediate; drop the ghost subtree and retry`,
			);
		case "hpath-mismatch":
			return errorEnvelope(
				`verified-create failed: stored hpath '${outcome.stored}' does not match ground truth '${outcome.expected}' — unexpected kernel title normalization`,
			);
		case "transport-unverified":
			return errorEnvelope(transportUnverifiedMessage(outcome.detail), {
				kb: ctx.name,
				verificationFailed: true,
			});
		case "kernel-refused":
			return errorEnvelope(outcome.message, { kb: ctx.name });
		case "verification-failed":
			return errorEnvelope(verificationReadsFailedMessage(outcome.detail), {
				docId: outcome.returnedId,
				kb: ctx.name,
				verificationFailed: true,
			});
		case "drift":
			return driftRefusal(outcome.observed);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled create verdict");
}

/** Envelope mapping for a verified delete-sweep outcome other than the
 * three the flow handles itself — `swept` (the success path continues),
 * `interrupted` (the error instance must ride to the catch sites with its
 * partial state attached, so it cannot render here) and `walk-failed`
 * (likewise rethrown — the sweep is complete but unjudged, rendered by
 * the finish-write classifier, never here). The parameter is the
 * primitives' own `SweepRefusal` (owned by sweep.ts, discriminant-only
 * exclusion in the module that owns the union), so an arm-shape change
 * upstream re-derives this set here instead of a restated `Exclude`
 * silently re-admitting a terminal arm. Byte-identical to
 * the sentences the flow issued before the extraction (the
 * createVerdictEnvelope pattern). `members-survived` is the one arm with
 * no pre-extraction sentence — the old flow trusted the deletes' results
 * and rendered a lying ok receipt; the judgment never rendered this arm
 * before, so its wording is new, not a rewrite. */
export function sweepRefusal(
	outcome: SweepRefusal,
	ctx: {
		kb: string;
		anchor: string;
		newBlockId: string;
		memberIds: string[];
		/** The echo tail over the verdict's certified post-sweep walk, served
		 * on the two terminal arms — the recovery evidence inline, so the
		 * agent never re-fetches state the verdict already holds. `partial`
		 * carries no walk (the sweep stopped before the verification walk),
		 * so its tail stays undefined. */
		tail?: Record<string, unknown> | undefined;
	},
): Envelope {
	switch (outcome.kind) {
		case "partial": {
			const deleted = outcome.deletedBlockIds.length;
			return errorEnvelope(
				`replace partially applied: the new section is in place (block '${ctx.newBlockId}') but the delete of '${outcome.failedId}' failed (${outcome.message})` +
					(deleted > 0
						? `, and ${deleted} earlier block(s) were deleted`
						: "") +
					` — do NOT re-run; delete the remaining old-section block(s) to finish: ${outcome.remainingBlockIds.join(", ")}`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: outcome.deletedBlockIds,
					remainingBlockIds: outcome.remainingBlockIds,
				},
			);
		}
		case "cascade-consumed":
			return errorEnvelope(
				`verified-replace failed: the new section block '${ctx.newBlockId}' is absent from the post-write tree — the delete sweep's cascade consumed the replacement; do not retry`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: ctx.memberIds,
					remainingBlockIds: [],
					...ctx.tail,
				},
			);
		case "members-survived":
			return errorEnvelope(
				`verified-sweep failed: the delete of '${outcome.survivedIds.join("', '")}' reported success but the block(s) are still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the surviving block(s) by id`,
				{
					kb: ctx.kb,
					anchor: ctx.anchor,
					newBlockId: ctx.newBlockId,
					partialReplace: true,
					deletedBlockIds: ctx.memberIds.filter(
						(id) => !outcome.survivedIds.includes(id),
					),
					remainingBlockIds: outcome.survivedIds,
					...ctx.tail,
				},
			);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled sweep verdict");
}

/** The `judged` leg of the doc-move flow — the not-landed sentence, or
 * undefined when the move landed (the success path takes over). The tree's
 * hpath is the judgment's only evidence, so the sentence reports what the
 * tree shows and claims no mechanism (an observed hpath off the destination
 * could be a rollback or a landing elsewhere; only the block-level
 * judgment's reason ladder can tell those apart). */
export function moveDocJudgmentRefusal(
	verdict: MoveDocJudgment,
	ctx: { name: string; docId: string; title: string },
): Envelope | undefined {
	switch (verdict.kind) {
		case "landed":
			return undefined;
		case "not-landed":
			return errorEnvelope(
				`verified-move failed: doc '${ctx.title}' did not land at the destination — the tree reports hpath '${verdict.hpath}'`,
				{ kb: ctx.name, docId: ctx.docId },
			);
	}
	verdict satisfies never;
	return undefined;
}
