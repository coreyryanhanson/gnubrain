// Typed-reason → agent-facing wording for the write-path verdict unions
// siyuan-kb-primitives returns. The primitives speak in closed `{ kind,
// …detail }` unions, never agent-facing sentences; this module is the
// wording layer: the sentence each verdict arm renders (exhaustive
// switches, no default — a new arm in a primitives release fails
// typecheck here once instead of diverging across every flow; the
// trailing never-check is the catch), the anchor echoes, and the one
// frame shared across flows — the pre-judgment ladder
// (mutationFailureEnvelope), which is the one async piece: it awaits the
// flow-supplied echo tail (writeEcho.mutationFailure). Each flow
// composes its own mode's envelope frames from these pieces (frames need
// the flow's echo tail, doc, and verdict keys). Worded elsewhere:
// headingInWalk (writeTarget), mintTitleMessage (writeGuard, shared by
// the tool-surface pre-flight and the primitives' `mint-title` arm), and
// the fresh-content refusal envelope (writeFresh, over the internal
// guards' carried evidence).
// Tool-side policy refusals (grant, breaker, 429 cooldown) never cross
// the boundary and keep their existing homes.

import {
	PINNED_SIYUAN_VERSION,
	type AppendAnchor,
	type BlockInDocResult,
	type MoveAnchor,
	type PartitionByAbsence,
} from "siyuan-kb-primitives";
import type {
	EditLandedOutcome,
	InsertUnlandedVerdict,
	MutationFailure,
	MoveBlockLandedOutcome,
	VerificationCause,
} from "siyuan-kb-primitives/write";
import {
	errorEnvelope,
	versionRefusalEnvelope,
	STALE_TARGET_GUIDANCE,
	partialApplyMarker,
	type AuthLockEvent,
	type Envelope,
	type PartialApplyMarker,
} from "./envelope.js";

/** Drift refusal for a primitives verdict — the same wording as the
 * gate's static refusal. Unreachable through the flows: the gate refuses a
 * drifted verdict before any flow runs, so every arm here is
 * defense-in-depth behind the gate order — but worded once, so it can
 * never diverge from the gate's own refusal. The pin resolves from the
 * module constant, deliberately: this arm only renders if the gate order
 * is ever violated, and the primitives let no caller choose a pin, so in
 * production the effective pin IS the constant — the gate stays the one
 * home for the resolution. */
export function driftRefusal(observed: string): Envelope {
	return versionRefusalEnvelope(observed, PINNED_SIYUAN_VERSION);
}

/** The never-retry-blindly clause shared by the unverified-write
 * sentences in this module (transport-unverified, the two verification-
 * failed twins, and the auth/lock twin): whatever leg failed, the closing
 * instruction is the same — re-check the tree before repeating. The leads
 * differ per leg; this is the one part that must not drift between them.
 * Flows with their own evidence-specific closers (insert/move landed
 * refusals, edit's confirm-before-repeat) word their own instead of
 * reusing this clause. */
const retryBlindlyClause =
	"re-fetch the outline (kb_read) and confirm the write landed before repeating it";

/** The transport-unverified sentence — tool-surface wording for the one
 * hazard the verified flows share: the mutation's kernel call failed at
 * the transport layer, so the write may already be applied and a blind
 * retry duplicates it. */
export function transportUnverifiedMessage(detail: string): string {
	return (
		`the write's outcome is unverified: the kernel call failed at the ` +
		`transport layer (${detail}) — ` +
		`the request may have been delivered and the write may already be ` +
		`applied; do NOT retry blindly — ${retryBlindlyClause}`
	);
}

/** The verification-failed sentence — the twin of the transport-unverified
 * contract for the other unverified leg: the call returned success but the
 * post-write verification reads failed, so the outcome is unknown. Written
 * once here and reused by writeResult's finishWrite catch (the flow side
 * of the primitives boundary) and the create mode's frame (writeCreate). */
export function verificationReadsFailedMessage(detail: string): string {
	return (
		`the write call returned success but the post-write verification reads failed: ` +
		`${detail} — the write's ` +
		`outcome is unverified; do NOT retry blindly, ${retryBlindlyClause}`
	);
}

/** The non-kernel twin of verificationReadsFailedMessage: the builder's
 * post-mutation result assembly failed on something no kernel read
 * explains (a spilled-outline fs failure, a flow bug). The mutation
 * already acked, so the same never-retry-blindly contract applies — the
 * detail carries the underlying error verbatim. */
export function postWriteAssemblyFailedMessage(detail: string): string {
	return (
		`the write call returned success but assembling its result failed: ` +
		`${detail} — the write's outcome is unverified; do NOT retry blindly, ` +
		`${retryBlindlyClause}`
	);
}

/** The auth/lock twin of verificationReadsFailedMessage: the verification
 * read itself failed on an auth event (a 401/403 or the kernel's per-IP
 * 429 lock). The primitives classify these instead of rethrowing because
 * the mutation has already acked — so the wording must keep the
 * may-already-be-applied fact the raw rethrow erased, and add the lock
 * fact: every authed call re-arms the lock, so the wait comes first. The
 * marker type/guard live in envelope.ts beside `partialApplyState`, the
 * other gate-read result marker. */
