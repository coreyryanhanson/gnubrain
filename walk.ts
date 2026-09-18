// getChildBlocks walk + outline rendering — never SQL enumeration
// (the `sort` column is a type weight, not document order). Shared by
// kb_read and the write flow (duplicate-stop rows, create echo, and the
// write-verification evidence itself).

import { SiYuanApiError } from "siyuan-kernel-api";
import { rememberServedRows, type ContentBaselines } from "./baselines.js";
import type { KernelReadClient } from "./kernel.js";
import { OUTLINE_HEADINGS, jsonl, spillFile } from "./spill.js";

/** Extension-owned recursion bound for the getChildBlocks walk — the kernel
 * imposes no cap on block-container nesting, so this keeps the walk finite
 * (the 7-level cap counts hpath separators, a different axis). */
export const MAX_WALK_DEPTH = 32;

/** Outline ride-along: render from a fresh unfiltered walk of the doc
 * root — the read-path entry point opts into tolerateVanished. */
export async function renderOutline(
	kernel: KernelReadClient,
	sessionId: string,
	tool: string,
	rootId: string,
	baselines?: ContentBaselines,
): Promise<{ outline: string; fullOutlinePath?: string }> {
	return renderOutlineFromWalk(
		sessionId,
		tool,
		await walkBlockTree(kernel, rootId, { tolerateVanished: true }),
		baselines,
	);
}

/** The container kinds a section-targeted write may anchor in
 * (d/b/callout/i/l/s/tab) — the kernel's write-parent set
 * (CheckContainerParent → IsContainerType). Anything else — `tabs`, an
 * unnamed container — is refused by `headingInWalk` and renders
 * `(not targetable)` in the outline. Targetability is a property of the
 * immediate parent only, matching the kernel check it mirrors. */
export const TARGETABLE_CONTAINER_TYPES: ReadonlySet<string> = new Set([
	"d",
	"b",
	"callout",
	"i",
	"l",
	"s",
	"tab",
]);

/** Container prefix for one enclosing block, glued to the level marks:
 * markdown-native symbols where the container exists in markdown (`>`
 * quote, `-` list/item), the wire type's letter where SiYuan-specific
 * (`c` callout, `s` superblock, `t` tab), and a bracketed token for the
 * refused kinds (`[tabs]`, `[unnamed]`). No token contains `#`, so the
 * trailing run of `#` before the first space is always the level. */
function containerPrefix(c: WalkedBlock): string {
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
			return "[unnamed]";
	}
}

/** The heading level from the subType ("h3" → 3); a missing subType
 * reads as level 1. One rule shared by the outline and the anchor/section
 * logic, so the rendered nesting can never diverge from section bounds. */
export function headingLevel(block: WalkedBlock): number {
	return Number(String(block.subType).slice(1)) || 1;
}

/** Outline rendering from a walk already in hand — write flows render the
 * result outline from the verification walk without a second traversal.
 * When baselines is passed, the served heading rows seed the fresh-content
 * baselines: outline lines carry content, and the walk's content IS
 * blocks.content (the kernel builds both via nodeStaticContent).
 *
 * Outline notation: level marks + the container prefix outermost-first +
 * the `→ <id>` payload + `(not targetable)` on refused kinds. */
