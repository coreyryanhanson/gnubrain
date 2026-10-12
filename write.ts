// kb_write registration: the tool surface (schema + description) and the
// hooks the chassis injects. The ordered kernel-free entry ladder lives in
// writePrepare.ts; create flow in writeCreate.ts; shape/schema in
// writeSchema.ts; the per-KB grant gate in writeConfirm.ts; mint policy in
// writeGuard.ts; the guard SQL and anchors (placement) live in the
// primitives; shared baselines in baselines.ts, echo tails in
// writeEcho.ts.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineToolset, type Toolset, type ToolsetSpec } from "pi-tool-masking";
import { READ_TOOLSET_ID, WRITE_TOOLSET_ID } from "./toolsetIds.js";

import { textResult } from "./envelope.js";
import { runGatedTool } from "./gate.js";
import { prepareWrite, type WriteToolHooks } from "./writePrepare.js";
import { writeSchema, type WriteParams } from "./writeSchema.js";

// ---------------------------------------------------------------------------
// Write toolset (tool-masking record)
// ---------------------------------------------------------------------------

const WRITE_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.write";

/** Display-intent spec, exported for the same reason as READ_TOOLSET_SPEC
 * (tools.ts) — display surfaces resolve `effectiveEnabled` over it. */
export const WRITE_TOOLSET_SPEC: ToolsetSpec = {
	id: WRITE_TOOLSET_ID,
	label: "GNUbrain KB writes",
	names: new Set(["kb_write"]),
	persistKey: WRITE_TOOLSET_PERSIST_KEY,
	defaultEnabled: true,
	requires: [READ_TOOLSET_ID],
};

const WRITE_DESCRIPTION = `Write to a GNUbrain knowledge base. Modes: create — mint a new doc by title (topic), optionally nested under an echoed parentId; edit — updateBlock on a blockId target (the outline carries heading IDs only; non-heading block IDs come from kb_query rows); replace-section — swap a section's body in one call (the heading ID survives); append — insert new content under a heading (omitted headingId → doc end; the anchor is always tool-derived); delete — a block, or a whole doc with doc: true; move — block-level (toDocId + optional toHeadingId) or doc-level (doc: true; omitted toDocId → notebook root).

Doctrine: mint by title (kernel-normalized); discover by query/search; consume by ID. Targets (docId/blockId/headingId) are agent-supplied echoed values from kb_query/kb_search/kb_read/write results — never invented; anchors are always tool-derived — never agent-supplied. Replace-first: prefer edit/replace-section over append — append is for genuinely new facts. The body travels via markdown (inline) XOR markdownFile (path to a prepared markdown file; read once at call start) on create/edit/replace-section/append; delete/move carry neither. The title guard stops exact/near matches on create and returns the existing docs (docId, outline, spilled markdown) — reconcile by docId, or mint a conscious duplicate with confirmNew: true (you learn this exit from the rejection; do not pass it preemptively). Writes are approved once per KB per interaction via a dialog that names the KB only (no op detail): Yes grants for the interaction, 'Always this session' for the session, any other answer denies that KB until the interaction ends — do not retry within the interaction. allowUnattendedWrites: true skips the dialog in any session; headless sessions deny writes unless it is set. The discovery name 'kbs' is read-only; writes always target a real KB by name. Spill keys in echoes: outlines spill to \`fullOutlinePath\` / \`destFullOutlinePath\`, deleted blocks to \`deletedBlocksPreview\` + \`deletedBlocksPath\` (inline form \`deletedBlocks\`), a create rejection's staged body to \`stagedPath\`, and row payloads to \`preview\` + \`fullResultPath\`.`;

/** Register kb_write and declare the write toolset (one tool, all
 * mutation modes; requires the read toolset — enabling writes cascades
 * reads on, disabling reads cascades writes off; live toggles only — the
 * settings tier applies pins per-toolset without the cascade, the
 * documented write-without-read boundary, backstopped by the per-KB write
 * grant + headless default-deny). */
export function registerWriteToolAndToolset(
	pi: ExtensionAPI,
	hooks: WriteToolHooks,
): Toolset {
	pi.registerTool({
		name: "kb_write",
		label: "KB Write",
		description: WRITE_DESCRIPTION,
		parameters: writeSchema,
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
			const envelope = await runGatedTool(
				hooks,
				params.kb,
				"single",
				(kernel, validation, names) =>
					prepareWrite(
						params as WriteParams,
						hooks,
						kernel,
						validation,
						names,
						ctx,
						signal,
					),
			);
			return textResult(envelope);
		},
	});
	return defineToolset(pi, WRITE_TOOLSET_SPEC);
}
