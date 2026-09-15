// Shared write-result machinery: the structural kernel client the write
// tools need, the session-scoped fresh-content baselines, and the
// echo/verification evidence (root echo, backlink check, post-write walk
// sets) every doc-targeting result shares.

import { createHash } from "node:crypto";
import type { BlockTransaction } from "siyuan-kernel-api";
import { refusedEnvelope, type Envelope } from "./envelope.js";
import {
	renderOutlineFromWalk,
	sqlString,
	walkBlockTree,
	type KernelReadClient,
	type WalkedBlock,
} from "./tools.js";
import type { KernelProbeClient } from "./validation.js";

/** Structural client subset the write tools need (tests stub it). */
export interface WriteKernelClient extends KernelReadClient, KernelProbeClient {
	createDocWithMarkdown(params: {
		notebook: string;
		path: string;
		markdown: string;
		parentID?: string;
	}): Promise<string>;
	updateBlock(params: {
		id: string;
		data: string;
	}): Promise<BlockTransaction[]>;
	insertBlock(params: {
		data: string;
		nextID?: string;
		previousID?: string;
		parentID?: string;
	}): Promise<BlockTransaction[]>;
	appendBlock(params: {
		data: string;
		parentID: string;
	}): Promise<BlockTransaction[]>;
	deleteBlock(id: string): Promise<BlockTransaction[]>;
	moveBlock(params: {
		id: string;
		previousID?: string;
		parentID?: string;
	}): Promise<null>;
	removeDocByID(id: string): Promise<null>;
	moveDocsByID(params: { fromIDs: string[]; toID: string }): Promise<null>;
}

// ---------------------------------------------------------------------------
// Content baselines (fresh-content precondition)
// ---------------------------------------------------------------------------

/** sha256-16hex of one block's content — the fresh-content baseline key. */
function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Session-scoped served-content baselines (fresh-content precondition,
 * decision record): hash of each block's content as the tool last SERVED it
 * this session — never persisted, never seeded from submitted markdown
 * (the kernel re-parses it, so the stored form is unknowable at submit
 * time). Same lifecycle class as the breaker/confirm state: after
 * resume/fork the map is empty and the no-baseline fallback applies. */
export class ContentBaselines {
	private hashes = new Map<string, string>();

	remember(blockId: string, content: string): void {
		this.hashes.set(blockId, contentHash(content));
	}

	servedHash(blockId: string): string | undefined {
		return this.hashes.get(blockId);
	}

	clear(): void {
		this.hashes.clear();
	}
}

export function createContentBaselines(): ContentBaselines {
	return new ContentBaselines();
}

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

function baselineContentsStmt(ids: string[]): string {
	return (
		`SELECT id, content FROM blocks WHERE id IN ` +
		`(${ids.map(sqlString).join(", ")})`
	);
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
				const fresh = renderOutlineFromWalk(
					context.sessionId,
					"kb_write",
					await walkBlockTree(kernel, context.docId, 1),
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

const REFS_BACKLINK_STMT_HEAD =
	"SELECT DISTINCT root_id FROM refs WHERE def_block_id IN";

function refsBacklinkStmt(ids: string[]): string {
	return `${REFS_BACKLINK_STMT_HEAD} (${ids.map(sqlString).join(", ")})`;
}

/** Referring docs' display paths — the confirmation's "who cites this" list. */
function referringHpathsStmt(rootIds: string[]): string {
	return (
		`SELECT DISTINCT hpath FROM blocks WHERE root_id IN ` +
		`(${rootIds.map(sqlString).join(", ")})`
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
		`SELECT root_id, content, hpath FROM blocks ` +
		`WHERE box = ${sqlString(boxId)} AND id = ${sqlString(docId)} AND type = 'd'`
	);
}

/** The unfiltered post-write walk (stale-target record) — evidence for
 * insert/move/delete verification. */
export async function walkIdSet(
	kernel: WriteKernelClient,
	docId: string,
): Promise<WalkedBlock[]> {
	return walkBlockTree(kernel, docId, 1);
}

export function idSet(walk: WalkedBlock[]): Set<string> {
	return new Set(walk.map((b) => b.id));
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
	walk?: WalkedBlock[];
}): Promise<{
	walk: WalkedBlock[];
	envelope: Record<string, unknown>;
}> {
	const { kernel, sessionId, boxId, docId, baselines } = input;
	const walk = input.walk ?? (await walkBlockTree(kernel, docId, 1));
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
	// Refresh baselines for the target doc's blocks (write results
	// refresh the map for blocks whose content the result carried).
	for (const block of walk) {
		baselines.remember(block.id, block.content);
	}
	return { walk, envelope };
}
