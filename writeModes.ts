// The non-create write modes — edit / append / replace-section / delete /
// move — plus the shared mode shape validation and the kb_write tool schema.
// Shared scaffolding: mode-target shape → preflight (zero kernel calls when
// denied) → doc ownership → dialog (delete-set display where delete-bearing)
// → fresh-content precondition → kernel op → verified (not trusted) →
// write-result echo.

import { SiYuanApiError } from "siyuan-kernel-api";
import { Type, type Static } from "typebox";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import type { ContentBaselines } from "./baselines.js";
import { previewAtNewline, spillFile } from "./spill.js";
import {
	ownershipStmt,
	renderOutlineFromWalk,
	sqlString,
	walkBlockTree,
	type WalkedBlock,
} from "./tools.js";
import type { SessionValidation } from "./validation.js";
import {
	deriveAppendAnchor,
	deriveMoveAnchor,
	sectionDeleteSet,
} from "./writeAnchors.js";
import {
	confirmWrite,
	writeConfirmKey,
	type WriteConfirmFn,
	type WriteConfirmState,
} from "./writeConfirm.js";
import {
	assertFreshContent,
	backlinkCheck,
	establishBaselines,
	finishWrite,
	idSet,
	newBlockIdFrom,
	rootEcho,
	walkDoc,
	writeEchoTail,
	type WriteKernelClient,
} from "./writeResult.js";

export interface WriteFlowInput {
	sessionId: string;
	kernel: WriteKernelClient;
	validation: SessionValidation;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	params: WriteParams;
	/** Captured content body ("" on body-less modes). */
	body: string;
	/** Preflight verdict from the kb_write entry: run the interactive
	 * dialog (true) or skip it for an approved unattended write (false). */
	dialog: boolean;
	/** Confirm key — computed once at the kb_write entry. */
	confirmKey: string;
	confirm: WriteConfirmFn;
	confirmState: WriteConfirmState;
	baselines: ContentBaselines;
	/** Fires at the flow's first kernel call — kernel-free refusals
	 * (preflight) must not reset the breaker's consecutive count. */
	contact: () => void;
}

interface DocTarget {
	rootId: string;
	title: string;
	hpath: string;
}

/** Every non-create mode takes docId — an echoed target, ownership-
 * checked by the same scoping query (an id from another KB reads as
 * nothing). */
async function resolveDocTarget(
	kernel: WriteKernelClient,
	boxId: string,
	name: string,
	docId: string,
): Promise<DocTarget | Envelope> {
	const rows = await kernel.query(ownershipStmt(boxId, docId));
	const rootId = rows[0] === undefined ? undefined : String(rows[0].root_id);
	if (rootId === undefined) {
		return errorEnvelope(
			`no doc '${docId}' in KB '${name}' — docIds are echoed root_id values from kb_query/kb_search/kb_read/write results; an ID from another KB reads as nothing`,
		);
	}
	const root = await rootEcho(kernel, boxId, rootId);
	if (root === undefined) {
		return errorEnvelope(
			`doc '${docId}' has no type='d' root row in KB '${name}'`,
		);
	}
	return { rootId: root.docId, title: root.title, hpath: root.hpath };
}

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

/** Dispatch point for the non-create modes; mode-target shape is checked
 * once at the kb_write entry (write.ts) — create never reaches here. */
export async function runWriteMode(input: WriteFlowInput): Promise<Envelope> {
	const mode = input.params.mode;
	const confirmKey = input.confirmKey;
	// Pre-dialog permission (headless default-deny + terminal
	// confirm_timeout) already ran at the kb_write entry, before the
	// probe gate — a denied write costs zero kernel round-trips.
	input.contact();
	const target = await resolveDocTarget(
		input.kernel,
		input.boxId,
		input.name,
		input.params.docId as string,
	);
	if ("status" in target) return target;
	switch (mode) {
		case "edit":
			return runEditMode(input, target, input.dialog, confirmKey);
		case "append":
			return runAppendMode(input, target, input.dialog, confirmKey);
		case "replace-section":
			return runReplaceSectionMode(input, target, input.dialog, confirmKey);
		case "delete":
			return runDeleteMode(input, target, input.dialog, confirmKey);
		case "move":
			return runMoveMode(input, target, input.dialog, confirmKey);
		default:
			return errorEnvelope(`internal: unhandled write mode '${mode}'`);
	}
}

