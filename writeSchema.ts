// kb_write tool schema + the shared mode shape validation: mode-specific
// target params (schema table), the confirm key/summary inputs, and the
// TypeBox schema — all zero-kernel-call, all checked before the probe gate.

import { Type, type Static } from "typebox";
import { writeConfirmKey } from "./writeConfirm.js";

/** Mode-specific target params (schema table) — anything else the agent
 * sends is rejected before any kernel call. `confirmNew` is never declared
 * in the tool schema but accepted at runtime on create only (decision
 * record) — other modes reject it like any invented param. */
const MODE_PARAMS: Record<string, string[]> = {
	create: ["topic", "parentId"],
	edit: ["docId", "blockId"],
	"replace-section": ["docId", "headingId"],
	append: ["docId", "headingId"],
	delete: ["docId", "blockId", "doc"],
	move: ["docId", "blockId", "doc", "toDocId", "toHeadingId"],
};

const WRITE_MODE_LIST = "create, edit, replace-section, append, delete, move";

/** Modes that carry a body (schema table) — delete/move carry neither
 * markdown nor markdownFile and are valid without them. */
export const CONTENT_BEARING_MODES = new Set([
	"create",
	"edit",
	"replace-section",
	"append",
]);

/** schema-table shape validation — mode-specific targets, zero kernel
 * calls. */
export function modeShapeProblem(p: WriteParams): string | undefined {
	const mode = p.mode;
	const allowed = MODE_PARAMS[mode];
	if (allowed === undefined) {
		return `mode '${String(mode)}' is not supported — supported modes: ${WRITE_MODE_LIST}`;
	}
	const base = new Set(["kb", "mode", "markdown", "markdownFile"]);
	const unexpected = Object.keys(p).filter(
		(k) =>
			!base.has(k) &&
			(k !== "confirmNew" || mode !== "create") &&
			!allowed.includes(k) &&
			(p as Record<string, unknown>)[k] !== undefined,
	);
	if (unexpected.length > 0) {
		return `mode '${mode}' does not take: ${unexpected.join(", ")}`;
	}
	// schema-table split: content-bearing modes take markdown XOR
	// markdownFile; delete/move carry neither (a sent body is a mistake,
	// never silently ignored).
	if (!CONTENT_BEARING_MODES.has(mode)) {
		const bodies = ["markdown", "markdownFile"].filter(
			(k) => (p as Record<string, unknown>)[k] !== undefined,
		);
		if (bodies.length > 0) {
			return `mode '${mode}' does not take: ${bodies.join(", ")}`;
		}
	}
	if (mode === "create") {
		return p.topic === undefined
			? 'mode "create" requires topic (a title)'
			: undefined;
	}
	if (p.docId === undefined) {
		return `mode '${mode}' requires docId — an echoed root_id target`;
	}
	switch (mode) {
		case "edit":
			return p.blockId === undefined
				? "mode 'edit' requires blockId — an echoed block ID"
				: undefined;
		case "replace-section":
			return p.headingId === undefined
				? "mode 'replace-section' requires headingId — a heading block ID from the outline"
				: undefined;
		case "append":
			return undefined; // headingId optional → doc end
		case "delete":
		case "move":
			if ((p.blockId !== undefined) === (p.doc === true)) {
				return `mode '${mode}' requires exactly one of blockId or doc: true`;
			}
			if (mode === "move" && p.doc === true && p.toHeadingId !== undefined) {
				return "toHeadingId is block-level only — doc-level moves take docId + doc: true + optional toDocId";
			}
			if (mode === "move" && p.doc !== true && p.toDocId === undefined) {
				return "block-level move requires toDocId — the destination doc (same-doc moves name the source docId)";
			}
			return undefined;
		default:
			return undefined;
	}
}

/** Preflight summary — params only; the detailed dialog text is built after
 * ownership resolution (preflight must stay zero-kernel-call). */
function writeModeSummary(p: WriteParams): string {
	const doc = p.docId ?? "-";
	switch (p.mode) {
		case "edit":
			return `Edit block ${p.blockId} in doc ${doc}`;
		case "append":
			return `Append to doc ${doc}${p.headingId === undefined ? " at doc end" : ` under heading ${p.headingId}`}`;
		case "replace-section":
			return `Replace the section under heading ${p.headingId} in doc ${doc}`;
		case "delete":
			return p.doc === true
				? `Delete doc ${doc}`
				: `Delete block ${p.blockId} in doc ${doc}`;
		case "move":
			return p.doc === true
				? `Move doc ${doc} to ${p.toDocId ?? "the notebook root"}`
				: `Move block ${p.blockId} to doc ${p.toDocId}`;
		default:
			return `${String(p.mode)} write in doc ${doc}`;
	}
}

/** Confirm key + preflight summary for a non-create mode — params only;
 * shared by the kb_write entry (preflight precedes the probe gate) and
 * runWriteMode's dialog so the terminal confirm_timeout key can't drift. */
export function modeConfirmInputs(
	name: string,
	p: WriteParams,
): { key: string; summary: string } {
	return {
		key: writeConfirmKey([
			name,
			p.mode,
			p.docId,
			p.blockId,
			p.headingId,
			p.doc === true ? "doc" : undefined,
			p.toDocId,
			p.toHeadingId,
		]),
		summary: writeModeSummary(p),
	};
}

// ---------------------------------------------------------------------------
// kb_write tool schema
// ---------------------------------------------------------------------------

export const writeSchema = Type.Object({
	kb: Type.String({
		description: "KB name to write into — must be in the active scope",
	}),
	mode: Type.String({
		description: `write mode — one of ${WRITE_MODE_LIST}`,
	}),
	topic: Type.Optional(
		Type.String({
			description: 'title for mode "create" — minted by title after the guard',
		}),
	),
	parentId: Type.Optional(
		Type.String({
			description: 'echoed docId — nested mint under this doc (mode "create")',
		}),
	),
	markdown: Type.Optional(
		Type.String({
			description:
				"inline markdown body — exactly one of markdown / markdownFile on content-bearing modes",
		}),
	),
	markdownFile: Type.Optional(
		Type.String({
			description:
				"path to a prepared markdown file — read once at call start; exactly one of markdown / markdownFile",
		}),
	),
	docId: Type.Optional(
		Type.String({
			description:
				"echoed docId (root_id) — the doc every non-create mode targets",
		}),
	),
	blockId: Type.Optional(
		Type.String({
			description:
				'echoed block ID — the target of mode "edit"; XOR doc: true on delete/move',
		}),
	),
	headingId: Type.Optional(
		Type.String({
			description:
				'heading block ID from the outline — mode "replace-section" (required); mode "append" (optional, omitted → doc end)',
		}),
	),
	doc: Type.Optional(
		Type.Boolean({
			description:
				'whole-doc targeting — mode "delete" (removeDocByID) or mode "move" (moveDocsByID); XOR blockId',
		}),
	),
	toDocId: Type.Optional(
		Type.String({
			description:
				'destination docId for mode "move" — block-level (required) or doc-level (optional, omitted → notebook root / un-nest)',
		}),
	),
	toHeadingId: Type.Optional(
		Type.String({
			description:
				'destination heading for block-level mode "move" — omitted → destination doc end; the anchor itself is always tool-derived',
		}),
	),
});
export type WriteParams = Static<typeof writeSchema> & {
	confirmNew?: unknown; // never declared in the schema (decision record)
};
