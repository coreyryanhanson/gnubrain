// kb_write tool schema + the shared mode shape validation: mode-specific
// target params (schema table) and the TypeBox schema — all zero-kernel-call,
// all checked before the probe gate.

import { Type, type Static } from "typebox";
import type { AppendPlacement } from "siyuan-kernel-primitives";

/** The two body keys, single-sourced for the table and the rejection check. */
const BODY_KEYS: string[] = ["markdown", "markdownFile"];

/** move's block-level arm — the per-id and section-move wording helpers
 * receive the XOR-narrowed shape their dispatch already proved. The
 * `doc?: false` arm keeps the discriminant optional-present, so the
 * `params.doc === true` check narrows the union for both readers. */
export type BlockLevelMoveParams = {
	docId: string;
	blockId: string;
	doc?: false | undefined;
	toDocId: string;
	toHeadingId?: string | undefined;
};

/** Mode-specific params, the compile-checked authority: the mode union
 * derives from this map, and each mode's row names exactly the params its
 * flows read — `modeVerdict`'s ok arm carries the narrowed shape, so a
 * flow reading an undeclared param is a compile error, never a runtime
 * undefined. Required-ness follows the validation: a param the mode
 * demands (modeVerdict's required-param legs) is non-optional here.
 * delete and move are discriminated on the doc/blockId XOR the runtime
 * check enforces. Body keys (markdown / markdownFile) ride the base
 * params, not these — body resolution happens once in prepareWrite,
 * before any flow. */
export type WriteModeParams = {
	create: {
		topic: string;
		parentId?: string | undefined;
	};
	edit: { docId: string; blockId: string };
	"replace-section": { docId: string; headingId: string };
	"delete-section": { docId: string; headingId: string };
	append: {
		docId: string;
		headingId?: string | undefined;
		placement?: AppendPlacement | undefined;
	};
	delete:
		| { docId: string; doc: true }
		| { docId: string; blockId: string; doc?: false | undefined };
	move:
		| { docId: string; doc: true; toDocId?: string | undefined }
		| BlockLevelMoveParams;
};

/** The closed mode union, derived from the params map: adding a key
 * without threading it through both dispatch switches is a compile error —
 * an unknown mode can never reach a kernel call before its wording
 * exists. */
export type WriteMode = keyof WriteModeParams;

/** The param keys a mode accepts — distributed over the mode's params
 * union (delete/move's two arms name different key sets). */
type ParamKeys<P> = P extends unknown ? keyof P & string : never;

/** Mode-specific runtime validation rows: `targets` lists the mode's
 * accepted param keys (annotated against WriteModeParams, so a target the
 * params map does not declare is a compile error), `bodies` its body
 * params (markdown XOR markdownFile; empty = the mode carries no body) —
 * anything else the agent sends is rejected before any kernel call.
 * `confirmNew` is never declared in the tool schema but accepted at
 * runtime on create only — other modes reject it like any invented
 * param. */
const MODE_PARAMS: {
	[M in WriteMode]: {
		targets: readonly ParamKeys<WriteModeParams[M]>[];
		bodies: string[];
	};
} = {
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
	"delete-section": {
		targets: ["docId", "headingId"],
		bodies: [],
	},
	move: {
		targets: ["docId", "blockId", "doc", "toDocId", "toHeadingId"],
		bodies: [],
	},
};

/** Type predicate over the mode union — the narrow the write-path switches
 * rely on (the wire schema keeps `mode` a plain string). Own-property check:
 * `in` would let an inherited name like "toString" slip past the narrow and
 * crash the validation that must refuse it. */
const isWriteMode = (mode: string): mode is WriteMode =>
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
 * calls. The ok arm carries the narrowed mode AND its validated params
 * (WriteModeParams): the proof the required-param legs just rendered is
 * the flow input's params field, not something each flow re-asserts with
 * a cast. One arm per mode, so narrowing on `verdict.mode` narrows the
 * params with it. */
type ModeOk<M extends WriteMode = WriteMode> = {
	ok: true;
	mode: M;
	params: WriteModeParams[M];
};
type ModeRefusal = { ok: false; message: string };
type ModeVerdict = { [K in WriteMode]: ModeOk<K> }[WriteMode] | ModeRefusal;
const modeRefusal = (message: string): ModeRefusal => ({ ok: false, message });
const modeAccepted = <M extends WriteMode>(
	mode: M,
	params: WriteModeParams[M],
): ModeOk<M> => ({ ok: true, mode, params });