async function confirmGate(
	input: WriteFlowInput,
	confirmKey: string,
	summary: string,
): Promise<Envelope | null> {
	return confirmWrite({
		confirm: input.confirm,
		writeConfirmTimeout: input.validation.settings?.writeConfirmTimeout,
		state: input.confirmState,
		key: confirmKey,
		summary,
	});
}

/** SELECT heads the kernel stubs route on — keep builders and heads in
 * sync by construction (each builder concatenates its head constant). */
export const BLOCK_IN_DOC_STMT_HEAD = "SELECT id, content FROM blocks WHERE id";
export const PARENT_DOC_STMT_HEAD = "SELECT parent_id FROM blocks";

/** The target read shared by the blockId-targeting modes — the block's
 * current content (confirmation display + fresh-content baseline), or
 * null when the id is absent from the doc. Absence is never refused
 * here: the stale-target record pins each op's own kernel outcome
 * (edit/move surface the synchronous not-found error verbatim; delete
 * is a success no-op) and the live suite watches the kernel, not this
 * pre-read, for contract drift. */
async function blockInDoc(
	kernel: WriteKernelClient,
	doc: DocTarget,
	blockId: string,
): Promise<{ content: string | null }> {
	const rows = await kernel.query(
		`${BLOCK_IN_DOC_STMT_HEAD} = ${sqlString(blockId)}` +
			` AND root_id = ${sqlString(doc.rootId)}`,
	);
	return { content: rows[0] === undefined ? null : String(rows[0].content) };
}

/** The pinned rejection when a heading id is absent from the doc walk. */
function headingInWalk(
	walk: WalkedBlock[],
	doc: DocTarget,
	headingId: string,
): WalkedBlock | Envelope {
	const heading = walk.find((b) => b.id === headingId && b.type === "h");
	return heading === undefined
		? errorEnvelope(
				`headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`,
			)
		: heading;
}

/** writeEchoTail with the flow's fixed identity args bound — call sites
 * pass only an optional pre-fetched verification walk and the write's own
 * block IDs (only on the success paths — a write that did not land
 * refreshes nothing, or it would launder a concurrent change). */
async function echoTail(
	input: WriteFlowInput,
	doc: DocTarget,
	walk?: WalkedBlock[] | undefined,
	refreshBlockIds?: readonly string[],
): Promise<Record<string, unknown>> {
	return (
		await writeEchoTail({
			kernel: input.kernel,
			sessionId: input.sessionId,
			boxId: input.boxId,
			docId: doc.rootId,
			baselines: input.baselines,
			walk,
			refreshBlockIds,
		})
	).envelope;
}

// ---------------------------------------------------------------------------
// Delete-set display — confirmation shows what a delete-bearing write
// orphans: block count, the trailing blocks' current content, inbound refs
// ---------------------------------------------------------------------------

const DELETE_SET_PREVIEW_CHARS = 2000;

async function deleteSetDisplay(
	kernel: WriteKernelClient,
	sessionId: string,
	deleteSet: { id: string; content: string }[],
): Promise<{
	deleteSet: { count: number; contentPreview: string };
	backlinks: { count: number; hpaths: string[] };
}> {
	const content = deleteSet.map((b) => b.content).join("\n---\n");
	let contentPreview = content;
	if (content.length > DELETE_SET_PREVIEW_CHARS) {
		const path = spillFile(sessionId, "kb_write-delete-set", content, "md");
		contentPreview = `${previewAtNewline(content, DELETE_SET_PREVIEW_CHARS)}\n… full delete-set content in ${path}`;
	}
	return {
		deleteSet: { count: deleteSet.length, contentPreview },
		backlinks: await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		),
	};
}