function verificationAuthEventMessage(
	cause: AuthLockEvent,
	detail: string,
): string {
	const lead =
		cause.kind === "auth"
			? "SiYuan rejected the write's verification read (auth failure)"
			: "the kernel's per-IP auth lock refused the write's verification read (HTTP 429)";
	return (
		`${lead}: ${detail} — the write call returned success, so it may ` +
		`already be applied; do NOT retry now (every authed call re-arms the ` +
		`lock) — wait out the lockout, then ${retryBlindlyClause}`
	);
}

/** The verification-failed envelope frame — one home for the arm the
 * shared ladder and the create mode's frame (writeCreate) both render:
 * the mutation's transport succeeded, so the write may already be applied;
 * the auth/rate-limit legs additionally carry the authEvent payload the
 * session's breaker accounting consumes. `extra` carries the caller's
 * verdict keys and kb. */
export function verificationFailedEnvelope(
	cause: VerificationCause,
	detail: string,
	extra: Record<string, unknown>,
): Envelope {
	if (cause.kind === "auth" || cause.kind === "rate-limit") {
		return errorEnvelope(verificationAuthEventMessage(cause, detail), {
			...extra,
			verificationFailed: true,
			authEvent: cause,
		});
	}
	return errorEnvelope(verificationReadsFailedMessage(detail), {
		...extra,
		verificationFailed: true,
	});
}

/** The flow's own verdict key — the placement anchor echo, the block
 * delete's blockId, the doc move's docId, or the heading-targeting modes'
 * headingId — spread verbatim into the envelope, never re-worded. */
export type VerdictKey =
	| { anchor: string }
	| { blockId: string }
	| { docId: string }
	| { headingId: string };

/** The shared failure ladder for the verified mutation flows — the four
 * pre-judgment arms every mutation outcome union carries (edit, append,
 * block move, replace-section, delete-section, and the block-delete half of
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
		/** The flow's own verdict key — spread verbatim, never re-worded
		 * here. */
		extra?: VerdictKey;
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
			return verificationFailedEnvelope(outcome.cause, outcome.detail, {
				kb: opts.kb,
				...opts.extra,
			});
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled mutation failure");
}

/** The flows' pre-write depth-bound refusals — one shared frame, built
 * here; the sentences differ per operation shape, not per arm: the stake
 * names what could not be derived, and each mode keeps its own advice
 * tail (an in-place edit for append/move/replace-section, a shallower
 * target for edit, the per-block alternative named-and-refused for the
 * delete modes). Every mode refuses before any mutation — the walks
 * whose bound tripped are kernel calls, and the primitives' scoping
 * reads and stake walks have already run when the delete-family bounds
 * trip. The target judgment's own truncation arm words in writeTarget
 * (walkTruncatedMessage, beside headingInWalk's other arms). */
function walkTruncatedFrame(
	mode: string,
	stake: string,
	advice: string,
): string {
	return `the document nests past the walk depth bound, so ${stake} cannot be derived from complete evidence — ${mode} refused before any mutation; ${advice}`;
}

export const editWalkTruncatedMessage = walkTruncatedFrame(
	"edit",
	"the edit target's presence and content",
	"restructure the document (or target a shallower block) instead",
);

export const appendWalkTruncatedMessage = walkTruncatedFrame(
	"append",
	"the append anchor",
	"restructure the document (or edit in place) instead",
);

export const moveWalkTruncatedMessage = walkTruncatedFrame(
	"move",
	"the placement and scoping judgments",
	"restructure the document (or edit in place) instead",
);

export const replaceSectionWalkTruncatedMessage = walkTruncatedFrame(
	"replace-section",
	"the section enumeration and the insert anchor",
	"restructure the document (or edit the target block directly) instead",
);

export const deleteSectionWalkTruncatedMessage = walkTruncatedFrame(
	"delete-section",
	"the section enumeration and its delete-set bound",
	"restructure the document instead — the depth bound is document-wide, so deleting the blocks individually refuses on the same walk",
);

export const deleteBlockWalkTruncatedMessage = walkTruncatedFrame(
	"delete",
	"the delete's cascade stake",
	"restructure the document instead — the depth bound is document-wide, so deleting the blocks individually refuses on the same walk",
);

/** The prose half of the partial-apply render — used by exactly two
 * sentence-frame sites (the gate's withPartialState NOTE and finishWrite's
 * classifier), which only ever see the unverified arm: a consumed state is
 * terminal and never rethrown — `appliedConsumed` is spread directly by
 * its one flow, outside this frame. The marker itself rides envelope.ts
 * (payload, never worded here); these are the status phrase and the
 * landing-state clause each site embeds in its own sentence frame. */
