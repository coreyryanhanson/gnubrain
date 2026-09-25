// Outline rendering — tool-surface presentation of a block-tree walk:
// level marks, container glyphs, the `→ <id>` payload, the inline cap, and
// the spill tail. The pure core is session-blind; everything effectful
// (baseline seeding, the OUTLINE_HEADINGS cut, spilling) lives in the serve
// wrappers, so no caller can serve an outline without seeding.

import { rememberServedRows, type ContentBaselines } from "./baselines.js";
import { OUTLINE_HEADINGS, jsonl, spillFile } from "./spill.js";
import {
	TARGETABLE_CONTAINER_TYPES,
	headingLevel,
	walkBlockTree,
	type KernelReadClient,
	type WalkedBlock,
} from "siyuan-kb-primitives";

/** Container prefix for one enclosing block, glued to the level marks:
 * markdown-native symbols where the container exists in markdown (`>`
 * quote, `-` list/item), the wire type's letter where SiYuan-specific
 * (`c` callout, `s` superblock, `t` tab), and a bracketed token for a
 * container with no defined glyph (`[tabs]`, a refused kind; the wire
 * type itself, e.g. `[callout]`, for a targetable type the table has
 * not learned; `[unnamed]`, truly unknown). No token contains `#`, so the
 * trailing run of `#` before the first space is always the level.
 *
 * The `default` arm keys on TARGETABLE_CONTAINER_TYPES so the glyph
 * table can never disagree with the write-side container pin: a type
 * the primitives accept as a write parent always renders as its own
 * bracketed name, never as `[unnamed]` (which would misrepresent a
 * writable container). The unit suite pins this coupling. */
export function containerPrefix(c: WalkedBlock): string {
	switch (c.type) {
		case "b":
			return ">";
		case "callout":
			return "c";
		case "l":
		case "i":
			return "-";
		case "s":
			return "s";
		case "tab":
			return "t";
		case "tabs":
			return "[tabs]";
		case "d":
			return "";
		default:
			// The write side accepts it (primitives pin), the glyph table does
			// not know it yet — name it by its wire type rather than lie.
			return TARGETABLE_CONTAINER_TYPES.has(c.type)
				? `[${c.type}]`
				: "[unnamed]";
	}
}

/** Outline lines from a walk already in hand — pure and session-blind:
 * level marks + the container prefix outermost-first + the `→ <id>`
 * payload + `(not targetable)` on refused kinds. No `sessionId`, no
 * `tool`, no baselines, no spill; deterministic. This is the logic that
 * must never diverge from the primitives' section rule (`headingLevel` is
 * shared with it; the placement corpus pins the rule in the primitives). */
export function renderOutlineLines(walk: WalkedBlock[]): string[] {
	const headings = walk.filter((b) => b.type === "h");
	const byId = new Map(walk.map((b) => [b.id, b]));
	return headings.map((h) => {
		const level = headingLevel(h);
		// The enclosing container chain, innermost first, from exact parentage
		// (headings are never recursed into, so every ancestor is a container).
		const chain: WalkedBlock[] = [];
		for (
			let c = h.parentId ? byId.get(h.parentId) : undefined;
			c;
			c = c.parentId ? byId.get(c.parentId) : undefined
		) {
			chain.push(c);
		}
		// Rendered outermost-first; a list directly wrapping the item renders
		// through the item's bullet, not a second one. Targetability reads the
		// immediate parent only — the same block CheckContainerParent validates.
		const prefixes: string[] = [];
		for (let i = chain.length - 1; i >= 0; i--) {
			const c = chain[i];
			if (!c) continue;
			// chain is innermost-first: the item inside this list sits at i-1.
			if (c.type === "l" && chain[i - 1]?.type === "i") continue;
			prefixes.push(containerPrefix(c));
		}
		const targetable = TARGETABLE_CONTAINER_TYPES.has(h.parentType ?? "");
		return `${prefixes.join("")}${"#".repeat(level)} ${h.content} → ${h.id}${targetable ? "" : " (not targetable)"}`;
	});
}

/**
 * Serve an outline from a walk the caller already holds (write flows render
 * the result outline from the verification walk without a second
 * traversal). Owns everything effectful: seeding (the served heading rows
 * become fresh-content baselines — outline lines carry content, and the
 * walk's content IS blocks.content, the kernel builds both via
 * nodeStaticContent), the OUTLINE_HEADINGS cut, and the spill tail.
 */
export function serveOutlineFromWalk(
	sessionId: string,
	tool: string,
	walk: WalkedBlock[],
	baselines: ContentBaselines,
): { outline: string; fullOutlinePath?: string } {
	const headings = walk.filter((b) => b.type === "h");
	rememberServedRows(baselines, headings);
	const lines = renderOutlineLines(walk);
	if (lines.length > OUTLINE_HEADINGS) {
		const path = spillFile(
			sessionId,
			`${tool}-outline`,
			jsonl(headings),
			"jsonl",
		);
		return {
			outline:
				lines.slice(0, OUTLINE_HEADINGS).join("\n") +
				`\n… ${lines.length - OUTLINE_HEADINGS} more — full outline in ${path}`,
			fullOutlinePath: path,
		};
	}
	return { outline: lines.join("\n") };
}

/** Outline ride-along: render from a fresh unfiltered walk of the doc
 * root — the read-path entry point opts into tolerateVanished. */
export async function serveOutline(
	kernel: KernelReadClient,
	sessionId: string,
	tool: string,
	rootId: string,
	baselines: ContentBaselines,
): Promise<{ outline: string; fullOutlinePath?: string }> {
	return serveOutlineFromWalk(
		sessionId,
		tool,
		await walkBlockTree(kernel, rootId, { tolerateVanished: true }),
		baselines,
	);
}