// --- edit (updateBlock on an agent-supplied blockId target) -----------

async function runEditMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if (row.content !== null) {
		// Fresh-content baseline: served content where the session has seen
		// this block, else the block's CURRENT content — displayed in the
		// confirmation; approval establishes it.
		const summary =
			`Edit block ${blockId} in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
			`current content:\n${row.content}`;
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		if (baselines.servedHash(blockId) === undefined) {
			baselines.remember(blockId, row.content);
		}
		// Precondition: re-check after approval, before the kernel call.
		const stale = await assertFreshContent(
			kernel,
			baselines,
			[{ blockId, baseline: baselines.servedHash(blockId) }],
			{ sessionId, docId: doc.rootId },
		);
		if (stale !== null) return stale;
	}
	// An absent target is never refused here — updateBlock's synchronous
	// not-found error surfaces verbatim below (stale-target record).
	try {
		await kernel.updateBlock({ id: blockId, data: input.body });
	} catch (err) {
		// stale-target record: updateBlock errors synchronously — surface
		// verbatim with the fresh outline attached. Network classes rethrow
		// for runKbCall's unreachable classification — correct here, the
		// mutation itself did not land.
		if (!(err instanceof SiYuanApiError)) throw err;
		const tail = await echoTail(input, doc);
		return errorEnvelope(err.message, { kb: name, ...tail });
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the edit is already applied (finishWrite doc).
	return finishWrite(name, {}, async () => {
		const tail = await echoTail(input, doc, undefined, [blockId]);
		return {
			status: "ok",
			message: `edited block ${blockId} in '${doc.title}' (KB ${name})`,
			kb: name,
			...tail,
		};
	});
}

// --- append (tool-derived nextID anchor; doc-end fallback) ------------

async function runAppendMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, name, params } = input;
	// The walk doubles as anchor data AND the pre-write set for verification
	// (stale-target record: the same walk the anchor derivation fetches).
	const walk = await walkBlockTree(kernel, doc.rootId, 1);
	if (params.headingId !== undefined) {
		const heading = headingInWalk(walk, doc, params.headingId);
		if ("status" in heading) return heading;
	}
	const anchor = deriveAppendAnchor(walk, params.headingId);
	const summary = `Append ${input.body.length} chars to '${doc.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the insert may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// verified, not trusted: the returned id must appear among the
		// post-write walk set's newly-present ids — a tree-level miss rolls
		// back silently behind HTTP success. Multi-block: diff-based;
		// single-block: exactly one id (pinned live).
		const newBlockId = newBlockIdFrom(tx);
		const preIds = idSet(walk);
		const postWalk = await walkDoc(kernel, doc.rootId);
		const postIds = idSet(postWalk);
		const landed =
			newBlockId !== undefined &&
			!preIds.has(newBlockId) &&
			postIds.has(newBlockId);
		if (!landed) {
			const tail = await echoTail(input, doc, postWalk);
			return errorEnvelope(
				`verified-append failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; nothing was inserted`,
				{ kb: name, anchor: anchor.anchor, ...tail },
			);
		}
		const tail = await echoTail(input, doc, postWalk, [newBlockId]);
		return {
			status: "ok",
			message: `appended to '${doc.title}' (KB ${name}) — newBlockId ${newBlockId as string}`,
			kb: name,
			anchor: anchor.anchor,
			newBlockId,
			...tail,
		};
	});
}

// --- replace-section (enumerate → insert → delete, one call) ----------

