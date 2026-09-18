// Shared kernel-facing primitives — the structural read/write client types
// and the SQL-literal/ownership helpers both tool families build on.
// Kept out of the tool modules so low-level consumers (walk, write flows)
// never import from a tool-registration file.

import type { BlockTransaction } from "siyuan-kernel-api";
import { inlineOrSpill, jsonl } from "./spill.js";
import type { KernelProbeClient } from "./validation.js";

/** Structural client subset the read tools need (tests stub it). */
export interface KernelReadClient {
	readonly baseUrl: string;
	query(stmt: string): Promise<Record<string, unknown>[]>;
	search(params: {
		query: string;
		paths: string[];
		pageSize: number;
	}): Promise<{
		blocks: {
			id: string;
			rootID: string;
			box: string;
			hPath: string;
			updated: string;
		}[];
		matchedBlockCount: number;
	}>;
	exportMarkdown(id: string): Promise<{ hPath: string; content: string }>;
	getChildBlocks(id: string): Promise<Record<string, unknown>[]>;
}

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

/** Post-mutation async-index convergence window: the blocks index (content,
 * hpath, fresh rows) rebuilds asynchronously behind a mutation's HTTP
 * success, so post-write re-reads retry inside this fixed table.
 * Exponential gaps cover the fast-index common case cheaply and tolerate a
 * busy-queue tail (~4s worst case; the happy path pays nothing — only the
 * currently-false-failure case pays the extra tail).
 * ponytail: fixed table, not a backoff policy knob — a live run that
 * still races past 4s is the signal to extend the table (or add a
 * tree-fallback degradation path), not to make it tunable. */
export const VERIFY_RETRY_DELAYS_MS = [150, 300, 600, 1200, 2000];

/** Single-quote SQL string literal — ids ride the ownership query; agent
 * input is escaped, never interpolated raw. */
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** SELECT head the kernel stubs route on — keep builders and heads in
 * sync by construction (the builder concatenates the head constant). */
export const OWNERSHIP_STMT_HEAD = "SELECT root_id FROM blocks WHERE id";

/** Ownership query: resolves the docId's root within the KB — doubles
 * as the scope check (an id from another KB matches no row). */
export function ownershipStmt(boxId: string, docId: string): string {
	return (
		`${OWNERSHIP_STMT_HEAD} = ${sqlString(docId)}` +
		` AND box = ${sqlString(boxId)}`
	);
}

/**
 * Row payload: within the inline budget the rows ride the envelope;
 * overflow spills the full JSONL and the envelope keeps a newline-boundary
 * preview plus the pointer.
 */
export function rowPayload(
	sessionId: string,
	tool: string,
	kept: Record<string, unknown>[],
): {
	rows?: Record<string, unknown>[];
	preview?: string;
	fullResultPath?: string;
} {
	const text = jsonl(kept);
	const { inline, spillPath } = inlineOrSpill(sessionId, tool, text, "jsonl");
	if (spillPath === undefined) return { rows: kept };
	return { preview: inline, fullResultPath: spillPath };
}
