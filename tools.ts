// read tools — kb_query / kb_search / kb_read — and the read toolset.
// Every call routes through the shared gate (shape → breaker → cooldown → kb
// param); kernel errors classify in runKbCall. Scoping is tool-owned: the
// agent never writes box IDs or notebook IDs, and search's aux params are
// rejected at the schema. Kernel primitives live in siyuan-kb-primitives;
// the SQL certification layer in sqlScope.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineToolset, type Toolset, type ToolsetSpec } from "pi-tool-masking";
import { Type } from "typebox";
import { rememberServedRows, type ContentBaselines } from "./baselines.js";
import { READ_TOOLSET_ID } from "./toolsetIds.js";
import { CircuitBreaker } from "./breaker.js";
import {
	configRefusalEnvelope,
	errorEnvelope,
	type Envelope,
	noSuchDocEnvelope,
	refusedEnvelope,
	textResult,
} from "./envelope.js";
import { runGatedTool } from "./gate.js";
import {
	EMPTY_SCOPE_MESSAGE,
	NOT_READY_VALIDATION,
	RATE_LIMIT_SKIP_MESSAGE,
	resolveBox,
} from "./kbScope.js";
import {
	docMarkdown,
	ownership,
	searchBoxes,
	type KernelReadClient,
} from "siyuan-kb-primitives";
import {
	inlineOrSpill,
	jsonl,
	RESULT_LIMIT,
	spillFile,
	spillPointer,
	withRowPayload,
} from "./spill.js";
import {
	certifySelect,
	postFilterRows,
	rebuildWithScope,
	reparse,
	verifyRebuilt,
} from "./sqlScope.js";
import { serveOutline } from "./outline.js";
import type { SessionValidation } from "./validation.js";

interface ReadToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): KernelReadClient | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped fresh-content baselines — read tools seed it where
	 * content is served to the agent, so the map holds exactly what the
	 * tool last served; the write precondition re-checks against it. */
	baselines: ContentBaselines;
}

// ---------------------------------------------------------------------------
// kb_query
// ---------------------------------------------------------------------------

const QUERY_DESCRIPTION = `SQL over the GNUbrain knowledge base (SQLite, executed readonly). Pass kb as an array of KB names; the tool scopes every statement with box IN (...) itself — never write box.

Tables:
- blocks: id, parent_id, root_id, hpath, box, type, content, updated, sort, ...
  - \`sort\` is a block-type weight, NOT display order — ORDER BY sort does not yield document order; heading order comes from kb_read's outline or the parentID/previousID anchors.
  - \`hpath\` is a derived display label stamped on every row — never an address. Address documents by root_id (the docId kb_read consumes).
  - \`updated\` is the kernel's yyyymmddhhmmss per-block timestamp — sorts lexically, no parsing needed.
- refs: id, def_block_id, def_block_root_id, block_id, root_id, box, ... (block-reference/backlink queries)

Discovery pattern: include hpath in discovery SELECTs — SELECT id, root_id, box, hpath, updated FROM blocks WHERE ... — every row then carries the docId (root_id) that kb_read and the write tools consume, its per-row KB attribution (box), and its recency (updated).

Spill keys: under the inline budget the result rows ride the envelope as \`rows\`; above it the envelope carries \`preview\` (newline-boundary cut) plus \`fullResultPath\` (the full JSONL).

Rules: exactly one top-level SELECT; FROM blocks or refs only; single-table FROM (no JOINs, subqueries, CTEs, UNION, or HAVING). LIMIT is injected as 64 when absent; an agent-supplied LIMIT passes through uncapped. Aggregate queries (COUNT/GROUP BY) are allowed — their rows carry no box and are exempt from re-scoping.`;

