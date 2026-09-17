// Session-scoped fresh-content baselines:
// a serve-time snapshot of each block's blocks.content — the exact
// representation the precondition re-check hashes. Both sides of the tool
// surface feed it: read tools seed it where content is served to the agent
// (kb_read outline lines, kb_query rows that selected content), write flows
// refresh it from write results. Never persisted, never seeded from
// submitted markdown (the kernel re-parses it, so the stored form is
// unknowable at submit time). Same lifecycle class as the breaker/confirm
// state: after resume/fork the map is empty and the no-baseline fallback
// applies.

import { createHash } from "node:crypto";

export function contentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export class ContentBaselines {
	private hashes = new Map<string, string>();

	private constructor() {}

	remember(blockId: string, content: string): void {
		this.hashes.set(blockId, contentHash(content));
	}

	servedHash(blockId: string): string | undefined {
		return this.hashes.get(blockId);
	}

	clear(): void {
		this.hashes.clear();
	}

	static create(): ContentBaselines {
		return new ContentBaselines();
	}
}

/** Seed from rows the tool actually served. Only rows carrying both an id
 * and content count (blocks-table projections) — refs-table rows and
 * content-less projections are skipped, and the walk's heading rows qualify
 * because getChildBlocks content IS blocks.content (the kernel builds both
 * via nodeStaticContent). */
export function rememberServedRows(
	baselines: ContentBaselines,
	rows: readonly { id?: unknown; content?: unknown }[],
): void {
	for (const row of rows) {
		if (row.id !== undefined && row.content !== undefined) {
			baselines.remember(String(row.id), String(row.content));
		}
	}
}