export function modeVerdict(p: WriteParams): ModeVerdict {
	const mode = p.mode;
	if (!isWriteMode(mode)) {
		return modeRefusal(
			`mode '${mode}' is not supported — supported modes: ${WRITE_MODE_LIST}`,
		);
	}
	const allowed = MODE_PARAMS[mode];
	const targets: readonly string[] = allowed.targets;
	const base = new Set(["kb", "mode", "markdown", "markdownFile"]);
	const unexpected = Object.keys(p).filter(
		(k) =>
			!base.has(k) &&
			(k !== "confirmNew" || mode !== "create") &&
			!targets.includes(k) &&
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
			: modeAccepted(mode, { topic: p.topic, parentId: p.parentId });
	}
	if (p.docId === undefined) {
		return modeRefusal(
			`mode '${mode}' requires docId — an echoed docId target`,
		);
	}
	// Both XOR arms' refusal — the message is shared, the trigger legs are
	// not (each arm's own check narrows the params it accepts).
	const xorRefusal = `mode '${mode}' requires exactly one of blockId or doc: true`;
	if (mode === "append" && p.placement !== undefined) {
		if (p.placement !== "section-end" && p.placement !== "section-start") {
			return modeRefusal(`placement must be "section-end" or "section-start"`);
		}
		if (p.headingId === undefined) {
			return modeRefusal(
				"placement requires headingId — without a heading the append lands at doc end",
			);
		}
	}
	switch (mode) {
		case "edit":
			return p.blockId === undefined
				? modeRefusal("mode 'edit' requires blockId — an echoed block ID")
				: modeAccepted(mode, { docId: p.docId, blockId: p.blockId });
		case "append":
			return modeAccepted(mode, {
				docId: p.docId,
				headingId: p.headingId,
				placement: p.placement,
			}); // headingId optional → doc end
		case "replace-section":
		case "delete-section":
			return p.headingId === undefined
				? modeRefusal(
						`mode '${mode}' requires headingId — a heading block ID from the outline`,
					)
				: modeAccepted(mode, { docId: p.docId, headingId: p.headingId });
		case "delete": {
			if (p.doc === true) {
				if (p.blockId !== undefined) return modeRefusal(xorRefusal);
				return modeAccepted(mode, { docId: p.docId, doc: true });
			}
			if (p.blockId === undefined) return modeRefusal(xorRefusal);
			return modeAccepted(mode, { docId: p.docId, blockId: p.blockId });
		}
		case "move": {
			if (p.doc === true) {
				if (p.blockId !== undefined) return modeRefusal(xorRefusal);
				if (p.toHeadingId !== undefined) {
					return modeRefusal(
						"toHeadingId is block-level only — doc-level moves take docId + doc: true + optional toDocId",
					);
				}
				return modeAccepted(mode, {
					docId: p.docId,
					doc: true,
					toDocId: p.toDocId,
				});
			}
			if (p.blockId === undefined) return modeRefusal(xorRefusal);
			if (p.toDocId === undefined) {
				return modeRefusal(
					"block-level move requires toDocId — the destination doc (same-doc moves name the source docId)",
				);
			}
			return modeAccepted(mode, {
				docId: p.docId,
				blockId: p.blockId,
				toDocId: p.toDocId,
				toHeadingId: p.toHeadingId,
			});
		}
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
				'echoed block ID — the target of mode "edit"; on mode "move" a heading ID moves its WHOLE section (deeper subheadings and bodies included), a non-heading block moves alone; XOR doc: true on delete/move',
		}),
	),
	headingId: Type.Optional(
		Type.String({
			description:
				'heading block ID from the outline — mode "replace-section" and mode "delete-section" (required); mode "append" (optional, omitted → doc end)',
		}),
	),
	placement: Type.Optional(
		Type.Union([Type.Literal("section-end"), Type.Literal("section-start")], {
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
				'destination heading for block-level mode "move" — the section\'s end is the landing; omitted → destination doc end; the anchor itself is always tool-derived',
		}),
	),
});
export type WriteParams = Static<typeof writeSchema> & {
	confirmNew?: unknown; // accepted but never declared in the tool schema
};
