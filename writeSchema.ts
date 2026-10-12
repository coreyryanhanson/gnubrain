// kb_write tool schema + the shared mode shape validation: mode-specific
// target params (schema table) and the TypeBox schema — all zero-kernel-call,
// all checked before the probe gate.

import { Type, type Static } from "typebox";

/** The two body keys, single-sourced for the table and the rejection check. */
const BODY_KEYS: string[] = ["markdown", "markdownFile"];

/** Mode-specific params (schema table): `targets` are the mode's target
 * params, `bodies` its body params (markdown XOR markdownFile; empty = the
 * mode carries no body) — anything else the agent sends is rejected before
 * any kernel call. `confirmNew` is never declared in the tool schema but
 * accepted at runtime on create only — other modes reject it like any
 * invented param. */
const MODE_PARAMS: Record<string, { targets: string[]; bodies: string[] }> = {
	create: {
		targets: ["topic", "parentId"],
		bodies: BODY_KEYS,
	},
	edit: { targets: ["docId", "blockId"], bodies: BODY_KEYS },
	"replace-section": {
		targets: ["docId", "headingId"],
		bodies: BODY_KEYS,
	},
	append: {
		targets: ["docId", "headingId", "placement"],
		bodies: BODY_KEYS,
	},
	delete: { targets: ["docId", "blockId", "doc"], bodies: [] },
	move: {
		targets: ["docId", "blockId", "doc", "toDocId", "toHeadingId"],
		bodies: [],
	},
};

// Derived from the schema table so the list and the validation authority
// cannot drift (key order is the documented mode order).
const WRITE_MODE_LIST = Object.keys(MODE_PARAMS).join(", ");

/** Modes that carry a body — derived from the schema table, so the table
 * stays the single validation authority. */
export const CONTENT_BEARING_MODES = new Set<string>();
for (const [mode, { bodies }] of Object.entries(MODE_PARAMS)) {
	if (bodies.length > 0) CONTENT_BEARING_MODES.add(mode);
}

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
			!allowed.targets.includes(k) &&
			(p as Record<string, unknown>)[k] !== undefined,
	);
	if (unexpected.length > 0) {
		return `mode '${mode}' does not take: ${unexpected.join(", ")}`;
	}
	// schema-table split: body-less modes reject both body keys (a sent
	// body is a mistake, never silently ignored); body-bearing modes leave
	// the markdown XOR markdownFile rule to writeConfirm's wording.
	if (allowed.bodies.length === 0) {
		const sent = BODY_KEYS.filter(
			(k) => (p as Record<string, unknown>)[k] !== undefined,
		);
		if (sent.length > 0) {
			return `mode '${mode}' does not take: ${sent.join(", ")}`;
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
	if (mode === "append" && p.placement !== undefined) {
		if (p.placement !== "section-end" && p.placement !== "section-start") {
			return `placement must be "section-end" or "section-start"`;
		}
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
	placement: Type.Optional(
		Type.String({
			description:
				'mode "append" only: "section-end" (default, end of the target section) or "section-start" (top of the target section, before its subsections)',
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
	confirmNew?: unknown; // accepted but never declared in the tool schema
};
