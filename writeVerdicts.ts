// Typed-reason → agent-facing wording for the write-path verdict unions
// siyuan-kernel-primitives returns. The primitives speak in closed `{ kind,
// …detail }` unions, never agent-facing sentences; this module is the
// wording layer: the sentence each verdict arm renders (exhaustive
// switches, no default — a new arm in a primitives release fails
// typecheck once, wherever that sentence lives, instead of diverging
// across every flow; the trailing never-check is the catch), the anchor
// echoes. The batched kernel route's shared doctrine — the refusal note,
// the repair leads, the survivor/nothing-deleted skeletons, the
// post-walk-truncated receipt — lives in writeBatchedVerdicts (keyed on
// the route, not on a verdict union). The one frame shared across flows
// — the pre-judgment failure ladder (mutationFailureEnvelope) — lives in
// writeLadder beside its flow-side bindings: it is the one async piece
// (the tail thunk is awaited inside), and this module stays purely
// synchronous. Each flow composes its own mode's envelope frames from
// these pieces (frames need the flow's echo tail, doc, and verdict
// keys). Worded elsewhere:
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
} from "siyuan-kernel-primitives";
import type {
	InsertUnlandedVerdict,
	VerificationCause,
} from "siyuan-kernel-primitives/write";
import {
	errorEnvelope,
	versionRefusalEnvelope,
	STALE_TARGET_GUIDANCE,
	type AuthLockEvent,
	type Envelope,
} from "./envelope.js";

/** Drift refusal for a primitives verdict — the same wording as the
 * gate's static refusal. Unreachable through the flows: the gate refuses a
 * drifted verdict before any flow runs, so every arm here is
 * defense-in-depth behind the gate order. The pin resolves from the
 * module constant, deliberately: this arm only renders if the gate order
 * is ever violated, and the primitives let no caller choose a pin, so in
 * production the effective pin IS the constant — the gate stays the one
 * home for the resolution. */
export function driftRefusal(observed: string): Envelope {
	return versionRefusalEnvelope(observed, PINNED_SIYUAN_VERSION);
}

/** The never-retry-blindly clause closing the unverified-write sentences
 * in this module (transport-unverified and the three verification-failed
 * sentences): whatever leg failed, the closing instruction is the same —
 * re-check the tree before repeating. The argument names what to
 * confirm: the default is the write's landing; the edit passes the
 * block's content (its already-correct-resubmit hazard turns on
 * content, not landing). Landed-refusal flows word their own closers —
 * their hazard is the depth bound, not a blind retry. */
export function retryBlindlyClause(confirm = "the write landed"): string {
	return `re-fetch the outline (kb_read) and confirm ${confirm} before repeating it`;
}

/** The flow's own verdict key — the placement anchor echo, the block
 * delete's blockId, the doc move's docId, or the heading-targeting modes'
 * headingId — spread verbatim into the envelope, never re-worded. */
export type VerdictKey =
	| { anchor: string; newBlockId: string }
	| { anchor: string }
	| { blockId: string }
	| { docId: string }
	| { headingId: string };

/** The shared tail of the landing-unconfirmed sentences (insert's
 * `insertLandedRefusal`, move's `moveLandedRefusal`): the verification
 * walk hit the document's depth bound, so the landing is unjudged — same
 * hazard, same recovery; the leads differ per flow. */
export const landedUnconfirmedClause =
	"it may have landed past the bound; re-fetch the outline (kb_read) before any retry (a blind retry duplicates the write)";

/** The transport-unverified sentence — tool-surface wording for the one
 * hazard the verified flows share: the mutation's kernel call failed at
 * the transport layer, so the write may already be applied and a blind
 * retry duplicates it. */
export function transportUnverifiedMessage(detail: string): string {
	return (
		`the write's outcome is unverified: the kernel call failed at the ` +
		`transport layer (${detail}) — ` +
		`the request may have been delivered and the write may already be ` +
		`applied; do NOT retry blindly — ${retryBlindlyClause()}`
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
		`outcome is unverified; do NOT retry blindly, ${retryBlindlyClause()}`
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
		`${retryBlindlyClause()}`
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
		`lock) — wait out the lockout, then ${retryBlindlyClause()}`
	);
}

/** The verification-failed envelope frame — the arm the shared ladder
 * and the create mode's frame (writeCreate) both render:
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

/** The flows' pre-write walk-incompleteness refusals — one shared frame,
 * built here; the sentences differ per operation shape, not per arm: the
 * stake names what could not be derived, the cause names why the walk is
 * incomplete (the strict walks' depth bound alone; the walk-tolerating
 * modes — edit's fresh-guard walk and delete's cascade stake walk, which
 * tolerate a vanished container — also allow a mid-read vanish), and
 * each mode keeps its own advice tail (an in-place edit for
 * append/move/replace-section, a shallower target for edit, the
 * per-block alternative named-and-refused for the delete modes). Every
 * mode refuses before any mutation — the walks whose bound tripped are
 * kernel calls, and the primitives' scoping reads and stake walks have
 * already run when the delete-family bounds trip. The target judgment's
 * own truncation arm words in writeTarget (walkTruncatedMessage, beside
 * headingInWalk's other arms). Re-read and retry is safe (the refusal is
 * pre-mutation on both causes); only a second refusal points at the
 * depth bound. */
