// Shared kernel-facing primitives — the structural read-client type and the
// SQL-literal/ownership helpers both the read and write modules build on.
// Kept out of the tool modules so low-level consumers (walk, write flows)
// never import from a tool-registration file.

import { inlineOrSpill, jsonl } from "./spill.js";

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