export function partialApplyRender(state: { remainingBlockIds: string[] }): {
	status: string;
	tail: string;
	marker: PartialApplyMarker;
} {
	const marker = partialApplyMarker(state);
	return "partialApply" in marker
		? {
				marker,
				status: "partially applied",
				tail: "the earlier steps have landed",
			}
		: {
				marker,
				status: "applied but unverified",
				tail: "nothing remains to apply",
			};
}

/** The delete-sweep `members-survived` sentence and its payload fields —
 * one home for both sweep consumers (replace-section's sweep,
 * delete-section's sequence), so the shared arm cannot render two
 * different stories about the same silent no-op. The arm is the sweep
 * core's: a delete acked but the block is still present in the post-write
 * tree. `truncated` is true when the verification walk was depth-truncated
 * — the payload then carries unconfirmedBlockIds (absence unconfirmed),
 * and the sentence says so, in both flows. The label names the sweep,
 * not the per-block delete: the block-delete flow's singular variant
 * (writeDelete.ts) is a different primitive arm and keeps its own
 * sentence. */
export function sweepMembersSurvivedMessage(
	survivedIds: string[],
	truncated: boolean,
): string {
	return (
		`verified-sweep failed: the delete of '${survivedIds.join("', '")}' reported success but the block(s) are still present in the post-write tree — a silent no-op behind HTTP success; do not retry blindly — the current outline follows, delete the surviving block(s) by id` +
		(truncated
			? "; the verification walk was depth-truncated, so ids absent from the walk are not claimed as deleted — see unconfirmedBlockIds and reconcile from the outline"
			: "")
	);
}

/** The payload fields derived from the acked-set split — the marker, the
 * certified/unconfirmed absence half, and the pending set. On a complete
 * walk the absence half is certified and rides deletedBlockIds; on a
 * truncated walk it is unconfirmed — but the acked ids still ride the
 * receipt (as unconfirmedBlockIds), never vanish from it. */
export function sweepMembersSurvivedFields(
	split: PartitionByAbsence,
): Record<string, unknown> {
	return {
		...partialApplyMarker({ remainingBlockIds: split.presentIds }),
		...(split.kind === "unconfirmed"
			? { unconfirmedBlockIds: split.unconfirmedAbsentIds }
			: { deletedBlockIds: split.absentIds }),
		remainingBlockIds: split.presentIds,
	};
}

/** Anchor echo wording — the agent-facing rendering of the placement
 * primitives' evidence-only unions (kind + ids + the move `at`). Byte
 * pinning lives in the per-flow suites; the unions' shape contract lives in
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
 * word. The delete primitives' own scoping arms (foreign / doc-id refuse
 * inside deleteBlockVerified and deleteSectionVerified) and the edit
 * primitive's pre-mutation scoping arms word through this — one sentence
 * pair for the same membership class whichever side refuses. */
export function blockInDocRefusalKind(
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

/** Refusal wording for an insertLanded verdict that did not land
 * (`InsertUnlandedVerdict` — every insertLanded outcome but `landed`,
 * which cannot occur in the unlanded arms this words). The predicate
 * lives in the primitives' insertLanded judgment; these sentences are
 * its shared wording — one home so the refusal cannot drift between the
 * insert-bearing modes. */
export function insertLandedRefusal(outcome: InsertUnlandedVerdict): string {
	switch (outcome.kind) {
		case "no-id":
			return "the kernel returned no block id";
		case "absent-from-tree":
			return `the kernel returned '${outcome.blockId}' but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; nothing was inserted`;
		case "landing-unconfirmed":
			return `the kernel returned '${outcome.blockId}' but the post-write walk hit the document's depth bound, so its landing could not be confirmed — it may have landed past the bound; re-fetch the outline (kb_read) before any retry (a blind retry duplicates the write)`;
		case "pre-write-id":
			return `the kernel returned '${outcome.blockId}' but that block already existed before the write`;
	}
	outcome satisfies never;
}

/** Reason wording for a verifyMoveLanded outcome, or undefined when the
 * move landed. The judgment lives in the primitives' verifyMoveLanded;
 * these fragments are its wording — each a full sentence, spliced into
 * the move flow's `block '${blockId}' …` frame. */
export function moveLandedRefusal(
	outcome: MoveBlockLandedOutcome,
): string | undefined {
	switch (outcome.kind) {
		case "absent-from-destination":
			return "is absent from the destination tree — the transaction rolled back silently behind HTTP success";
		case "landing-unconfirmed":
			return "could not be confirmed landed: the verification walk hit the document's depth bound — it may have landed past the bound; re-fetch the outline (kb_read) before any retry";
		case "still-in-source":
			return "is still present in the source tree — the kernel copied rather than moved";
		case "misplaced":
			return outcome.append
				? "is present but not the doc's last top-level block — the transaction silently no-opped behind HTTP success"
				: "is present but not at its landing position after the anchor — the transaction silently no-opped behind HTTP success";
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
	outcome: EditLandedOutcome,
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
			return (
				"the block never appeared in the blocks index across the " +
				"post-update verification window"
			);
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
