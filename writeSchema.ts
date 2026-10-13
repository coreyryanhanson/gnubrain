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
const MODE_PARAMS = {
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
} satisfies Record<string, { targets: string[]; bodies: string[] }>;

/** The closed mode union, derived from the schema table: adding a table key
 * without threading it through both dispatch switches is a compile error —
 * an unknown mode can never reach a kernel call before its wording exists. */
type WriteMode = keyof typeof MODE_PARAMS;

/** Type predicate over the mode union — the narrow the write-path switches
 * rely on (the wire schema keeps `mode` a plain string). Own-property check:
 * `in` would let an inherited name like "toString" slip past the narrow and
 * crash the validation that must refuse it. */
export const isWriteMode = (mode: string): mode is WriteMode =>
	Object.hasOwn(MODE_PARAMS, mode);

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
 * calls. The ok arm carries the narrowed mode, so callers dispatch on it
 * directly. */
export type ModeVerdict =
	| { ok: true; mode: WriteMode }
	| { ok: false; message: string };

const modeRefusal = (message: string): ModeVerdict => ({
	ok: false,
	message,
});
const modeAccepted = (mode: WriteMode): ModeVerdict => ({ ok: true, mode });

export function modeVerdict(p: WriteParams): ModeVerdict {
	const mode = p.mode;
	if (!isWriteMode(mode)) {
		return modeRefusal(
			`mode '${mode}' is not supported — supported modes: ${WRITE_MODE_LIST}`,
		);
	}
	const allowed = MODE_PARAMS[mode];
	const base = new Set(["kb", "mode", "markdown", "markdownFile"]);
	const unexpected = Object.keys(p).filter(
		(k) =>
			!base.has(k) &&
			(k !== "confirmNew" || mode !== "create") &&
			!allowed.targets.includes(k) &&
			(p as Record<string, unknown>)[k] !== undefined,
	);
	if (unexpected.length > 0) {
		return modeRefusal(
			`mode '${mode}' does not take: ${unexpected.join(", ")}`,
		);
	}
	// schema-table split: body-less modes reject both body keys (a sent
	// body is a mistake, never silently ignored); body-bearing modes leave
	// the markdown XOR markdownFile rule to writePrepare's wording.
	if (allowed.bodies.length === 0) {
		const sent = BODY_KEYS.filter(
			(k) => (p as Record<string, unknown>)[k] !== undefined,
		);
		if (sent.length > 0) {
			return modeRefusal(`mode '${mode}' does not take: ${sent.join(", ")}`);
		}
	}
	if (mode === "create") {
		return p.topic === undefined
			? modeRefusal('mode "create" requires topic (a title)')
			: modeAccepted(mode);
	}
	if (p.docId === undefined) {
		return modeRefusal(
			`mode '${mode}' requires docId — an echoed root_id target`,
		);
	}
	if (mode === "append" && p.placement !== undefined) {
		if (p.placement !== "section-end" && p.placement !== "section-start") {
			return modeRefusal(`placement must be "section-end" or "section-start"`);
		}
	}
	switch (mode) {
		case "edit":
			return p.blockId === undefined
				? modeRefusal("mode 'edit' requires blockId — an echoed block ID")
				: modeAccepted(mode);
		case "replace-section":
			return p.headingId === undefined
				? modeRefusal(
						"mode 'replace-section' requires headingId — a heading block ID from the outline",
					)
				: modeAccepted(mode);
		case "append":
			return modeAccepted(mode); // headingId optional → doc end
		case "delete":
		case "move":
			if ((p.blockId !== undefined) === (p.doc === true)) {
				return modeRefusal(
					`mode '${mode}' requires exactly one of blockId or doc: true`,
				);
			}
			if (mode === "move" && p.doc === true && p.toHeadingId !== undefined) {
				return modeRefusal(
					"toHeadingId is block-level only — doc-level moves take docId + doc: true + optional toDocId",
				);
			}
			if (mode === "move" && p.doc !== true && p.toDocId === undefined) {
				return modeRefusal(
					"block-level move requires toDocId — the destination doc (same-doc moves name the source docId)",
				);
			}
			return modeAccepted(mode);
	}
	// Exhaustive tail: reached only if a WriteMode member lacks its
	// required-param case above — a new table key fails typecheck here
	// until that wording exists, before it can pass shape validation.
	mode satisfies never;
	return modeRefusal(`internal: unhandled write mode '${mode}'`);
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