function registerQueryTool(pi: ExtensionAPI, hooks: ReadToolHooks) {
	pi.registerTool({
		name: "kb_query",
		label: "KB Query",
		description: QUERY_DESCRIPTION,
		parameters: Type.Object(
			{
				kb: Type.Array(Type.String(), {
					description: "KB name(s) to query — must be in the active scope",
				}),
				sql: Type.String({
					description: "One SELECT statement over the blocks or refs table",
				}),
			},
			// Reject invented params at schema level so the calling model learns
			// immediately. kb_write deliberately omits this flag — its runtime
			// check (modeShapeProblem) enforces the same strictness while
			// exempting confirmNew on create only.
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const envelope = await runGatedTool(
				hooks,
				params.kb,
				"array",
				async (kernel, validation, names) => {
					const boxes = names.map((n) => resolveBox(n, validation));
					const certified = certifySelect(params.sql);
					if (!certified.ok) {
						return refusedEnvelope(certified.reason);
					}
					const rebuilt = rebuildWithScope(certified.ast, boxes);
					const reparsed = reparse(rebuilt.stmt);
					const problem = verifyRebuilt(
						reparsed,
						boxes,
						rebuilt.originalWhere,
						rebuilt.limit,
					);
					if (problem !== undefined) {
						return errorEnvelope(`internal: ${problem}`);
					}
					const rows = await kernel.query(rebuilt.stmt);
					return buildQueryEnvelope(
						ctx.sessionManager.getSessionId(),
						names,
						boxes,
						rows,
						rebuilt.limit,
						hooks.baselines,
					);
				},
			);
			return textResult(envelope);
		},
	});
}

function buildQueryEnvelope(
	sessionId: string,
	names: string[],
	boxes: string[],
	rows: Record<string, unknown>[],
	limit: number,
	baselines: ContentBaselines,
): Envelope {
	const { kept, dropped } = postFilterRows(rows, boxes);
	// Served-content baselines: any kept row that selected id + content
	// becomes a precondition baseline (refs-table rows and content-less
	// projections are skipped by rememberServedRows).
	rememberServedRows(baselines, kept);
	const envelope: Envelope = {
		status: "ok",
		message: `${kept.length} rows`,
		kb: names,
		boxes,
		count: kept.length,
	};
	if (dropped > 0) envelope.post_filtered = true;
	// Truncation fires when kept + dropped reaches the limit — a window
	// filled with out-of-scope rows must still signal in-scope rows beyond it.
	// The marker counts post-filter rows, never pre-filter ones.
	// A negative LIMIT is sqlite's "no limit" — never truncate-flagged.
	if (limit > 0 && kept.length + dropped >= limit) {
		const path = spillFile(sessionId, "kb_query", jsonl(kept), "jsonl");
		envelope.truncated = `${limit} rows — refine the query; full result in ${path}`;
	}
	return withRowPayload(envelope, sessionId, "kb_query", "rows", kept);
}

// ---------------------------------------------------------------------------
// kb_search — per-KB fan-out
// ---------------------------------------------------------------------------

const SEARCH_DESCRIPTION = `Full-text search across GNUbrain knowledge bases. Pass kb as an array of KB names; the tool fans out one scoped kernel call per KB and merges results. Every row echoes id, root_id (the docId kb_read consumes), hpath, box (the resolved KB name), and updated. Search is the discovery step: a hit is directly consumable as kb_read { kb, docId: root_id }.`;

export function registerSearchTool(pi: ExtensionAPI, hooks: ReadToolHooks) {
	pi.registerTool({
		name: "kb_search",
		label: "KB Search",
		description: SEARCH_DESCRIPTION,
		parameters: Type.Object(
			{
				kb: Type.Array(Type.String(), {
					description: "KB name(s) to search — must be in the active scope",
				}),
				query: Type.String({ description: "Full-text search query" }),
			},
			// The route's method/types/orderBy/groupBy are tool-owned — one
			// schema constraint closes the SQL-smuggling bypass.
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const envelope = await runGatedTool(
				hooks,
				params.kb,
				"array",
				(kernel, validation, names) =>
					runSearchFanOut(
						ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						names,
						params.query,
					),
			);
			return textResult(envelope);
		},
	});
}

export async function runSearchFanOut(
	sessionId: string,
	kernel: KernelReadClient,
	validation: SessionValidation,
	names: string[],
	query: string,
): Promise<Envelope> {
	// One kernel call per resolved KB rides the barrel's searchBoxes — the
	// shared pre-filter window (a hit-rich KB silently dropping the other
	// KBs' matches) is kernel behavior the primitives own; this side owns
	// resolve, echo, and spill.
	const results = await searchBoxes(kernel, {
		query,
		boxIds: names.map((name) => resolveBox(name, validation)),
		pageSize: RESULT_LIMIT,
	});
	const merged: Record<string, unknown>[] = [];
	let dropped = 0;
	let truncatedKBs = 0;
	let truncatedRows = 0;
	for (const [i, name] of names.entries()) {
		const box = results[i];
		if (box === undefined) {
			throw new Error("internal: search fan-out lost a box result");
		}
		dropped += box.dropped;
		if (box.hidden > 0) truncatedKBs++;
		truncatedRows += box.hidden;
		// Echo contract: id, root_id, hpath, box → resolved KB name,
		// updated — never raw.
		for (const block of box.rows) {
			merged.push({
				id: block.id,
				root_id: block.rootID,
				hpath: block.hPath,
				box: name,
				updated: block.updated,
			});
		}
	}
	const envelope: Envelope = {
		status: "ok",
		message: `${merged.length} rows across ${names.length} KB${names.length === 1 ? "" : "s"}`,
		kb: names,
		count: merged.length,
	};
	if (dropped > 0) envelope.post_filtered = true;
	if (truncatedKBs > 0) {
		const path = spillFile(sessionId, "kb_search", jsonl(merged), "jsonl");
		envelope.truncated = `${truncatedRows} rows — truncated in ${truncatedKBs} of ${names.length} KBs; full result in ${path}`;
	}
	return withRowPayload(envelope, sessionId, "kb_search", "rows", merged);
}