export function renderOutlineFromWalk(
	sessionId: string,
	tool: string,
	walk: WalkedBlock[],
	baselines?: ContentBaselines,
): { outline: string; fullOutlinePath?: string } {
	const headings = walk.filter((b) => b.type === "h");
	if (baselines !== undefined) rememberServedRows(baselines, headings);
	const byId = new Map(walk.map((b) => [b.id, b]));
	const lines = headings.map((h) => {
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

export interface WalkedBlock {
	id: string;
	type: string;
	subType: string;
	content: string;
	/** Enclosing block's id — null for the document root's children. The
	 * exact ancestry fact: no consumer derives parentage from depth. */
	parentId: string | null;
	/** Enclosing block's type — "d" for the document root's children. */
	parentType: string | null;
}

interface NestedBlock extends WalkedBlock {
	children: NestedBlock[];
}

/** Wire block types whose getChildBlocks returns real tree children: the
 * kernel's own container set (d/b/l/i/s/callout) plus lute's nested tabs.
 * The empty type — a block the kernel's abbreviation map does not name, e.g.
 * a footnote definition — nests too: the fail-safe direction.
 *
 * Heading (`h`) is deliberately absent even though the kernel answers a
 * heading with its SECTION (following siblings up to the next heading of
 * same-or-higher level): every one of those blocks is already returned by
 * the loop over the container that owns the heading, so recursing into `h`
 * re-emits them out of document order. */
const CONTAINER_TYPES: ReadonlySet<string> = new Set([
	"d",
	"b",
	"l",
	"i",
	"s",
	"callout",
	"tabs",
	"tab",
]);

function nests(type: string): boolean {
	return CONTAINER_TYPES.has(type) || type === "";
}

/** getChildBlocks walk preserving container structure: recursion follows
 * `nests` (the kernel's container types), so every block is visited exactly
 * once, in document order.
 *
 * Errors propagate — including SiYuanApiError (unknown/locked block id):
 * this walk is the post-write verification evidence, and a swallowed
 * error would read an empty walk as "target gone" behind HTTP success.
 * The read outline opts into tolerance: a container deleted concurrently
 * mid-kb_read shortens the outline instead of failing the read. */
async function walkBlockTreeNested(
	kernel: KernelReadClient,
	rootId: string,
	depth: number,
	tolerateVanished: boolean,
	parentId: string | null,
	parentType: string | null,
): Promise<NestedBlock[]> {
	if (depth > MAX_WALK_DEPTH) return [];
	let children: Record<string, unknown>[];
	try {
		children = await kernel.getChildBlocks(rootId);
	} catch (err) {
		// A vanished container mid-walk ends that branch, not the doc — but
		// only genuine API misses (the error base's remaining subclasses:
		// auth/rate-limit classify in runKbCall; network/timeout must
		// propagate).
		if (!tolerateVanished || !(err instanceof SiYuanApiError)) throw err;
		return [];
	}
	const nodes: NestedBlock[] = [];
	for (const child of children) {
		const node: NestedBlock = {
			id: String(child.id),
			type: String(child.type ?? ""),
			subType: String(child.subType ?? ""),
			content: String(child.content ?? ""),
			parentId,
			parentType,
			children: [],
		};
		if (nests(node.type)) {
			node.children = await walkBlockTreeNested(
				kernel,
				node.id,
				depth + 1,
				tolerateVanished,
				node.id,
				node.type,
			);
		}
		nodes.push(node);
	}
	return nodes;
}

/** Full unfiltered getChildBlocks walk in document order. The heading filter
 * is rendering-only — callers keep the full set as write-verification
 * evidence. tolerateVanished: a SiYuanApiError (unknown/locked id, e.g. a
 * container deleted concurrently) ends that branch instead of propagating —
 * for read-path outlines only; write verification stays strict. */
export async function walkBlockTree(
	kernel: KernelReadClient,
	rootId: string,
	opts?: { tolerateVanished?: boolean },
): Promise<WalkedBlock[]> {
	const flat: WalkedBlock[] = [];
	function flatten(nodes: NestedBlock[]): void {
		for (const node of nodes) {
			const { children: _children, ...block } = node;
			flat.push(block);
			flatten(node.children);
		}
	}
	// Entry depth is always 1 (root's direct children); the recursion drives
	// it deeper and bounds the walk. Exposing it would let a caller silently
	// truncate every walk. Every entry call roots at a document (the callers
	// pass doc ids), so the root's children carry the document root's
	// parentage: null id, type "d".
	flatten(
		await walkBlockTreeNested(
			kernel,
			rootId,
			1,
			opts?.tolerateVanished ?? false,
			null,
			"d",
		),
	);
	return flat;
}