async function runReplaceSectionMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, baselines, params } = input;
	const headingId = params.headingId as string;
	// Delete-set enumeration rides the document-order walk, never SQL.
	const walk = await walkBlockTree(kernel, doc.rootId, 1);
	const heading = headingInWalk(walk, doc, headingId);
	if ("status" in heading) return heading;
	const deleteSet = sectionDeleteSet(walk, headingId);
	// The confirmation displays the enumerated delete set — block count,
	// the trailing blocks' current content (spill budget applies), and the
	// same backlink visibility `delete` carries.
	const display = await deleteSetDisplay(kernel, sessionId, deleteSet);
	const summary =
		`Replace the section under heading '${heading.content}' in '${doc.title}' (KB ${name}, ${input.body.length} chars)\n\n` +
		`delete set: ${display.deleteSet.count} block(s)\n\n` +
		`current content:\n${display.deleteSet.contentPreview}\n\n` +
		`inbound refs: ${display.backlinks.count}` +
		(display.backlinks.count > 0
			? ` from: ${display.backlinks.hpaths.join(", ")} — replacing orphans refs into the section's content blocks (the heading ID survives)`
			: "");
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	// Fresh-content precondition: establish missing baselines from the same
	// blocks.content read the post-approval re-check uses (representation-
	// independent), then re-check before any kernel call.
	await establishBaselines(
		kernel,
		baselines,
		deleteSet.map((b) => b.id),
	);
	const stale = await assertFreshContent(
		kernel,
		baselines,
		deleteSet.map((b) => ({
			blockId: b.id,
			baseline: baselines.servedHash(b.id),
		})),
		{ sessionId, docId: doc.rootId },
	);
	if (stale !== null) return stale;
	// insert-before-delete: a mid-sequence failure must cost visible
	// duplication, never loss. Same anchor rule as `append`.
	const anchor = deriveAppendAnchor(walk, headingId);
	const tx =
		anchor.kind === "appendRoot"
			? await kernel.appendBlock({ data: input.body, parentID: doc.rootId })
			: await kernel.insertBlock({ data: input.body, nextID: anchor.nextID });
	// Everything from here on is post-mutation — a drop anywhere in the
	// insert verification, the delete sweep, or the echo must never read
	// as "unreachable" while the insert has landed and the sweep may be
	// half-applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		const newBlockId = newBlockIdFrom(tx);
		// Verify the insert landed BEFORE any delete — a silent rollback
		// must not sweep the old section away (stale-target record).
		const preIds = idSet(walk);
		const afterInsertWalk = await walkDoc(kernel, doc.rootId);
		const landed =
			newBlockId !== undefined &&
			!preIds.has(newBlockId) &&
			idSet(afterInsertWalk).has(newBlockId);
		if (!landed) {
			return errorEnvelope(
				`verified-insert failed: the kernel returned ${newBlockId === undefined ? "no block id" : `'${newBlockId}'`} but it is absent from the post-write tree — the transaction rolled back silently behind HTTP success; the old section is untouched`,
				{ kb: name, anchor: anchor.anchor },
			);
		}
		// Deletes ride the pre-enumerated set — a post-insert re-enumeration
		// would sweep the replacement into the delete set.
		for (const [i, block] of deleteSet.entries()) {
			try {
				await kernel.deleteBlock(block.id);
			} catch (err) {
				if (!(err instanceof SiYuanApiError)) throw err;
				// The insert has landed and part of the old section may be
				// swept — a bare error here invites a re-run that duplicates
				// the replacement. Surface the partial state instead.
				return errorEnvelope(
					`replace partially applied: the new section is in place (block '${newBlockId}') but the delete of '${block.id}' failed (${err instanceof Error ? err.message : String(err)})` +
						(i > 0 ? `, and ${i} earlier block(s) were deleted` : "") +
						` — do NOT re-run; delete the remaining old-section block(s) to finish: ${deleteSet
							.slice(i)
							.map((b) => b.id)
							.join(", ")}`,
					{
						kb: name,
						anchor: anchor.anchor,
						newBlockId,
						partialReplace: true,
						deletedBlockIds: deleteSet.slice(0, i).map((b) => b.id),
						remainingBlockIds: deleteSet.slice(i).map((b) => b.id),
					},
				);
			}
		}
		// invalidRefs (write-result contract): post-write echo over the
		// enumerated delete set — what actually got orphaned, verified.
		const invalidRefs = await backlinkCheck(
			kernel,
			deleteSet.map((b) => b.id),
		);
		// The echo tail re-walks AFTER the deletes: the post-insert walk still
		// carries the swept blocks, and the outline-freshness contract requires
		// the post-write tree (write-result contract).
		const tail = await echoTail(input, doc, undefined, [newBlockId]);
		return {
			status: "ok",
			message: `replaced the section under heading '${heading.content}' in '${doc.title}' (KB ${name}) — delete set ${deleteSet.length} block(s), ${invalidRefs.count} orphaned ref(s)`,
			kb: name,
			anchor: anchor.anchor,
			newBlockId,
			invalidRefs: { count: invalidRefs.count, hpaths: invalidRefs.hpaths },
			...tail,
		};
	});
}

