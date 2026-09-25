// The harness router discriminates statements by head prefix; a head
// reworded into a prefix of another would silently re-route a stub with no
// failing assertion. The primitives-side suite pins its own heads pairwise;
// this pins the full routed set — tool-side heads included.

import { describe, expect, it } from "vitest";
import {
	BLOCK_CONTENTS_STMT_HEAD,
	BLOCK_IN_DOC_STMT_HEAD,
	GUARD_STMT_HEAD,
	OWNERSHIP_STMT_HEAD,
	REFERRING_HPATHS_STMT_HEAD,
	REFS_BACKLINK_STMT_HEAD,
	ROOT_ECHO_STMT_HEAD,
} from "siyuan-kb-primitives";
import {
	PARENT_LOOKUP_STMT_HEAD,
	VERIFIED_ROOT_STMT_HEAD,
} from "siyuan-kb-primitives/write";

describe("stub-router head disjointness", () => {
	it("no routed head is a prefix of another", () => {
		const heads = [
			OWNERSHIP_STMT_HEAD,
			BLOCK_CONTENTS_STMT_HEAD,
			BLOCK_IN_DOC_STMT_HEAD,
			ROOT_ECHO_STMT_HEAD,
			GUARD_STMT_HEAD,
			REFS_BACKLINK_STMT_HEAD,
			REFERRING_HPATHS_STMT_HEAD,
			PARENT_LOOKUP_STMT_HEAD,
			VERIFIED_ROOT_STMT_HEAD,
		];
		for (const a of heads) {
			for (const b of heads) {
				if (a === b) continue;
				expect(a.startsWith(b)).toBe(false);
				expect(b.startsWith(a)).toBe(false);
			}
		}
	});
});
