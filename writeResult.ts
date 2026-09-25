// Shared write-result machinery: the baseline/fresh-content precondition and
// the echo/verification evidence (root echo, backlink check, post-write walk
// sets) every doc-targeting result shares.

import { contentHash, type ContentBaselines } from "./baselines.js";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
	blockContents,
	rootEcho,
	walkBlockTree,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import {
	errorEnvelope,
	refusedEnvelope,
	takePartialReplace,
	type Envelope,
} from "./envelope.js";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import { serveOutlineFromWalk } from "./outline.js";
import { verificationReadsFailedMessage } from "./writeVerdicts.js";

/** Establish missing baselines from blocks.content: a SQL-seeded baseline
 * against the live-tree re-check fails closed on any walk-vs-blocks form
 * drift (the refusal re-baselines and the retry proceeds), and on the
 * pinned kernel the two forms are identical. Never-served blocks only —
 * the served-preference semantics are unchanged. */
export async function establishBaselines(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	blockIds: string[],
): Promise<void> {
	const missing = blockIds.filter(
		(id) => baselines.servedHash(id) === undefined,
	);
	if (missing.length === 0) return;
	for (const row of await blockContents(kernel, missing)) {
		baselines.remember(row.id, row.content);
	}
}

/**
 * precondition, checked right before the kernel write: the current content
 * must still hash to the baseline. A mismatch →
 * `stale_content` refusal with the current content and fresh outline, no
 * kernel write fired (the message names the re-read path, never a retry).
 */