// ---------------------------------------------------------------------------
// kb_read — the barrel's docMarkdown export read (+ the outline ride-along)
// ---------------------------------------------------------------------------

const READ_DESCRIPTION = `Fetch a GNUbrain doc as GFM markdown plus a heading→block-ID outline. Pass kb (one KB name) and docId — a root_id echoed by kb_query/kb_search, never an invented ID. The ownership check doubles as the scope check: a docId from another KB returns no rows. Call with kb: "kbs" to list active KBs (no docId, no kernel call). Use the outline's block IDs to target kb_write edits; grep the spilled full result for content when the body is large. Spill keys: the inline \`outline\` gains \`fullOutlinePath\` (full heading rows, JSONL) and the inline \`content\` gains \`fullResultPath\` (the full markdown) whenever the payload exceeds the inline budget. Outline notation: heading level as \`#\`…\`######\`, prefixed by the enclosing container outermost-first (\`>\` quote, \`-\` list item, \`c\` callout, \`s\` superblock, \`t\` tab), glued to the level marks and ending in \`→ <blockID>\`; the first space divides placement notation from the title; a bracketed token (\`[tabs]\`, \`[unnamed]\`, or the wire type itself) is the notation for a container with no defined glyph, and containers the kernel refuses as a write target are additionally marked \`(not targetable)\`.`;

/**
 * The `kbs` discovery form: `kb_read` with `kb: "kbs"` returns
 * the active KB set without touching the kernel. The echoed `kb: "kbs"` is a
 * reserved marker, not a real KB — a deliberate exception to the
 * success-echo contract; the payload rides in `names`. The marker is
 * identical in every form (populated, empty, or rate-limit-skipped scope) so
 * a consumer branching on it never sees a shape it didn't expect.
 */
function kbsDiscoveryEnvelope(validation: SessionValidation): Envelope {
	// A validation skipped under an armed 429 cooldown also has an empty
	// scope, but "no KBs in scope" would misstate it — the set is unknown,
	// not empty — so the skip names itself (the gate's sentence, nameless).
	if (validation.skippedDueToRateLimit === true) {
		return {
			status: "ok",
			kb: "kbs",
			message: RATE_LIMIT_SKIP_MESSAGE,
			names: [],
		};
	}
	return {
		status: "ok",
		kb: "kbs",
		message:
			validation.scope.length > 0
				? validation.scope.join(", ")
				: EMPTY_SCOPE_MESSAGE,
		names: [...validation.scope],
	};
}

