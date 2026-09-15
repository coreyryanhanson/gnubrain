// Anchors + section slicing — always tool-derived, never agent-supplied.
// Pure functions over the document-order walk, so they are
// fold-state-independent and independently testable.

import type { WalkedBlock } from "./tools.js";

/** `appendBlock` on the doc root — the doc-end fallback (anchor echo). */
const DOC_END_ANCHOR = "appendBlock(root) — no next heading";

/**
 * `append`/replace-section anchor (pinned): `nextID` = the NEXT heading
 * in document order — never a last-block or heading anchor (the list/quote
 * nesting trap). The heading-only outline IS the anchor data; a walk
 * node's position decides. No next heading (target IS the last heading, or
 * no heading given) → `appendBlock` on the doc root.
 */
export function deriveAppendAnchor(
	walk: WalkedBlock[],
	headingId: string | undefined,
):
	| { kind: "insert"; nextID: string; anchor: string }
	| { kind: "appendRoot"; anchor: string } {
	if (headingId !== undefined) {
		const index = walk.findIndex((b) => b.id === headingId && b.type === "h");
		if (index >= 0) {
			const next = walk.slice(index + 1).find((b) => b.type === "h");
			if (next !== undefined) {
				return {
					kind: "insert",
					nextID: next.id,
					anchor: `nextID=${next.id} (next heading)`,
				};
			}
		}
	}
	return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
}

/**
 * delete-set enumeration — the getChildBlocks document-order walk, never
 * SQL. The section slice runs from the
 * target heading to the next heading of same-or-shallower depth; the target
 * heading itself survives (the new body lands under it, preserving its ID
 * and every ref into it). Deeper headings inside the section belong to it.
 * Final section (no boundary): the slice runs to end of doc, sweeping
 * trailing non-heading content.
 */
export function sectionDeleteSet(
	walk: WalkedBlock[],
	headingId: string,
): WalkedBlock[] {
	const target = walk.find((b) => b.id === headingId && b.type === "h");
	if (target === undefined) return []; // caller refuses an unresolvable target
	const targetIndex = walk.indexOf(target);
	const targetLevel = Number(String(target.subType).slice(1)) || 1;
	const slice: WalkedBlock[] = [];
	for (let i = targetIndex + 1; i < walk.length; i++) {
		const block = walk[i];
		if (block === undefined) break;
		if (block.type === "h") {
			const level = Number(String(block.subType).slice(1)) || 1;
			if (level <= targetLevel) break; // same-or-shallower boundary
		}
		slice.push(block);
	}
	return slice;
}

/**
 * move anchor: the last top-level node of the toHeadingId section,
 * heading-recursed (a section ending in a subheading → after the
 * subsection, not inside it); list/quote containers end at section level —
 * the walk's depth axis never descends INTO a container for this choice.
 * Fold-state independent by construction: derived from walk order, never
 * from the kernel's folded-heading branch. Falls back to doc end (the same
 * `appendBlock`-on-root default as `append`).
 */
export function deriveMoveAnchor(
	destWalk: WalkedBlock[],
	toHeadingId: string | undefined,
):
	| { kind: "move"; previousID: string; anchor: string }
	| { kind: "appendRoot"; anchor: string } {
	if (toHeadingId === undefined) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const headingIndex = destWalk.findIndex(
		(b) => b.id === toHeadingId && b.type === "h",
	);
	if (headingIndex < 0) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const heading = destWalk[headingIndex];
	if (heading === undefined) {
		return { kind: "appendRoot", anchor: DOC_END_ANCHOR };
	}
	const headingDepth = heading.depth;
	const headingLevel = Number(String(heading.subType).slice(1)) || 1;
	// Section members after the heading until the same-or-shallower boundary.
	const members: WalkedBlock[] = [];
	for (let i = headingIndex + 1; i < destWalk.length; i++) {
		const block = destWalk[i];
		if (block === undefined) break;
		if (block.type === "h") {
			const level = Number(String(block.subType).slice(1)) || 1;
			if (level <= headingLevel) break;
		}
		members.push(block);
	}
	// Last member at the heading's own container depth — recursing through a
	// subheading's section (its content sits at the same walk depth), never
	// into a list/quote container (deeper blocks are skipped by the depth
	// test, so the anchor stays at section level)..
	let anchor: WalkedBlock | undefined;
	for (let i = members.length - 1; i >= 0; i--) {
		const member = members[i];
		if (member !== undefined && member.depth <= headingDepth) {
			anchor = member;
			break;
		}
	}
	if (anchor === undefined) {
		// Empty section: the heading itself is the last top-level node —
		// after-heading placement IS end-of-section there, and the fold
		// branch has nothing to jump past.
		return {
			kind: "move",
			previousID: heading.id,
			anchor: `previousID=${heading.id} (end of section)`,
		};
	}
	if (anchor.type === "h") {
		// Section ends in a subheading: step into it — its section's last
		// top-level node is the anchor (heading-recursed rule).
		return deriveMoveAnchor(destWalk, anchor.id);
	}
	return {
		kind: "move",
		previousID: anchor.id,
		anchor: `previousID=${anchor.id} (end of section)`,
	};
}
