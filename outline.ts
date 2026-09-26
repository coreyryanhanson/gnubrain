// Outline serving — the effectful half of outline presentation: baseline
// seeding, the OUTLINE_HEADINGS inline cut, and the spill tail. The pure
// notation itself (`renderExtendedOutlineLines`) is the primitives' read
// barrel's canonical extended outline; the wrappers import it so the
// served lines and the write-side section rule cannot diverge. No caller
// can serve an outline without seeding.

import { rememberServedRows, type ContentBaselines } from "./baselines.js";
import { OUTLINE_HEADINGS, jsonl, spillFile } from "./spill.js";
import {
	headingRows,
	renderExtendedOutlineLines,
	walkBlockTree,
	type KernelReadClient,
	type WalkedBlock,
} from "siyuan-kb-primitives";

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
	const headings = headingRows(walk);
	rememberServedRows(baselines, headings);
	const lines = renderExtendedOutlineLines(walk);
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