export async function assertFreshContent(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	targets: { blockId: string; baseline: string | undefined }[],
	context: { sessionId: string; docId: string },
): Promise<Envelope | null> {
	if (targets.length === 0) return null;
	// NOW rides the live tree, never the SQL index: blocks.content converges
	// 1.5–3 s after a real edit, so an index re-read is blind to a change
	// that landed inside the approval-dialog window this precondition exists
	// for. The kernel renders getChildBlocks content and blocks.content the
	// same way (live-pinned), so walk-form and SQL-form baselines hash
	// identically; a kernel that ever split them would fail closed here —
	// the refusal re-baselines and the retry proceeds.
	const walk = await walkBlockTree(kernel, context.docId);
	const current = new Map(walk.map((r) => [r.id, r.content]));
	for (const target of targets) {
		const nowContent = current.get(target.blockId);
		if (nowContent === undefined) continue; // vanished target → delete no-op class
		if (target.baseline === undefined) {
			// No-baseline fallback (same doctrine as edit's): content the
			// session never saw adopts the live form as its baseline — a
			// change nothing served cannot be refused.
			baselines.remember(target.blockId, nowContent);
			continue;
		}
		if (contentHash(nowContent) !== target.baseline) {
			// The refusal payload serves the new content — it becomes the
			// baseline, so the agent's re-read/re-target doesn't refuse-loop.
			baselines.remember(target.blockId, nowContent);
			// The refusal carries the outline's heading content — seed it like
			// every other serve site, or a follow-up edit on a served heading
			// takes the no-baseline fallback and launders a concurrent change
			// past the precondition (the target block is already remembered
			// above). The walk is already in hand — no second walk.
			const fresh = serveOutlineFromWalk(
				context.sessionId,
				"kb_write",
				walk,
				baselines,
			);
			return refusedEnvelope(
				`the content of block '${target.blockId}' changed since it was last seen in this session — re-read the current state with kb_read, then re-target (reason: stale_content)`,
				{
					reason: "stale_content",
					blockId: target.blockId,
					currentContent: nowContent,
					outline: fresh.outline,
					...(fresh.fullOutlinePath !== undefined
						? { fullOutlinePath: fresh.fullOutlinePath }
						: {}),
				},
			);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Write-result contract — echoes + verification evidence
// ---------------------------------------------------------------------------

/** Post-mutation wrapper for the verification + echo reads every write
 * runs AFTER the kernel mutation has been issued. A network drop there
 * must not surface as runKbCall's "SiYuan unreachable" envelope: the
 * mutation may already be applied, and that message invites the blind
 * retry that would duplicate or re-apply the write. Network/timeout
 * errors become a distinct `verificationFailed` error envelope; auth and
 * rate-limit errors still propagate so runKbCall keeps classifying them
 * (breaker counting, 429 cooldown). */
export async function finishWrite(
	kb: string,
	extra: Record<string, unknown>,
	build: () => Promise<Envelope>,
): Promise<Envelope> {
	try {
		return await build();
	} catch (err) {
		if (
			!(err instanceof SiYuanNetworkError) &&
			!(err instanceof SiYuanTimeoutError) &&
			// A kernel rejection mid-verification (unknown/locked id) leaves
			// the write's outcome unverified too — same envelope. Sibling of
			// auth/rate-limit, so breaker counting and 429 cooldown are not
			// affected.
			!(err instanceof SiYuanApiError)
		) {
			throw err;
		}
		const partial = takePartialReplace(err);
		// A mid-sequence failure (replace-section's delete sweep) attaches its
		// partial-apply state to the error before it lands here — the envelope
		// must carry it, or the re-run-invites-duplication hazard the sweep's
		// own catch guards against re-enters one error class over.
		return errorEnvelope(
			partial === undefined
				? verificationReadsFailedMessage(
						err instanceof Error ? err.message : String(err),
					)
				: `the write is partially applied — a mid-write step failed: ` +
						`${err instanceof Error ? err.message : String(err)} — the earlier ` +
						`steps have landed; do NOT re-run, re-fetch the outline (kb_read) ` +
						`and reconcile from the payload (deletedBlockIds/remainingBlockIds)`,
			{ ...extra, ...partial, kb, verificationFailed: true },
		);
	}
}

/** Fresh outline + root echo + content-baseline refresh — the tail every
 * doc-targeting result shares. One full
 * unfiltered walk; a pre-fetched walk (the verification evidence the flow
 * already holds) is reused instead of re-traversing. */
export async function writeEchoTail(input: {
	kernel: WriteKernelClient;
	sessionId: string;
	boxId: string;
	docId: string;
	baselines: ContentBaselines;
	walk?: WalkedBlock[] | undefined;
	/** Block IDs the write itself produced (the edited target, a
	 * newBlockId, a movedBlockId) — baselined from stored form so a
	 * follow-up edit compares like-for-like. */
	refreshBlockIds?: readonly string[] | undefined;
}): Promise<Record<string, unknown>> {
	const { kernel, sessionId, boxId, docId, baselines, refreshBlockIds } = input;
	const walk = input.walk ?? (await walkBlockTree(kernel, docId));
	// The wrapper seeds all walk headings at echo time — the SQL refresh
	// below overwrites those rows from the index read in the same call when
	// the index returns them; a missing row keeps the walk-form hash, which
	// is the same string on the pinned kernel.
	const outline = serveOutlineFromWalk(sessionId, "kb_write", walk, baselines);
	const root = await rootEcho(kernel, boxId, docId);
	const envelope: Record<string, unknown> = { outline: outline.outline };
	if (outline.fullOutlinePath !== undefined) {
		envelope.fullOutlinePath = outline.fullOutlinePath;
	}
	if (root !== undefined) {
		envelope.docId = root.docId;
		envelope.title = root.title;
		envelope.hpath = root.hpath;
	}
	// Refresh baselines only for blocks whose content the result actually
	// carried: the outline's heading rows, plus the write's own block IDs.
	// Anything else keeps its read-served baseline — a broad refresh would
	// launder a concurrent change to an unserved block past the
	// fresh-content precondition (an intervening write would make the next
	// edit on it hash-match the laundered content). The SQL read (not walk
	// rows) keeps the map's single-source invariant explicit: the walk's
	// content IS blocks.content (the kernel builds both via
	// nodeStaticContent), but a walk taken mid-write races the index
	// differently than the re-check's query path — same source, same read
	// mechanism, no representation drift.
	const refreshIds = [
		...new Set([
			...walk.filter((b) => b.type === "h").map((b) => b.id),
			...(refreshBlockIds ?? []),
		]),
	];
	if (refreshIds.length > 0) {
		for (const row of await blockContents(kernel, refreshIds)) {
			baselines.remember(row.id, row.content);
		}
	}
	return envelope;
}
