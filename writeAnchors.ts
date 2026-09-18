// Anchors + the section primitive — always tool-derived, never
// agent-supplied. Pure functions over the document-order walk, so they are
// fold-state-independent and independently testable.
//
// One section rule: the section of a heading H is H's following siblings
// inside H's own container, up to the first sibling heading of level ≤ H's
// level (same-or-shallower). Every anchor is a projection of that one
// Section — no consumer re-derives placement from walk order.

import type { WalkedBlock } from "./walk.js";

/** The heading level from the subType ("h3" → 3); a missing subType reads
 * as level 1. */
function headingLevel(block: WalkedBlock): number {
	return Number(String(block.subType).slice(1)) || 1;
}

/** True when `block` sits inside `ancestorId`'s subtree (its parent chain
 * reaches the ancestor). Missing parent ids (a vanished container) read as
 * outside — the fail-safe direction for placement checks. */
function inSubtree(
	block: WalkedBlock,
	ancestorId: string,
	byId: ReadonlyMap<string, WalkedBlock>,
): boolean {
	let parent = block.parentId;
	let hops = 0;
	while (parent !== null && hops++ < byId.size) {
		if (parent === ancestorId) return true;
		const next = byId.get(parent);
		if (next === undefined) return false;
		parent = next.parentId;
	}
	return false;
}

export interface Section {
	heading: WalkedBlock;
	/** The heading's parent — null = document root. */
	containerId: string | null;
	/** Following siblings in the container, up to the first sibling heading
	 * of level ≤ the target's. Deeper headings never bound; a container
	 * does. This is the kernel's HeadingChildren. */
	members: WalkedBlock[];
	/** First same-or-shallower sibling heading, else null (the section runs
	 * to the container's end). */
	boundary: WalkedBlock | null;
	/** members + every descendant of each member — what a delete of the
	 * members cascades to. */
	closure: WalkedBlock[];
}

/** The one section primitive: membership, boundary and closure for a
 * heading of the walk. Container-local by construction — the flattened
 * walk is pre-order, so the heading's sibling run is the following entries
 * that share its parent, interleaved with (and bounded by) the members'
 * own subtrees. */
export function sectionOf(
	walk: WalkedBlock[],
	headingId: string,
): Section | undefined {
	const headingIndex = walk.findIndex(
		(b) => b.id === headingId && b.type === "h",
	);
	if (headingIndex < 0) return undefined;
	const heading = walk[headingIndex]!;
	const containerId = heading.parentId;
	const level = headingLevel(heading);
	const byId = new Map(walk.map((b) => [b.id, b] as const));
	const members: WalkedBlock[] = [];
	const memberIndices: number[] = [];
	let boundary: WalkedBlock | null = null;
	let lastMember: WalkedBlock | undefined;
	for (let i = headingIndex + 1; i < walk.length; i++) {
		const block = walk[i]!;
		if (block.parentId === containerId) {
			if (block.type === "h" && headingLevel(block) <= level) {
				boundary = block;
				break;
			}
			members.push(block);
			memberIndices.push(i);
			lastMember = block;
			continue;
		}
		// Not a sibling: a descendant of the last member (the run continues
		// past it) or a block past the container's own subtree (it ended).
		if (lastMember !== undefined && inSubtree(block, lastMember.id, byId)) {
			continue;
		}
		break;
	}
	// The pre-order walk keeps each member's descendants contiguous behind
	// it, so the closure is each member plus the run of subtree entries
	// trailing it — cut at the first entry outside the subtree.
	const closure: WalkedBlock[] = [];
	for (const [k, member] of members.entries()) {
		closure.push(member);
		for (let i = memberIndices[k]! + 1; i < walk.length; i++) {
			const block = walk[i]!;
			if (!inSubtree(block, member.id, byId)) break;
			closure.push(block);
		}
	}
	return { heading, containerId, members, boundary, closure };
}

/** A heading whose container the kernel does not accept as a write-parent
 * (`appendBlock`/`moveBlock` accept d/b/l/i/s/callout/tab) is not a legal
 * section target — refused in headingInWalk before any dialog. Re-exported:
 * the set lives in walk.ts so the outline's `(not targetable)` marker and
 * this refusal cannot drift apart. */
export { TARGETABLE_CONTAINER_TYPES } from "./walk.js";

export type AppendAnchor =
	| { kind: "insert"; nextID: string; anchor: string }
	| { kind: "append"; containerId: string | null; anchor: string };

export type MoveAnchor =
	| { kind: "move"; previousID: string; anchor: string }
	| { kind: "append"; containerId: string | null; anchor: string };

export type AppendPlacement = "section-end" | "section-start";

/** The empty-destination echo — spec-defined identically for the append
 * and move vocabularies: an empty doc's end IS the doc-root append. */
const DOC_END_ECHO = "appendBlock(root) — doc end";

/** The section-end projection — the default insert anchor: `insert` before
 * the section's boundary (a sibling of the target, so the kernel lands it
 * inside the target's own container), else `append` to the container's end
 * (the document root for a doc-level heading with no boundary). */
function sectionEndAnchor(section: Section): AppendAnchor {
	if (section.boundary !== null) {
		return {
			kind: "insert",
			nextID: section.boundary.id,
			anchor: `nextID=${section.boundary.id} (next heading)`,
		};
	}
	if (section.containerId === null) {
		return {
			kind: "append",
			containerId: null,
			anchor: DOC_END_ECHO,
		};
	}
	return {
		kind: "append",
		containerId: section.containerId,
		anchor: `appendBlock(${section.containerId}) — end of section`,
	};
}

