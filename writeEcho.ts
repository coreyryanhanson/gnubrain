// Write-result echo tails: the shared failure-ladder binding, the
// success/error echo reads, and the delete receipt — the payload shaping
// every doc-targeting write mode's result calls.

import type { Envelope } from "./envelope.js";
import {
	blockContents,
	rootEcho,
	walkBlockTree,
	type WalkedTree,
} from "siyuan-kb-primitives";
import type { MutationFailure } from "siyuan-kb-primitives/write";
import { mutationFailureEnvelope } from "./writeVerdicts.js";
import { inlineOrSpill, jsonl } from "./spill.js";
import { serveOutlineFromWalk } from "./outline.js";
import type { DocTarget, WriteFlowBase } from "./writeTarget.js";

/** Error-path echo reads are garnish: the verdict (the transport message or
 * the kernel's own error) is already correct without the outline, so a
 * dropped re-read must not mask it — unwrapped, the echo's transport throw
 * would escape the flow's per-arm mapping and runKbCall would reclassify a
 * kernel-answered call as "SiYuan unreachable". Success-path echoes
 * (finishWrite) stay loud on purpose: a dropped verification read must read
 * as unverified, never as success. The flows reach this rule through
 * mutationFailure's tail thunk; nothing imports it directly. */
async function errorTail(
	input: WriteFlowBase,
	doc: DocTarget,
): Promise<Record<string, unknown>> {
	try {
		return await echoTail(input, doc);
	} catch {
		return {};
	}
}

/** The shared failure ladder's flow-side binding — every mode's
 * non-judged arms differ only in the verdict key (extra); the kb name and
 * the error-path echo tail are the same at every site. The one exception
 * is the doc move's failure legs (empty tail, the pinned no-doc-target
 * shape), which bind mutationFailureEnvelope directly. */
export function mutationFailure(
	outcome: MutationFailure,
	input: WriteFlowBase,
	doc: DocTarget,
	extra: { anchor: string } | { blockId: string } | { docId: string },
): Promise<Envelope> {
	return mutationFailureEnvelope(outcome, {
		kb: input.name,
		extra,
		tail: () => errorTail(input, doc),
	});
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
 * them: its landed verdict carries the stored pair, and the flow
 * baselines from that instead of a read. */
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
	// overwrites it: the baseline is exactly the snapshot the result
	// serves. A post-walk read would either repeat the same strings (the
	// walk ≡ SQL equivalence) or launder a concurrent change or a stale
	// index row into the baseline past the fresh-content precondition.
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
	// baseline — a broad refresh would launder a concurrent change past
	// the fresh-content precondition (an intervening write would make the
	// next edit on it hash-match laundered content).
	if (refreshBlockIds?.length) {
		for (const row of await blockContents(kernel, [...refreshBlockIds])) {
			baselines.remember(row.id, row.content);
		}
	}
	return envelope;
}

/** The delete receipt: what a delete-bearing op removed — block ids and
 * their walk content, covering both the members the sweep deleted
 * explicitly and the descendants the kernel's cascade took with them
 * (the closure is exactly what left the doc). Built from the walk the
 * flow already holds — zero extra kernel calls. Inline within the shared
 * preview budget; overflow spills the full JSONL and the pointer rides as
 * a sibling field, the same contract as `outline`/`fullOutlinePath`. */
export function deletedBlocksTail(
	sessionId: string,
	blocks: { id: string; content: string | null }[],
): Record<string, unknown> {
	const rows = blocks.map((b) => ({ id: b.id, content: b.content }));
	const { inline, spillPath } = inlineOrSpill(
		sessionId,
		"kb_write-deleted-blocks",
		jsonl(rows),
		"jsonl",
	);
	if (spillPath === undefined) return { deletedBlocks: rows };
	return { deletedBlocksPreview: inline, deletedBlocksPath: spillPath };
}
