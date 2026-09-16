// getChildBlocks walk + outline rendering — never SQL enumeration
// (the `sort` column is a type weight, not document order). Shared by
// kb_read and the write flow (duplicate-stop rows, create echo, and the
// write-verification evidence itself).

import { SiYuanApiError } from "siyuan-kernel-api";
import { rememberServedRows, type ContentBaselines } from "./baselines.js";
import type { KernelReadClient } from "./tools.js";
import { OUTLINE_HEADINGS, jsonl, spillFile } from "./spill.js";

/** Extension-owned recursion bound for the getChildBlocks walk — the kernel
 * imposes no cap on block-container nesting, so this keeps the walk finite
 * (the 7-level cap counts hpath separators, a different axis). */
const MAX_WALK_DEPTH = 32;

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
		await walkBlockTree(kernel, rootId, 1, { tolerateVanished: true }),
		baselines,
	);
}

/** Outline rendering from a walk already in hand — write flows render the
 * result outline from the verification walk without a second traversal.
 * When baselines is passed, the served heading rows seed the fresh-content
 * baselines: outline lines carry content, and the walk's content IS
 * blocks.content (the kernel builds both via nodeStaticContent). */
export function renderOutlineFromWalk(
	sessionId: string,
	tool: string,
	walk: WalkedBlock[],
	baselines?: ContentBaselines,
): { outline: string; fullOutlinePath?: string } {
	const headings = walk.filter((b) => b.type === "h");
	if (baselines !== undefined) rememberServedRows(baselines, headings);
	const lines = headings.map((h) => {
		const level = Number(String(h.subType ?? "h1").slice(1)) || 1;
		return `${"  ".repeat(level - 1)}${h.content} → ${h.id}`;
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
	/** Container depth in the walk (root's direct children = 1). Headings
	 * are leaf blocks, so their section content sits at the heading's own
	 * depth — depth is what keeps move-anchor derivation at section level. */
	depth: number;
}

interface NestedBlock extends WalkedBlock {
	children: NestedBlock[];
}

/** getChildBlocks walk preserving container structure. Headings are
 * leaves; only real containers (lists, blockquotes, superblocks) nest.
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
			depth,
			children: [],
		};
		node.children = await walkBlockTreeNested(
			kernel,
			node.id,
			depth + 1,
			tolerateVanished,
		);
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
	depth: number,
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
	flatten(
		await walkBlockTreeNested(
			kernel,
			rootId,
			depth,
			opts?.tolerateVanished ?? false,
		),
	);
	return flat;
}