// --- delete (block-level deleteBlock; doc-level removeDocByID) --------

async function runDeleteMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, params } = input;
	if (params.doc === true) {
		// Whole-doc delete: the delete set is the walk set; backlink
		// visibility rides the confirmation (delete mode).
		const walk = await walkBlockTree(kernel, doc.rootId, 1);
		const display = await deleteSetDisplay(kernel, sessionId, walk);
		const summary =
			`Delete doc '${doc.title}' (${doc.rootId}) in KB ${name}\n\n` +
			`delete set: ${display.deleteSet.count} block(s)\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			`inbound refs: ${display.backlinks.count}` +
			(display.backlinks.count > 0
				? ` from: ${display.backlinks.hpaths.join(", ")}`
				: "");
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		await kernel.removeDocByID(doc.rootId);
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the doc may already be gone (finishWrite doc).
		return finishWrite(name, {}, async () => {
			// invalidRefs rides the pre-delete walk set — the doc is gone.
			const invalidRefs = await backlinkCheck(
				kernel,
				walk.map((b) => b.id),
			);
			// Pinned shape: only invalidRefs — no doc left to outline.
			return {
				status: "ok",
				message: `deleted doc '${doc.title}' (${doc.rootId}) in KB ${name} — ${invalidRefs.count} orphaned ref(s)`,
				kb: name,
				invalidRefs: {
					count: invalidRefs.count,
					hpaths: invalidRefs.hpaths,
				},
			};
		});
	}
	const blockId = params.blockId as string;
	const row = await blockInDoc(kernel, doc, blockId);
	if (row.content !== null) {
		// Confirmation only when there is something to delete — an absent
		// target is the kernel's success no-op (stale-target record): no
		// dialog, the walk-set evidence below reports the end state.
		const display = await deleteSetDisplay(kernel, sessionId, [
			{ id: blockId, content: row.content },
		]);
		const summary =
			`Delete block ${blockId} in '${doc.title}' (KB ${name})\n\n` +
			`current content:\n${display.deleteSet.contentPreview}\n\n` +
			`inbound refs: ${display.backlinks.count}` +
			(display.backlinks.count > 0
				? ` from: ${display.backlinks.hpaths.join(", ")}`
				: "");
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
	}
	await kernel.deleteBlock(blockId);
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the delete may already be applied (finishWrite doc).
	return finishWrite(name, { blockId }, async () => {
		// Verified, not trusted: a missing ID is a kernel success no-op —
		// the walk-set evidence (target gone) is the report, never assumed.
		const postWalk = await walkDoc(kernel, doc.rootId);
		const targetGone = !idSet(postWalk).has(blockId);
		const invalidRefs = await backlinkCheck(kernel, [blockId]);
		const tail = await echoTail(input, doc, postWalk);
		return {
			status: "ok",
			message: `deleted block ${blockId} in '${doc.title}' (KB ${name}) — target ${targetGone ? "absent from" : "STILL PRESENT in"} the post-write tree; ${invalidRefs.count} orphaned ref(s)`,
			kb: name,
			blockId,
			targetGone,
			invalidRefs: {
				count: invalidRefs.count,
				hpaths: invalidRefs.hpaths,
			},
			...tail,
		};
	});
}

// --- move (block-level moveBlock with tool-derived anchors;
//        doc-level moveDocsByID) -------------------------------------------

/** doc-level self-descendant pre-check: walk the destination's ancestor
 * chain over type='d' rows; the source appearing means the destination is
 * the source or one of its nested descendants — the kernel silently filters
 * exactly that move (success, zero moves). Rejected here, never forwarded.
 * ponytail: assumes nested docs chain via parent_id on 'd' rows; if a
 * kernel change breaks the chain only the direct self-move is caught —
 * upgrade if 5b's live pin ever goes red on a nested case. */
/** A nested doc's parent doc id (type='d' rows chain via parent_id) — the
 * doc-level self-descendant pre-check walks this. */
function parentDocStmt(docId: string): string {
	return `${PARENT_DOC_STMT_HEAD} WHERE id = ${sqlString(docId)} AND type = 'd'`;
}

async function isOwnDescendant(
	kernel: WriteKernelClient,
	sourceRootId: string,
	destId: string,
): Promise<boolean> {
	let current: string | undefined = destId;
	for (
		let hops = 0;
		current !== undefined && current !== "" && hops < 16;
		hops++
	) {
		if (current === sourceRootId) return true;
		const rows = await kernel.query(parentDocStmt(current));
		const parent =
			rows[0] === undefined ? undefined : String(rows[0].parent_id ?? "");
		current = parent === "" || parent === current ? undefined : parent;
	}
	return false;
}

/** Cross-doc block move's `destOutline` (write-result contract): fresh
 * destination outline fetched after the move lands. */
async function destOutlinePayload(
	sessionId: string,
	destWalk: WalkedBlock[],
): Promise<Record<string, unknown>> {
	const outline = renderOutlineFromWalk(sessionId, "kb_write-dest", destWalk);
	return outline.fullOutlinePath === undefined
		? { destOutline: outline.outline }
		: {
				destOutline: outline.outline,
				destFullOutlinePath: outline.fullOutlinePath,
			};
}

/** Doc end in flattened document order: a block's children trail it, so the
 * walk's last element is the moved block's deepest descendant — "last
 * top-level block" is the position check that survives trailing children. */
function isDocEnd(walk: WalkedBlock[], blockId: string): boolean {
	return walk.findLast((b) => b.depth === 1)?.id === blockId;
}

async function runMoveMode(
	input: WriteFlowInput,
	doc: DocTarget,
	dialog: boolean,
	confirmKey: string,
): Promise<Envelope> {
	const { kernel, sessionId, name, boxId, params } = input;
	if (params.doc === true) {
		// Doc-level move: moveDocsByID — destination doc or the notebook
		// id (un-nest). Intra-KB by construction (single-kb write contract).
		let destId = boxId;
		let destLabel = "the notebook root";
		if (params.toDocId !== undefined) {
			const dest = await resolveDocTarget(kernel, boxId, name, params.toDocId);
			if ("status" in dest) return dest;
			destId = dest.rootId;
			destLabel = `'${dest.title}' (${dest.rootId})`;
		}
		if (destId === doc.rootId) {
			return refusedEnvelope(
				`cannot move doc '${doc.title}' (${doc.rootId}) into itself — choose a destination outside the doc's own subtree`,
			);
		}
		if (await isOwnDescendant(kernel, doc.rootId, destId)) {
			return refusedEnvelope(
				`destination ${destLabel} is inside doc '${doc.title}''s own subtree — the kernel silently filters such moves; choose a destination outside the subtree`,
			);
		}
		const summary = `Move doc '${doc.title}' (${doc.rootId}) to ${destLabel} (KB ${name})`;
		if (dialog) {
			const gate = await confirmGate(input, confirmKey, summary);
			if (gate !== null) return gate;
		}
		try {
			await kernel.moveDocsByID({ fromIDs: [doc.rootId], toID: destId });
		} catch (err) {
			// The 7-level depth cap and other kernel rejections surface
			// verbatim (doc-level record).
			if (!(err instanceof SiYuanApiError)) throw err;
			return errorEnvelope(err.message, { kb: name, docId: doc.rootId });
		}
		// Post-mutation reads: a network drop here must never read as
		// "unreachable" — the move may already be applied (finishWrite doc).
		return finishWrite(name, {}, async () => {
			const tail = await echoTail(input, doc);
			// Pinned shape: outline + title/hpath echo, no anchor/newBlockId/
			// destOutline (doc-level record).
			return {
				status: "ok",
				message: `moved doc '${doc.title}' to ${destLabel} (KB ${name})`,
				kb: name,
				...tail,
			};
		});
	}
	const blockId = params.blockId as string;
	const dest = await resolveDocTarget(
		kernel,
		boxId,
		name,
		params.toDocId as string,
	);
	if ("status" in dest) return dest;
	const sameDoc = dest.rootId === doc.rootId;
	// Destination outline: cross-doc fetches the destination walk;
	// same-doc derives from the already-in-hand source walk — no extra call.
	const sourceWalk = await walkBlockTree(kernel, doc.rootId, 1);
	const destWalk = sameDoc
		? sourceWalk
		: await walkBlockTree(kernel, dest.rootId, 1);
	if (params.toHeadingId !== undefined) {
		const heading = destWalk.find(
			(b) => b.id === params.toHeadingId && b.type === "h",
		);
		if (heading === undefined) {
			return errorEnvelope(
				`toHeadingId '${params.toHeadingId}' is not a heading of destination doc '${dest.title}' (${dest.rootId}) — stale or foreign target; re-fetch the destination outline (kb_read) and re-target`,
			);
		}
	}
	// Anchor: tool-derived, never agent-supplied.
	const anchor = deriveMoveAnchor(destWalk, params.toHeadingId);
	// Self-anchor no-op (mirrors the doc-level own-parent case): a block
	// that already sits in the destination position refuses — the kernel
	// no-ops (or re-parents nothing) while the walk-set check would
	// misreport a successful move. The walk is flattened document order
	// (a block's children trail it), so "the element right after the
	// anchor" is exactly kernel placement — this generalizes section-end
	// (previousID === blockId) to any no-op target, e.g. a nested block
	// already following the section anchor. The doc-end fallback keeps its
	// own shape: the block is the doc's last top-level block. Refuse instead.
	const alreadyAtDest =
		anchor.kind === "move"
			? anchor.previousID === blockId ||
				destWalk[destWalk.findIndex((b) => b.id === anchor.previousID) + 1]
					?.id === blockId
			: isDocEnd(destWalk, blockId);
	if (sameDoc && alreadyAtDest) {
		return refusedEnvelope(
			`block '${blockId}' already sits at the destination position — nothing to move`,
		);
	}
	const summary = `Move block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})\n\nanchor: ${anchor.anchor}`;
	if (dialog) {
		const gate = await confirmGate(input, confirmKey, summary);
		if (gate !== null) return gate;
	}
	try {
		if (anchor.kind === "appendRoot") {
			await kernel.moveBlock({ id: blockId, parentID: dest.rootId });
		} else {
			await kernel.moveBlock({ id: blockId, previousID: anchor.previousID });
		}
	} catch (err) {
		// stale-target record: moveBlock's blocktree index check rejects a
		// missing source/anchor synchronously — surface verbatim with the
		// fresh outline attached. Network classes rethrow for runKbCall's
		// unreachable classification — correct here, the move did not land.
		if (!(err instanceof SiYuanApiError)) throw err;
		const tail = await echoTail(input, doc);
		return errorEnvelope(err.message, {
			kb: name,
			anchor: anchor.anchor,
			...tail,
		});
	}
	// Post-mutation reads: a network drop here must never read as
	// "unreachable" — the move may already be applied (finishWrite doc).
	return finishWrite(name, { anchor: anchor.anchor }, async () => {
		// Verified, not trusted: a tree-level miss rolls back silently
		// behind HTTP success — movedBlockId must appear in the destination's
		// post-move walk set (and, cross-doc, be gone from the source's).
		const postSourceWalk = await walkDoc(kernel, doc.rootId);
		const postDestWalk = sameDoc
			? postSourceWalk
			: await walkDoc(kernel, dest.rootId);
		// Same-doc `move` verifies POSITION, not presence: the block was
		// already in this walk before the move, so set membership cannot
		// distinguish "landed" from a silent kernel no-op behind HTTP success
		// (e.g. a stale anchor after a concurrent edit). Section anchors
		// require the block immediately after the anchor in the post-move
		// walk; doc-end moves require the block to be the doc's last
		// top-level block (isDocEnd — trailing children make "last walk
		// element" wrong). If the anchor block itself vanished (concurrent
		// delete), the position is unverifiable — fall back to presence
		// rather than false-failing on a check that can no longer run.
		const anchorIdx =
			sameDoc && anchor.kind === "move"
				? postSourceWalk.findIndex((b) => b.id === anchor.previousID)
				: -1;
		let movedInDest: boolean;
		if (anchorIdx >= 0) {
			// Section anchor: the element right after the anchor is the block.
			movedInDest = postSourceWalk[anchorIdx + 1]?.id === blockId;
		} else if (sameDoc && anchor.kind === "appendRoot") {
			// Doc-end anchor: last top-level block (trailing children make
			// "last walk element" wrong).
			movedInDest = isDocEnd(postSourceWalk, blockId);
		} else {
			// Cross-doc (or vanished-anchor fallback): block IDs are globally
			// unique, so membership in the destination doc does discriminate.
			movedInDest = idSet(postDestWalk).has(blockId);
		}
		const movedGoneFromSource = sameDoc || !idSet(postSourceWalk).has(blockId);
		const destPayload = sameDoc
			? {}
			: await destOutlinePayload(sessionId, postDestWalk);
		if (!movedInDest || !movedGoneFromSource) {
			// The move did not land — refresh nothing (the failure tail must
			// not launder a concurrent change past the precondition).
			const srcTail = await echoTail(input, doc, postSourceWalk);
			const postDestIds = idSet(postDestWalk);
			let why = "still present in the source tree";
			if (!postDestIds.has(blockId)) why = "absent from the destination tree";
			else if (sameDoc && !movedInDest)
				why =
					anchor.kind === "appendRoot"
						? "present but not the doc's last top-level block"
						: "present but not immediately after the anchor";
			return errorEnvelope(
				`verified-move failed: block '${blockId}' is ${why} — the transaction rolled back silently behind HTTP success`,
				{
					kb: name,
					anchor: anchor.anchor,
					...srcTail,
					...destPayload,
				},
			);
		}
		// The move landed — movedBlockId is what the result carried, so its
		// baseline refresh rides this path only (the failure path above
		// refreshes nothing).
		const srcTail = await echoTail(input, doc, postSourceWalk, [blockId]);
		return {
			status: "ok",
			message: `moved block ${blockId} ${sameDoc ? "within" : "to"} '${dest.title}' (KB ${name})`,
			kb: name,
			anchor: anchor.anchor,
			movedBlockId: blockId,
			...srcTail,
			...destPayload,
		};
	});
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
