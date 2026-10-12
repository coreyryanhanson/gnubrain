// The pi-tool-masking seam for the /kb command: toolset intent resolution,
// the toolset-state display lines, and the toggle actuation path (batch,
// landed detection, no-op wording, the allowlist refusal). Session state
// (breaker bookkeeping, scope persistence) stays in index.ts — this module
// owns only the library-facing half of the command, so a masking-library
// upgrade touches one place.

import type {
	ExtensionAPI,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	effectiveEnabled,
	toggleBatch,
	type BatchOp,
	type BranchReader,
	type ToolsetDefaultsMap,
	type ToolsetSpec,
} from "pi-tool-masking";
import { READ_TOOLSET_SPEC } from "./tools.js";
import { WRITE_TOOLSET_SPEC } from "./write.js";

/** Toolset display reads intent (the masking library's display contract):
 * one settings snapshot + the live branch, resolved per spec. Settings
 * cannot change mid-command, so one snapshot serves the pre-toggle state
 * lines and the post-toggle landed check; the branch is re-read after the
 * batch. */
export type ToolsetIntent = (
	spec: ToolsetSpec,
	branch: readonly SessionEntry[],
) => boolean;

export function toolsetIntent(defaults: ToolsetDefaultsMap): ToolsetIntent {
	return (spec, branch) => effectiveEnabled(spec, branch, defaults).enabled;
}

export interface ToolsetState {
	/** Bare-`/kb` toolset-state lines (tool-masking record): a masked
	 * toolset is printed, never silent. Display reads intent — an inert
	 * toolset's persisted intent is on even though its members cannot
	 * actuate. */
	lines: [string, string];
	readsOn: boolean;
	writesOn: boolean;
}

const TOOLSET_OFF = "off (toggle, settings pin, or allowlist governance)";

export function toolsetState(
	intent: ToolsetIntent,
	branch: readonly SessionEntry[],
): ToolsetState {
	const readsOn = intent(READ_TOOLSET_SPEC, branch);
	const writesOn = intent(WRITE_TOOLSET_SPEC, branch);
	return {
		lines: [
			`read toolset (kb_query, kb_search, kb_read): ${readsOn ? "on" : TOOLSET_OFF}`,
			`write toolset (kb_write): ${writesOn ? "on" : TOOLSET_OFF}`,
		],
		readsOn,
		writesOn,
	};
}

/** The /kb tools verbs are intent setters; when the batch reports nothing
 * landed (a deferring child reports [], so nothing landed) or throws the
 * allowlist refusal, the caller's message/severity are patched. */
export interface ToolsetTogglePatch {
	message?: string;
	severity?: "warning" | "error";
}

/** Apply one command's toggle ops over the library's sole toggle actuation
 * path. The landed wording reads the batch's own change report, not a
 * re-derivation from state: the report is an intent delta (an op absent
 * from it was already in the desired state), and a full silent no-op — a
 * deferring child — reports [], so nothing landed. */
export function applyToolsetToggleBatch(
	pi: ExtensionAPI,
	sessionManager: BranchReader,
	ops: readonly BatchOp[],
	intent: ToolsetIntent,
): ToolsetTogglePatch {
	try {
		const results = toggleBatch(pi, sessionManager, ops);
		const landedById = new Map(results.map((r) => [r.id, r.enabled]));
		const landed =
			results.length > 0 &&
			ops.every(
				(op) => !landedById.has(op.id) || landedById.get(op.id) === op.desired,
			);
		if (landed) return {};
		// The branch is re-read after the batch: the report is empty exactly
		// when every op was already in its desired state (or nothing
		// actuated), so the honest wording is the state as it now stands.
		const now = toolsetState(intent, sessionManager.getBranch());
		return {
			message: `kb tools unchanged — read toolset ${now.readsOn ? "on" : "off"}, write toolset ${now.writesOn ? "on" : "off"}`,
			severity: "warning",
		};
	} catch (err) {
		// By name, never instanceof: the thrown handle may belong to
		// a different physical copy of the library.
		if ((err as { name?: string } | null)?.name !== "AllowlistModeError") {
			throw err;
		}
		return {
			message:
				"kb tools toggle unavailable — this session runs under allowlist governance (toolsets are managed externally)",
			severity: "error",
		};
	}
}
