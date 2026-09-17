// Shared write-result machinery: the baseline/fresh-content precondition and
// the echo/verification evidence (root echo, backlink check, post-write walk
// sets) every doc-targeting result shares.

import { contentHash, type ContentBaselines } from "./baselines.js";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
	type BlockTransaction,
} from "siyuan-kernel-api";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { sqlString, type WriteKernelClient } from "./kernel.js";
import {
	renderOutlineFromWalk,
	walkBlockTree,
	type WalkedBlock,
} from "./walk.js";

interface BaselineView {
	blockId: string;
	content: string;
}

function rowsToBaselineView(rows: Record<string, unknown>[]): BaselineView[] {
	return rows.map((r) => ({
		blockId: String(r.id),
		content: String(r.content),
	}));
}

/** SELECT heads the kernel stubs route on — keep builders and heads in
 * sync by construction (each builder concatenates its head constant). */
export const BASELINE_CONTENTS_STMT_HEAD =
	"SELECT id, content FROM blocks WHERE id IN";
export const REFERRING_HPATHS_STMT_HEAD =
	"SELECT DISTINCT hpath FROM blocks WHERE root_id IN";
export const ROOT_ECHO_STMT_HEAD = "SELECT root_id, content, hpath FROM blocks";

function baselineContentsStmt(ids: string[]): string {
	return (
		`${BASELINE_CONTENTS_STMT_HEAD} ` + `(${ids.map(sqlString).join(", ")})`
	);
}

/** Establish missing baselines from the same source the re-check reads
 * (blocks.content): baseline and re-check must hash the same
 * representation, or any walk-vs-blocks rendering drift false-positives
 * every precondition as stale_content. Never-served blocks only — the
 * served-preference semantics are unchanged. */
export async function establishBaselines(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	blockIds: string[],
): Promise<void> {
	const missing = blockIds.filter(
		(id) => baselines.servedHash(id) === undefined,
	);
	if (missing.length === 0) return;
	for (const row of rowsToBaselineView(
		await kernel.query(baselineContentsStmt(missing)),
	)) {
		baselines.remember(row.blockId, row.content);
	}
}

/**
 * precondition, re-checked after confirmation approval, before any kernel
 * write: the current content must still hash to the baseline. A mismatch →
 * `stale_content` refusal with the current content and fresh outline, no
 * kernel write fired (the message names the re-read path, never a retry).
 */
export async function assertFreshContent(
	kernel: WriteKernelClient,
	baselines: ContentBaselines,
	targets: { blockId: string; baseline: string | undefined }[],
	context: { sessionId: string; docId: string } | undefined,
): Promise<Envelope | null> {
	if (targets.length === 0) return null;
	// Raw current content — never through the served-preference read: the
	// precondition compares the kernel's NOW against the baseline.
	const currentRows = await kernel.query(
		baselineContentsStmt(targets.map((t) => t.blockId)),
	);
	const current = new Map(
		rowsToBaselineView(currentRows).map((r) => [r.blockId, r.content]),
	);
	for (const target of targets) {
		const nowContent = current.get(target.blockId);
		if (nowContent === undefined) continue; // vanished target → delete no-op class
		if (contentHash(nowContent) !== target.baseline) {
			const currentContent = nowContent;
			// The refusal payload serves the new content — it becomes the
			// baseline, so the agent's re-read/re-target doesn't refuse-loop.
			baselines.remember(target.blockId, currentContent);
			let outline: Record<string, unknown> = {};
			if (context !== undefined) {
				// The refusal payload carries the outline's heading content — seed
				// it like every other serve site, or a follow-up edit on a served
				// heading takes the no-baseline fallback and launders a concurrent
				// change past the precondition (the target block itself is already
				// remembered above).
				const fresh = renderOutlineFromWalk(
					context.sessionId,
					"kb_write",
					await walkBlockTree(kernel, context.docId),
					baselines,
				);
				outline = {
					outline: fresh.outline,
					...(fresh.fullOutlinePath !== undefined
						? { fullOutlinePath: fresh.fullOutlinePath }
						: {}),
				};
			}
			return refusedEnvelope(
				`the content of block '${target.blockId}' changed since it was last seen in this session — re-read the current state with kb_read, then re-target (reason: stale_content)`,
				{
					reason: "stale_content",
					blockId: target.blockId,
					currentContent,
					...outline,
				},
			);
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Write-result contract — echoes + verification evidence
// ---------------------------------------------------------------------------

/** `data[0].doOperations[0].id` — the pinned response shape (write-result
 * contract; the minted ID serializes as the first insert operation's id). */
export function newBlockIdFrom(tx: BlockTransaction[]): string | undefined {
	return tx[0]?.doOperations[0]?.id;
}

export const REFS_BACKLINK_STMT_HEAD =
	"SELECT DISTINCT root_id FROM refs WHERE def_block_id IN";

function refsBacklinkStmt(ids: string[]): string {
	return `${REFS_BACKLINK_STMT_HEAD} (${ids.map(sqlString).join(", ")})`;
}

/** Referring docs' display paths — the confirmation's "who cites this" list. */
function referringHpathsStmt(rootIds: string[]): string {
	return (
		`${REFERRING_HPATHS_STMT_HEAD} ` + `(${rootIds.map(sqlString).join(", ")})`
	);
}

/** Inbound block-refs over the delete set (delete mode) — same documented
 * SQL surface as every read; the count is advisory (the derived refs index
 * can lag). */
export async function backlinkCheck(
	kernel: WriteKernelClient,
	ids: string[],
): Promise<{ count: number; hpaths: string[] }> {
	if (ids.length === 0) return { count: 0, hpaths: [] };
	const rows = await kernel.query(refsBacklinkStmt(ids));
	const rootIds = [...new Set(rows.map((r) => String(r.root_id)))];
	if (rootIds.length === 0) return { count: 0, hpaths: [] };
	const hpathRows = await kernel.query(referringHpathsStmt(rootIds));
	return {
		count: rootIds.length,
		hpaths: hpathRows.map((r) => String(r.hpath)),
	};
}

/** Root row echo (write-result contract): root docId + stored title +
 * real hpath — display plus the echoed target R1 requires. */
export async function rootEcho(
	kernel: WriteKernelClient,
	boxId: string,
	docId: string,
): Promise<{ docId: string; title: string; hpath: string } | undefined> {
	const rows = await kernel.query(rootEchoStmt(boxId, docId));
	const row = rows[0];
	return row === undefined
		? undefined
		: {
				docId: String(row.root_id),
				title: String(row.content),
				hpath: String(row.hpath),
			};
}

function rootEchoStmt(boxId: string, docId: string): string {
	return (
		`${ROOT_ECHO_STMT_HEAD} ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(docId)} AND type = 'd'`
	);
}

export function idSet(walk: WalkedBlock[]): Set<string> {
	return new Set(walk.map((b) => b.id));
}

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
		return errorEnvelope(
			`the write call returned success but the post-write verification reads failed: ` +
				`${err instanceof Error ? err.message : String(err)} — the write's ` +
				`outcome is unverified; do NOT retry blindly, re-fetch the outline ` +
				`(kb_read) and confirm the write landed before repeating it`,
			{ ...extra, kb, verificationFailed: true },
		);
	}
}

/** Fresh outline + root echo + content-baseline refresh — the tail every
 * doc-targeting result shares (write-result contract). One full
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
	const outline = renderOutlineFromWalk(sessionId, "kb_write", walk);
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
		for (const row of rowsToBaselineView(
			await kernel.query(baselineContentsStmt(refreshIds)),
		)) {
			baselines.remember(row.blockId, row.content);
		}
	}
	return envelope;
}
