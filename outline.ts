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
	type WalkedTree,
} from "siyuan-kernel-primitives";

/**
 * Serve an outline from a walk the caller already holds (write flows render
 * the result outline from the verification walk without a second
 * traversal). Owns everything effectful: seeding (the served heading rows
 * become fresh-content baselines — outline lines carry content, and the
 * walk's content IS blocks.content, the kernel builds both via
 * nodeStaticContent), the OUTLINE_HEADINGS cut, and the spill tail. Takes
 * the whole WalkedTree, never a bare block list: the walk's incompleteness
 * fact rides the call, so no caller can serve a partial doc's prefix as
 * the whole outline — the marker below is appended here, once, for every
 * serve site.
 */
export function serveOutlineFromWalk(
	sessionId: string,
	tool: string,
	tree: WalkedTree,
	baselines: ContentBaselines,
): { outline: string; fullOutlinePath?: string } {
	const headings = headingRows(tree.blocks);
	rememberServedRows(baselines, headings);
	const { lines, incomplete } = renderExtendedOutlineLines(tree);
	let served: { outline: string; fullOutlinePath?: string };
	if (lines.length > OUTLINE_HEADINGS) {
		const path = spillFile(
			sessionId,
			`${tool}-outline`,
			jsonl(headings),
			"jsonl",
		);
		served = {
			outline:
				lines.slice(0, OUTLINE_HEADINGS).join("\n") +
				`
… ${lines.length - OUTLINE_HEADINGS} more — full heading rows (JSONL) in ${path}`,
			fullOutlinePath: path,
		};
	} else {
		served = { outline: lines.join("\n") };
	}
	if (!incomplete) return served;
	// An incomplete walk renders only its seen prefix — name it, or the
	// agent reads a partial outline as the whole doc. The wording names the
	// cause: the deterministic depth bound, or a branch that ended early
	// (vanished container / locked notebook) on a read-path walk.
	const marker = tree.truncated
		? "… (outline truncated: the document nests past the walk depth bound — deeper content is not shown)"
		: "… (outline incomplete: a container vanished or its notebook locked while reading — some branches may be missing)";
	return { ...served, outline: `${served.outline}\n${marker}` };
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
	const tree = await walkBlockTree(kernel, rootId, { tolerateVanished: true });
	// The serve wrapper owns the incompleteness marker — depth bound or
	// tolerated vanish — so a partial outline is never read as the whole doc.
	return serveOutlineFromWalk(sessionId, tool, tree, baselines);
}