function registerReadTool(pi: ExtensionAPI, hooks: ReadToolHooks) {
	pi.registerTool({
		name: "kb_read",
		label: "KB Read",
		description: READ_DESCRIPTION,
		parameters: Type.Object(
			{
				kb: Type.String({
					description:
						"KB name the doc belongs to — must be in the active scope, or the reserved discovery name 'kbs' to list active KBs",
				}),
				// Optional so the kb: "kbs" discovery form passes schema validation;
				// a real read with no docId is refused inside the gated op.
				docId: Type.Optional(
					Type.String({
						description:
							"Document root block ID (root_id from kb_query/kb_search rows)",
					}),
				),
			},
			// kb_read has no runtime shape check, so the schema is the only
			// defense against invented params. kb_write deliberately omits this
			// flag — modeShapeProblem enforces the same strictness at runtime
			// while exempting confirmNew on create only.
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(errorEnvelope(NOT_READY_VALIDATION));
			}
			// Discovery short-circuit (kb: "kbs"): ahead of breaker/cooldown —
			// discovery succeeds while the breaker is tripped or a lockout is
			// armed and leaves the breaker state untouched. It cannot route
			// through guardCall/runKbCall/runGatedTool: guardCall's pinned order
			// fuses shape → breaker → cooldown and cannot stop between them, and
			// runKbCall's success path would reset the breaker counter. The
			// shape check is a deliberate duplicate of guardCall's first check —
			// kept a one-liner so the two cannot drift.
			if (params.kb === "kbs") {
				if (validation.shapeErrors.length > 0) {
					return textResult(configRefusalEnvelope(validation.shapeErrors));
				}
				return textResult(kbsDiscoveryEnvelope(validation));
			}
			const envelope = await runGatedTool(
				hooks,
				params.kb,
				"single",
				(kernel, validation, names) => {
					// The missing-docId refusal lives inside the gated op, after
					// the gate resolved a valid kb: a typo'd kb with no docId must
					// get the unknown-KB rejection, not the guidance. Returned as
					// refused (never thrown) — an op-internal refusal that never
					// touched the kernel, so runKbCall skips recordSuccess and the
					// consecutive-auth-failure count survives. Never answered with
					// a doc listing or metrics: a success-shaped payload would mask
					// the lost-docId mistake the call almost always is.
					const docId = params.docId;
					if (docId === undefined || docId === "") {
						return refusedEnvelope(
							`docId is required to read a doc. List docs via kb_query ` +
								`(SELECT id, root_id, hpath FROM blocks WHERE type = 'd'), ` +
								`KB stats via a kb_query aggregate, or list active KBs ` +
								`with kb: "kbs".`,
						);
					}
					return runRead(
						ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						names[0] as string,
						docId,
						hooks.baselines,
					);
				},
			);
			return textResult(envelope);
		},
	});
}

export async function runRead(
	sessionId: string,
	kernel: KernelReadClient,
	validation: SessionValidation,
	name: string,
	docId: string,
	baselines: ContentBaselines,
): Promise<Envelope> {
	const boxId = resolveBox(name, validation);
	// GFM only, never getDoc — the id-free export shape is the primitives'
	// docMarkdown pin. The kernel route takes a bare stmt (no bind
	// params), so trusted ids ride escaped literals (the primitives'
	// ownership read).
	const rootId = await ownership(kernel, boxId, docId);
	if (rootId === undefined) {
		return noSuchDocEnvelope(name, docId);
	}
	const doc = await docMarkdown(kernel, rootId);
	const envelope: Envelope = {
		status: "ok",
		message: `${doc.content.length} chars from ${doc.hPath}`,
		kb: name,
		docId: rootId,
		hpath: doc.hPath,
	};

	const outline = await serveOutline(
		kernel,
		sessionId,
		"kb_read",
		rootId,
		baselines,
	);
	Object.assign(envelope, outline);

	// read budget: the spill mechanism is the only limit — large docs spill
	// in full while the inline result keeps the newline-boundary preview.
	const { inline, spillPath } = inlineOrSpill(
		sessionId,
		"kb_read",
		doc.content,
		"md",
	);
	envelope.content =
		spillPath === undefined
			? inline
			: `${inline}\n${spillPointer(doc.content.length - inline.length, spillPath)}`;
	if (spillPath !== undefined) {
		envelope.fullResultPath = spillPath;
	}
	return envelope;
}

// ---------------------------------------------------------------------------
// Toolset (tool-masking record)
// ---------------------------------------------------------------------------

const READ_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.read";

/** Exported for display surfaces: per the masking library's contract,
 * display reads intent (`effectiveEnabled` over this spec), observation
 * (`isEnabled`) stays for declaration-sensitive sites only. */
export const READ_TOOLSET_SPEC: ToolsetSpec = {
	id: READ_TOOLSET_ID,
	label: "GNUbrain KB reads",
	names: new Set(["kb_query", "kb_search", "kb_read"]),
	persistKey: READ_TOOLSET_PERSIST_KEY,
	defaultEnabled: true,
};

/** Register the three read tools and declare the read toolset: the
 * toolset exists so the surface is maskable from day one — default behavior
 * unchanged; /kb tools read|write|off sets the toolsets at runtime. */
export function registerReadToolsAndToolset(
	pi: ExtensionAPI,
	hooks: ReadToolHooks,
): Toolset {
	registerQueryTool(pi, hooks);
	registerSearchTool(pi, hooks);
	registerReadTool(pi, hooks);
	return defineToolset(pi, READ_TOOLSET_SPEC);
}