function walkIncompleteFrame(
	mode: string,
	stake: string,
	cause: string,
	advice: string,
): string {
	return `the walk could not be completed — ${cause} — so ${stake} cannot be derived from complete evidence; ${mode} refused before any mutation; ${advice}`;
}

// The two incompleteness causes, worded once: every strict walk names
// the depth bound alone; a walk-tolerating walk's cause is not knowable
// at the refusal site, so its sentence names both.
const DEPTH_BOUND = "the document nests past the walk depth bound";
const DEPTH_BOUND_OR_VANISH = `${DEPTH_BOUND}, or a container vanished mid-read`;

// The shared walk-truncation advice literals — the arms whose
// recovery reads the same.
export const RESTRUCTURE_OR_EDIT_INSTEAD =
	"restructure the document (or edit in place) instead";
const DEPTH_BOUND_RESTRUCTURE_INSTEAD =
	"restructure the document instead — the depth bound is document-wide, so deleting the blocks individually refuses on the same walk";

export const editWalkTruncatedMessage = walkIncompleteFrame(
	"edit",
	"the edit target's presence and content",
	DEPTH_BOUND_OR_VANISH,
	"re-read the current state with kb_read and retry — a second refusal points at the depth bound; restructure the document (or target a shallower block) instead",
);

/** The absent-target refusal's sentence — a target absent from a
 * COMPLETE pre-write walk refuses before any mutation (nothing was
 * modified): the walk emits every blocks row except the `d` root, so
 * the arm covers the doc root, an unindexed doc id (format-
 * indistinguishable from a block id through the index flush window),
 * and a tree that failed to load (an empty walk is still complete).
 * The membership diagnosis rides the verdict — `foreign`/`doc-id` word
 * through `blockInDocRefusalKind` (one sentence pair for the membership
 * class whichever side refuses), while `in-doc`/`absent` name which of
 * the two reads disagreed; the recovery re-targets from the outline the
 * verdict carries, never a re-fetch. */
export function editAbsentTargetMessage(
	blockId: string,
	doc: { title: string; rootId: string },
	membership: BlockInDocResult,
): string {
	switch (membership.kind) {
		case "doc-id":
		case "foreign":
			return blockInDocRefusalKind(membership, blockId, doc);
		case "in-doc":
		case "absent": {
			const indexFact =
				membership.kind === "in-doc"
					? "the blocks index still lists it in this doc"
					: "the blocks index does not list it either";
			return (
				`block '${blockId}' is absent from a complete walk of '${doc.title}' ` +
				`(${indexFact}) — it may have been deleted, moved out of the document, ` +
				"or the document's tree may have failed to load; nothing was modified — " +
				"re-target from the outline below"
			);
		}
	}
	membership satisfies never;
}

export const appendWalkTruncatedMessage = walkIncompleteFrame(
	"append",
	"the append anchor",
	DEPTH_BOUND,
	RESTRUCTURE_OR_EDIT_INSTEAD,
);

export const moveWalkTruncatedMessage = walkIncompleteFrame(
	"move",
	"the placement and scoping judgments",
	DEPTH_BOUND,
	RESTRUCTURE_OR_EDIT_INSTEAD,
);

/** The foreign-walk refusal sentence — both move routes' walk-provenance
 * arm: the held walk resolved to a root other than the doc it was served
 * for. */
export function foreignWalkMessage(
	role: "source" | "destination",
	doc: { title: string; rootId: string },
	resolvedRootId: string,
): string {
	return `the ${role} walk is not doc '${doc.title}' (${doc.rootId}) — it resolved to root '${resolvedRootId}' — ${STALE_TARGET_GUIDANCE}`;
}

export const replaceSectionWalkTruncatedMessage = walkIncompleteFrame(
	"replace-section",
	"the section enumeration and the insert anchor",
	DEPTH_BOUND,
	"restructure the document (or edit the target block directly) instead",
);

export const deleteSectionWalkTruncatedMessage = walkIncompleteFrame(
	"delete-section",
	"the section enumeration and its delete-set bound",
	DEPTH_BOUND,
	DEPTH_BOUND_RESTRUCTURE_INSTEAD,
);

export const deleteBlockWalkTruncatedMessage = walkIncompleteFrame(
	"delete",
	"the delete's cascade stake",
	DEPTH_BOUND_OR_VANISH,
	"re-read the current state with kb_read and retry — a second refusal points at the depth bound, which is document-wide (deleting the blocks individually refuses on the same walk); restructure instead",
);

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
}

/** The refusal half of blockInDoc's union — the two kinds that always
 * word. The delete primitives' own scoping arms (foreign / doc-id refuse
 * inside deleteBlockVerified and deleteSectionVerified) word through
 * this, and the edit's absent-target diagnosis words the same kinds
 * through it — one sentence pair for the same membership class whichever
 * side refuses. */
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
 * its shared wording. */
export function insertLandedRefusal(outcome: InsertUnlandedVerdict): string {
	switch (outcome.kind) {
		case "no-id":
			return "the kernel returned no block id";
		case "absent-from-tree":
			return `the kernel returned '${outcome.blockId}' but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; nothing was inserted`;
		case "landing-unconfirmed":
			return `the kernel returned '${outcome.blockId}' but the post-write walk hit the document's depth bound, so its landing could not be confirmed — ${landedUnconfirmedClause}`;
		case "pre-write-id":
			return `the kernel returned '${outcome.blockId}' but that block already existed before the write`;
	}
	outcome satisfies never;
}
