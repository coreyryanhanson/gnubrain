// Session-scoped fresh-content baselines:
// a serve-time snapshot of each block's blocks.content — the exact
// representation the precondition re-check hashes. Both sides of the tool
// surface feed it: read tools seed it where content is served to the agent
// (kb_read outline lines, kb_query rows that selected content), write flows
// refresh it from write results. Never persisted, never seeded from
// submitted markdown (the kernel re-parses it, so the stored form is
// unknowable at submit time). Same lifecycle class as the breaker/grant
// state: after resume/fork the map is empty and the no-baseline fallback
// applies.
//
// The anti-laundering invariant — the one rule every seed/refresh site
// obeys: no stored baseline ever moves without its content being visible
// to the agent in the same result. Baselines are seeded from what a tool
// served (a walk's heading rows, kb_query's rows) or from a write verdict's
// own judged evidence, never from a later or broad read: a refresh beyond
// the served snapshot would smuggle a concurrent change or a stale index
// row past the fresh-content precondition, so the next edit would
// hash-match the laundered content and apply unseen.

import { contentHash } from "siyuan-kernel-primitives";
import type { BaselineLookup } from "siyuan-kernel-primitives/write";

export class ContentBaselines {
	private hashes = new Map<string, string>();

	private constructor() {}

	remember(blockId: string, content: string): void {
		this.hashes.set(blockId, contentHash(content));
	}

	/** The session's baseline verdict for the block, in the judgment's own
	 * vocabulary: a served hash rides as the `served` verdict, its absence
	 * as the chosen `never-served` value — the named choice, not a falsy
	 * default (the write primitives' required-input contract). This IS the
	 * `BaselineLookup` the guard contract takes — every write flow passes
	 * it straight through, so the serve that seeds the wording is the same
	 * lookup the guard compares against. */
	servedBaseline: BaselineLookup = (blockId) => {
		const hash = this.hashes.get(blockId);
		return hash === undefined
			? { kind: "never-served" }
			: { kind: "served", hash };
	};

	clear(): void {
		this.hashes.clear();
	}

	static create(): ContentBaselines {
		return new ContentBaselines();
	}
}

/** Seed from rows the tool actually served. Any row carrying both an id
 * and content is seeded; this includes refs-table rows (which use synthetic
 * ids that never match real block lookups) and the walk's heading rows,
 * while content-less projections are skipped. */
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