/** The section-start projection (append only): insert immediately before
 * the section's first deeper sibling heading — after the heading's leading
 * run of members. A deeper heading inside a container is not a sibling, so
 * a section whose only subsections are container-nested has no first
 * sibling heading member and the projection falls through to the
 * section-end rule — identical landing there. Same `Section`, same insert
 * kind, so it inherits the boundary insert's fold-independence. */
function sectionStartAnchor(section: Section): AppendAnchor {
	const firstSubsection = section.members.find((m) => m.type === "h");
	if (firstSubsection !== undefined) {
		return {
			kind: "insert",
			nextID: firstSubsection.id,
			anchor: `nextID=${firstSubsection.id} (next heading)`,
		};
	}
	return sectionEndAnchor(section);
}

/** `append`/replace-section anchor. `placement` is append-only; other
 * modes always take the section-end rule. No heading → the doc's end. */
export function deriveAppendAnchor(
	walk: WalkedBlock[],
	heading: WalkedBlock | undefined,
	placement: AppendPlacement = "section-end",
): AppendAnchor {
	if (heading === undefined) {
		return {
			kind: "append",
			containerId: null,
			anchor: DOC_END_ECHO,
		};
	}
	const section = sectionOf(walk, heading.id);
	if (section === undefined) {
		return {
			kind: "append",
			containerId: null,
			anchor: DOC_END_ECHO,
		};
	}
	return placement === "section-start"
		? sectionStartAnchor(section)
		: sectionEndAnchor(section);
}

/** The move's doc-end fallback is its own vocabulary, never the insert
 * one: a populated destination positions after its last root-level block
 * (moveBlock with parentID prepends — the defect); an empty one has no
 * block to anchor after, so parentID IS the end position. */
function docEndMoveAnchor(destWalk: WalkedBlock[]): MoveAnchor {
	const lastRoot = destWalk.findLast((b) => b.parentId === null);
	if (lastRoot === undefined) {
		return {
			kind: "append",
			containerId: null,
			anchor: DOC_END_ECHO,
		};
	}
	return {
		kind: "move",
		previousID: lastRoot.id,
		anchor: `previousID=${lastRoot.id} (doc end)`,
	};
}

/** move anchor: after the section's last member — recursing into it while
 * it is a heading (a heading with an empty section is the anchor itself:
 * after-heading placement IS end-of-section there, and the fold branch has
 * nothing to jump past). A container member (list/quote) anchors on the
 * container — the walk's flattened members are exactly the section-level
 * nodes. Fold-state independent by construction: derived from walk
 * structure, never from the kernel's folded-heading branch. */
export function deriveMoveAnchor(
	destWalk: WalkedBlock[],
	toHeadingId: string | undefined,
): MoveAnchor {
	if (toHeadingId === undefined) return docEndMoveAnchor(destWalk);
	let targetId = toHeadingId;
	for (;;) {
		const section = sectionOf(destWalk, targetId);
		if (section === undefined) return docEndMoveAnchor(destWalk);
		const last = section.members.at(-1);
		if (last === undefined) {
			// Empty section: the heading itself is the anchor. Every heading
			// anchor anchors an EMPTY section — here, or in `docEndMoveAnchor`
			// when the doc's last root-level block is a heading — so the fold
			// branch has nothing to jump past and `landingId`'s "next entry
			// after" read (a heading has no subtree) holds.
			return {
				kind: "move",
				previousID: section.heading.id,
				anchor: `previousID=${section.heading.id} (end of section)`,
			};
		}
		if (last.type !== "h") {
			return {
				kind: "move",
				previousID: last.id,
				anchor: `previousID=${last.id} (end of section)`,
			};
		}
		targetId = last.id;
	}
}

/**
 * Kernel placement, stated once: the walk id a block anchored at `anchor`
 * lands on, or undefined when no entry occupies the landing position (or
 * the position is unverifiable — vanished anchor). `moveBlock` with
 * previousID=X inserts as X's next SIBLING: for a container anchor the
 * flattened walk's entry after X's whole SUBTREE (a container's descendants
 * trail it, so "the next entry" is the container's first child, not the
 * sibling — the false-rollback bug this replaces); for a heading anchor —
 * which only `deriveMoveAnchor`'s empty-section branch produces — the
 * heading is a leaf, so the landing is the walk entry immediately after it.
 * The `append` kind's landing is the container's last child (null = the
 * document root's last child). Both runMoveMode checks (pre-move no-op
 * refusal, post-move verification) ask this function — never their own
 * walk arithmetic.
 */
export function landingId(
	walk: WalkedBlock[],
	anchor: MoveAnchor,
): string | undefined {
	if (anchor.kind === "append") {
		const last =
			anchor.containerId === null
				? walk.findLast((b) => b.parentId === null)
				: walk.findLast((b) => b.parentId === anchor.containerId);
		return last?.id;
	}
	const idx = walk.findIndex((b) => b.id === anchor.previousID);
	if (idx < 0) return undefined; // vanished anchor — caller falls back
	const byId = new Map(walk.map((b) => [b.id, b] as const));
	for (let i = idx + 1; i < walk.length; i++) {
		const block = walk[i]!;
		if (!inSubtree(block, anchor.previousID, byId)) return block.id;
	}
	return undefined;
}
