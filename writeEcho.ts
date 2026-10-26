// Write-result echo tails: the shared success/error echo reads and the
// delete receipt — the payload shaping every doc-targeting write mode's
// result calls. The failure ladder that consumes errorTail lives in
// writeLadder; the pure synchronous sentence factories both consume stay
// in writeVerdicts.

import {
	backlinkCheck,
	blockContents,
	headingRows,
	rootEcho,
	walkBlockTree,
	type WalkedTree,
} from "siyuan-kernel-primitives";
import type { WriteKernelClient } from "siyuan-kernel-primitives/write";
import { inlineOrSpill, jsonl } from "./spill.js";
import { serveOutlineFromWalk } from "./outline.js";
import type { DocTarget, WriteFlowBase } from "./writeTarget.js";

/** Error-path echo reads are garnish: the verdict (the transport message or
 * the kernel's own error) is already correct without the outline, so a
 * dropped re-read must not mask it — unwrapped, the echo's transport throw
 * would escape the flow's per-arm mapping and runKbCall would reclassify a
 * kernel-answered call as "SiYuan unreachable". Success-path echoes
 * (finishWrite) stay loud on purpose: a dropped verification read must read
 * as unverified, never as success. */
export async function errorTail(
	input: WriteFlowBase,
	doc: DocTarget,
): Promise<Record<string, unknown>> {
	try {
		return await echoTail(input, doc);
	} catch {
		return {};
	}
}

/** Cross-doc destination-outline payload — the destination outline served
 * from a verified write's post-write destination walk (the judgment's own
 * evidence — consumed verbatim, never re-fetched), baseline-seeded from
 * the serve (the anti-laundering invariant: baselines.ts). Both move
 * routes consume it; same-doc flows serve the single walk once as the
 * source echo tail and pass `{}` instead. */
export async function destOutlinePayload(
	input: WriteFlowBase,
	destWalk: WalkedTree,
): Promise<Record<string, unknown>> {
	const outline = serveOutlineFromWalk(
		input.sessionId,
		"kb_write-dest",
		destWalk,
		input.baselines,
	);
	return outline.fullOutlinePath === undefined
		? { destOutline: outline.outline }
		: {
				destOutline: outline.outline,
				destFullOutlinePath: outline.fullOutlinePath,
			};
}

/** Fresh outline + root echo + baseline seeding — the shared tail every
 * doc-targeting result calls; call sites pass an optional pre-fetched
 * verification walk and, on the success paths only, the write's own block
 * IDs (a failed write passes none — nothing of a write that did not land
 * is remembered). One full unfiltered walk; a pre-fetched walk (the
 * verification evidence the flow already holds) is reused instead of
 * re-traversing. The block IDs are the blocks the write itself produced
 * (a newBlockId, a movedBlockId) — baselined from stored form so a
 * follow-up edit compares like-for-like. The edit's target is not among
 * them: its landed verdict carries the stored row, and the flow
 * baselines from that instead of a read. Ids the serve already seeded
 * (the walk's heading rows) are skipped: the walk-seeded baseline
 * stands, and the refresh can never overwrite served content with an
 * asynchronously-converged row (the anti-laundering invariant:
 * baselines.ts). */
export async function echoTail(
	input: WriteFlowBase,
	doc: DocTarget,
	walk?: WalkedTree | undefined,
	refreshBlockIds?: readonly string[],
): Promise<Record<string, unknown>> {
	const { kernel, sessionId, boxId, baselines } = input;
	const docId = doc.rootId;
	const fullWalk = walk ?? (await walkBlockTree(kernel, docId));
	// The serve seeds every walk heading's baseline, and nothing later
	// overwrites it: the baseline is exactly the snapshot the result serves
	// (the anti-laundering invariant: baselines.ts).
	const outline = serveOutlineFromWalk(
		sessionId,
		"kb_write",
		fullWalk,
		baselines,
	);
	const root = await rootEcho(kernel, boxId, docId);
	const envelope: Record<string, unknown> = { ...outline };
	if (root !== undefined) {
		envelope.docId = root.docId;
		envelope.title = root.title;
		envelope.hpath = root.hpath;
	}
	// The only SQL-form baseline seed here is the write's own blocks:
	// submitted markdown is re-parsed by the kernel, so the stored form is
	// knowable only by reading it back. Served rows keep their walk-seeded
	// baseline (the anti-laundering invariant: baselines.ts) — the filter
	// drops every refresh id the serve seeded, so a broad id list (e.g. a
	// section move's heading-plus-members) cannot launder an
	// asynchronously-converged row over served content.
	if (refreshBlockIds?.length) {
		const served = new Set(headingRows(fullWalk.blocks).map((row) => row.id));
		const refresh = refreshBlockIds.filter((id) => !served.has(id));
		if (refresh.length > 0) {
			for (const row of await blockContents(kernel, [...refresh])) {
				baselines.remember(row.id, row.content);
			}
		}
	}
	return envelope;
}

/** The delete receipt: what a delete-bearing op removed — block ids and
 * their walk content, covering both the members the delete leg deleted
 * explicitly and the descendants the kernel's cascade took with them
 * (the closure is exactly what left the doc). Built from the walk the
 * flow already holds — zero extra kernel calls. Inline within the shared
 * preview budget; overflow spills the full JSONL and the pointer rides as
 * a sibling field, the same contract as `outline`/`fullOutlinePath`. */
export function deletedBlocksTail(
	sessionId: string,
	blocks: { id: string; content: string | null }[],
): Record<string, unknown> {
	const rows = blocks.map((b) => ({ blockId: b.id, content: b.content }));
	const { inline, spillPath } = inlineOrSpill(
		sessionId,
		"kb_write-deleted-blocks",
		jsonl(rows),
		"jsonl",
	);
	if (spillPath === undefined) return { deletedBlocks: rows };
	return { deletedBlocksPreview: inline, deletedBlocksPath: spillPath };
}

/** The delete receipt's orphan-ref evidence — the backlink-check read
 * and the "N doc(s) with orphaned refs" clause every delete-shaped
 * receipt words. The id set is the caller's (the doc's
 * pre-delete walk, the deleted block, the section's judged closure); the
 * read runs post-mutation only — arms that cannot state a trustworthy
 * deleted set must not call this. */
export async function orphanedRefs(
	kernel: WriteKernelClient,
	ids: string[],
): Promise<{
	invalidRefs: Awaited<ReturnType<typeof backlinkCheck>>;
	clause: string;
}> {
	const invalidRefs = await backlinkCheck(kernel, ids);
	return {
		invalidRefs,
		clause: `${invalidRefs.count} doc(s) with orphaned refs`,
	};
}
