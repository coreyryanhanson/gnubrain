// §3 read tools — kb_query / kb_search / kb_read — and the read toolset.
// Every call routes through the S1 gate (shape → breaker → cooldown → kb
// param); kernel errors classify in runKbCall. Scoping is tool-owned: the
// agent never writes box IDs or notebook IDs, and search's aux params are
// rejected at the schema.

import type { AST, BaseFrom, Binary, Select } from "node-sql-parser";
import { Parser } from "node-sql-parser";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineToolset, type Toolset } from "pi-tool-masking";
import { Type } from "typebox";
import { CircuitBreaker } from "./breaker.js";
import {
	configRefusalEnvelope,
	errorEnvelope,
	type Envelope,
	refusedEnvelope,
} from "./envelope.js";
import { EMPTY_SCOPE_MESSAGE, runKbCall } from "./gate.js";
import {
	inlineOrSpill,
	OUTLINE_HEADINGS,
	RESULT_LIMIT,
	spillFile,
	spillPointer,
} from "./spill.js";
import type { SessionValidation } from "./validation.js";

/** Structural client subset the read tools need (tests stub it). */
export interface KernelReadClient {
	readonly baseUrl: string;
	query(stmt: string): Promise<Record<string, unknown>[]>;
	search(params: {
		query: string;
		paths: string[];
		pageSize: number;
	}): Promise<{
		blocks: {
			id: string;
			rootID: string;
			box: string;
			hPath: string;
			updated: string;
		}[];
		matchedBlockCount: number;
	}>;
	exportMarkdown(id: string): Promise<{ hPath: string; content: string }>;
	getChildBlocks(id: string): Promise<Record<string, unknown>[]>;
}

export interface ReadToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): KernelReadClient | undefined;
	breaker: CircuitBreaker;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Single-quote SQL string literal — ids ride the ownership query; agent
 * input is escaped, never interpolated raw. */
export function sqlString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** Serialize kept rows as JSONL (§3 spill format for query/search rows). */
function jsonl(rows: unknown[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

/**
 * Row payload (§3): within the inline budget the rows ride the envelope;
 * overflow spills the full JSONL and the envelope keeps a newline-boundary
 * preview plus the pointer.
 */
export function rowPayload(
	sessionId: string,
	tool: string,
	kept: Record<string, unknown>[],
): {
	rows?: Record<string, unknown>[];
	preview?: string;
	fullResultPath?: string;
} {
	const text = jsonl(kept);
	const { inline, spillPath } = inlineOrSpill(sessionId, tool, text, "jsonl");
	if (spillPath === undefined) return { rows: kept };
	return { preview: inline, fullResultPath: spillPath };
}

// ---------------------------------------------------------------------------
// kb_query — parser certification + AST rebuild (§3)
// ---------------------------------------------------------------------------

const CERT_TABLES = new Set(["blocks", "refs"]);
const parser = new Parser();
const SQL_DIALECT = { type: "sqlite" } as const;

/** The gate guarantees every resolved name sits in the valid set; this keeps
 * that invariant explicit rather than a non-null assertion. */
function resolveBox(name: string, validation: SessionValidation): string {
	const box = validation.validKBs.get(name);
	if (box === undefined) {
		throw new Error(
			`internal: '${name}' passed the gate but left the valid set`,
		);
	}
	return box;
}

export type CertResult =
	| { ok: true; ast: Select }
	| { ok: false; reason: string };

/** §3 layer 1 — parser-based certification, never a token scan. Worst case
 * at every rung is a rejection with the reason named, never a guess. */
export function certifySelect(stmt: string): CertResult {
	let ast: unknown;
	try {
		ast = parser.astify(stmt, SQL_DIALECT);
	} catch (err) {
		return {
			ok: false,
			reason: `statement does not parse: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	// Spike finding: multi-statement input does not throw — astify returns an
	// array, so the cert rejects on Array.isArray (§10).
	if (Array.isArray(ast)) {
		return {
			ok: false,
			reason:
				"multiple statements are not allowed — exactly one top-level SELECT",
		};
	}
	const node = ast as Select;
	if (node.type !== "select") {
		return { ok: false, reason: `only SELECT is allowed (got ${node.type})` };
	}
	// The kernel's readonly layer permits WITH — layer 1 is the only line of
	// defense against a CTE shadowing an allowlisted table (§3).
	if (node.with !== undefined && node.with !== null) {
		return { ok: false, reason: "CTEs (WITH) are not allowed" };
	}
	// UNION parses as type 'select' with the second arm in _next/set_op (§10),
	// so rejection keys on those fields, not the type string.
	if (node._next !== undefined || node.set_op !== undefined) {
		return { ok: false, reason: "UNION / compound queries are not allowed" };
	}
	if (node.having !== undefined && node.having !== null) {
		return { ok: false, reason: "bare HAVING is not allowed (v1 policy)" };
	}
	const from = node.from;
	if (!Array.isArray(from) || from.length === 0) {
		return {
			ok: false,
			reason: "query must read FROM blocks or refs",
		};
	}
	for (const entry of from) {
		if ("expr" in entry) {
			return { ok: false, reason: "subqueries are not allowed" };
		}
		if ("join" in entry) {
			return {
				ok: false,
				reason: "JOINs are not allowed — single-table FROM only",
			};
		}
		if ("type" in entry && entry.type === "dual") {
			return {
				ok: false,
				reason: "FROM dual is not allowed — only blocks and refs",
			};
		}
	}
	if (from.length > 1) {
		return {
			ok: false,
			reason: "single-table FROM only — comma cross-joins are rejected",
		};
	}
	const table = (from[0] as BaseFrom).table;
	if (!CERT_TABLES.has(table)) {
		return {
			ok: false,
			reason: `FROM '${table}' is not allowed — only blocks and refs`,
		};
	}
	return { ok: true, ast: node };
}

/** Hand-built `box IN ('a','b')` AST node (sqlite dialect shape). */
function boxInAst(boxes: string[]): Binary {
	return {
		type: "binary_expr",
		operator: "IN",
		left: { type: "column_ref", table: null, column: "box" },
		right: {
			type: "expr_list",
			value: boxes.map((b) => ({ type: "single_quote_string", value: b })),
		},
	};
}

export interface RebuiltStatement {
	stmt: string;
	limitInjected: boolean;
	limit: number;
}

/**
 * §3 layer 1 rebuild: splice `(existing) AND box IN (...)` into the top-level
 * WHERE (fresh WHERE when none — never a bare concatenation, which would turn
 * `a OR b` into `a OR (b AND box IN ...)`), inject LIMIT iff the AST shows
 * none, serialize, and re-parse for verification.
 */
export function rebuildWithScope(
	ast: Select,
	boxes: string[],
): RebuiltStatement {
	const boxIn = boxInAst(boxes);
	let limitInjected = false;
	if (ast.limit === undefined || ast.limit === null) {
		ast.limit = {
			seperator: "",
			value: [{ type: "number", value: RESULT_LIMIT }],
		};
		limitInjected = true;
	}
	if (ast.where === undefined || ast.where === null) {
		ast.where = boxIn;
	} else {
		// The parens flag survives serialization — without it the serializer
		// renders `a OR b AND box IN (...)`, and AND binds tighter than OR.
		ast.where = {
			type: "binary_expr",
			operator: "AND",
			left: { ...ast.where, parentheses: true },
			right: boxIn,
		} as Binary;
	}
	const stmt = parser.sqlify(ast, SQL_DIALECT);
	const limitValue = Array.isArray(ast.limit?.value)
		? Number(ast.limit.value[0]?.value)
		: RESULT_LIMIT;
	return { stmt, limitInjected, limit: limitValue };
}

const norm = (x: unknown): string => JSON.stringify(x);

/**
 * §3 layer 1 verification: the executed statement is the re-parsed one, and
 * the re-parse must still be a single certified SELECT whose WHERE is the
 * original expression ANDed with the injected predicate.
 */
export function verifyRebuilt(
	re: AST,
	boxes: string[],
	originalWhere: Binary | null,
	limit: number,
): string | undefined {
	if (Array.isArray(re) || re.type !== "select") {
		return "re-parsed statement is not a single SELECT";
	}
	if (re._next !== undefined || re.set_op !== undefined) {
		return "re-parsed statement is a compound query";
	}
	const where = re.where;
	// Fresh WHERE (the original had none): the re-parsed WHERE IS the injected
	// predicate, not an AND of one.
	if (originalWhere === null) {
		if (where === undefined || where === null) {
			return "re-parsed statement lost the injected box predicate";
		}
		const problem = checkBoxIn(where as Binary, boxes);
		if (problem !== undefined) return problem;
	} else {
		if (
			where === undefined ||
			where === null ||
			where.type !== "binary_expr" ||
			where.operator !== "AND"
		) {
			return "re-parsed WHERE is not the original expression ANDed with the injected predicate";
		}
		if (norm(where.left) !== norm({ ...originalWhere, parentheses: true })) {
			return "re-parsed WHERE altered the original expression";
		}
		const problem = checkBoxIn(where.right as Binary | undefined, boxes);
		if (problem !== undefined) return problem;
	}
	const reLimit = Array.isArray(re.limit?.value)
		? Number(re.limit.value[0]?.value)
		: undefined;
	if (reLimit !== limit) {
		return "re-parsed statement lost the LIMIT clause";
	}
	return undefined;
}

/** The injected predicate survived the serialize → re-parse round trip. */
function checkBoxIn(
	boxIn: Binary | undefined,
	boxes: string[],
): string | undefined {
	if (
		boxIn === undefined ||
		boxIn.type !== "binary_expr" ||
		boxIn.operator !== "IN" ||
		(boxIn.left as { column?: unknown } | undefined)?.column !== "box" ||
		!Array.isArray((boxIn.right as { value?: unknown[] } | undefined)?.value) ||
		norm(
			(boxIn.right as { value: { value: unknown }[] }).value.map(
				(v) => v.value,
			),
		) !== norm(boxes)
	) {
		return "re-parsed statement lost the injected box predicate";
	}
	return undefined;
}

/** §3 layer 3 — post-filter backstop. Rows that carry a `box` field are
 * dropped unless `box` is in the resolved set; aggregate rows (no `box`)
 * are exempt — layer 1 guarantees the injected predicate on the executed
 * statement. */
export function postFilterRows(
	rows: Record<string, unknown>[],
	boxIds: string[],
): { kept: Record<string, unknown>[]; dropped: number } {
	const boxSet = new Set(boxIds);
	const kept: Record<string, unknown>[] = [];
	let dropped = 0;
	for (const row of rows) {
		if ("box" in row && !boxSet.has(String(row.box))) {
			dropped++;
		} else {
			kept.push(row);
		}
	}
	return { kept, dropped };
}

const QUERY_DESCRIPTION = `SQL over the GNUbrain knowledge base (SQLite, executed readonly). Pass kb as an array of KB names; the tool scopes every statement with box IN (...) itself — never write box.

Tables:
- blocks: id, parent_id, root_id, hpath, box, type, content, updated, sort, ...
  - \`sort\` is a block-type weight, NOT display order — ORDER BY sort does not yield document order; heading order comes from kb_read's outline or the parentID/previousID anchors.
  - \`hpath\` is a derived display label stamped on every row — never an address. Address documents by root_id (the docId kb_read consumes).
  - \`updated\` is the kernel's yyyymmddhhmmss per-block timestamp — sorts lexically, no parsing needed.
- refs: id, def_block_id, def_block_root_id, block_id, root_id, box, ... (block-reference/backlink queries)

Discovery pattern: include hpath in discovery SELECTs — SELECT id, root_id, box, hpath, updated FROM blocks WHERE ... — every row then carries the docId (root_id) that kb_read and the write tools consume, its per-row KB attribution (box), and its recency (updated).

Rules: exactly one top-level SELECT; FROM blocks or refs only; single-table FROM (no JOINs, subqueries, CTEs, UNION, or bare HAVING). LIMIT is injected as 64 when absent; an agent-supplied LIMIT passes through uncapped. Aggregate queries (COUNT/GROUP BY) are allowed — their rows carry no box and are exempt from re-scoping.`;

export function registerQueryTool(pi: ExtensionAPI, hooks: ReadToolHooks) {
	pi.registerTool({
		name: "kb_query",
		label: "KB Query",
		description: QUERY_DESCRIPTION,
		parameters: Type.Object({
			kb: Type.Array(Type.String(), {
				description: "KB name(s) to query — must be in the active scope",
			}),
			sql: Type.String({
				description: "One SELECT statement over the blocks or refs table",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(
					errorEnvelope(
						"kb tools are not ready — session validation has not run",
					),
				);
			}
			const kernel = hooks.getKernel();
			const envelope = await runKbCall(
				{ validation, breaker: hooks.breaker, kb: params.kb, arity: "array" },
				async (names) => {
					if (kernel === undefined) {
						return errorEnvelope(
							"kb tools are not ready — settings did not load",
						);
					}
					const boxes = names.map((n) => resolveBox(n, validation));
					const certified = certifySelect(params.sql);
					if (!certified.ok) {
						return { status: "refused", message: certified.reason };
					}
					// Capture the original WHERE before the rebuild splices it —
					// verification compares the re-parse against it (§3).
					const originalWhere = certified.ast.where;
					const rebuilt = rebuildWithScope(certified.ast, boxes);
					const reparsed = parser.astify(rebuilt.stmt, SQL_DIALECT) as AST;
					const problem = verifyRebuilt(
						reparsed,
						boxes,
						originalWhere as Binary | null,
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
): Envelope {
	const { kept, dropped } = postFilterRows(rows, boxes);
	const envelope: Envelope = {
		status: "ok",
		message: `${kept.length} rows`,
		kb: names,
		boxes,
		count: kept.length,
	};
	if (dropped > 0) envelope.post_filtered = true;
	// Truncation fires when kept + dropped reaches the limit (§3) — a window
	// filled with out-of-scope rows must still signal in-scope rows beyond it.
	// The marker counts post-filter rows, never pre-filter ones.
	if (kept.length + dropped >= limit) {
		const path = spillFile(sessionId, "kb_query", jsonl(kept), "jsonl");
		envelope.truncated = `${limit} rows — refine the query; full result in ${path}`;
	}
	const payload = rowPayload(sessionId, "kb_query", kept);
	if (payload.rows !== undefined) {
		envelope.rows = payload.rows;
	} else {
		envelope.preview = payload.preview;
		envelope.fullResultPath = payload.fullResultPath;
	}
	return envelope;
}

// ---------------------------------------------------------------------------
// kb_search — per-KB fan-out (§3)
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
			// schema constraint closes the SQL-smuggling bypass (§3).
			{ additionalProperties: false },
		),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(
					errorEnvelope(
						"kb tools are not ready — session validation has not run",
					),
				);
			}
			const kernel = hooks.getKernel();
			const envelope = await runKbCall(
				{ validation, breaker: hooks.breaker, kb: params.kb, arity: "array" },
				async (names) => {
					if (kernel === undefined) {
						return errorEnvelope(
							"kb tools are not ready — settings did not load",
						);
					}
					return runSearchFanOut(
						ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						names,
						params.query,
					);
				},
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
	// One kernel call per resolved KB (paths: [<boxId>], §3) — never one call
	// with multiple paths under a single pageSize, which lets a hit-rich KB
	// fill the pre-filter window and silently drop the other KBs' matches.
	const nameBoxPairs = names.map((name) => ({
		name,
		boxId: resolveBox(name, validation),
	}));
	const merged: Record<string, unknown>[] = [];
	let dropped = 0;
	let truncatedKBs = 0;
	let truncatedRows = 0;
	for (const { name, boxId } of nameBoxPairs) {
		const result = await kernel.search({
			query,
			paths: [boxId],
			pageSize: RESULT_LIMIT,
		});
		for (const block of result.blocks) {
			// Post-filter backstop: merged rows dropped unless box ∈ resolved
			// set. Unreachable against a well-behaved kernel (each call was
			// scoped to one box); the drop path exists for contamination (§3).
			if (block.box !== boxId) {
				dropped++;
				continue;
			}
			// Echo contract: id, root_id (renamed from rootID), hpath (renamed
			// from hPath), box → resolved KB name, updated — never raw (§3).
			merged.push({
				id: block.id,
				root_id: block.rootID,
				hpath: block.hPath,
				box: name,
				updated: block.updated,
			});
		}
		if (result.matchedBlockCount > result.blocks.length) {
			truncatedKBs++;
			truncatedRows += result.matchedBlockCount;
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
	const payload = rowPayload(sessionId, "kb_search", merged);
	if (payload.rows !== undefined) {
		envelope.rows = payload.rows;
	} else {
		envelope.preview = payload.preview;
		envelope.fullResultPath = payload.fullResultPath;
	}
	return envelope;
}

// ---------------------------------------------------------------------------
// kb_read — exportMarkdown + outline ride-along (§3)
// ---------------------------------------------------------------------------

/** Extension-owned recursion bound for the getChildBlocks walk — the kernel
 * imposes no cap on block-container nesting, so this keeps the walk finite
 * (§3; the §4 7-level cap counts hpath separators, a different axis). */
const MAX_WALK_DEPTH = 32;

const READ_DESCRIPTION = `Fetch a GNUbrain doc as GFM markdown plus a heading→block-ID outline. Pass kb (one KB name) and docId — a root_id echoed by kb_query/kb_search, never an invented ID. The ownership check doubles as the scope check: a docId from another KB returns no rows. Call with kb: "kbs" to list active KBs (no docId, no kernel call). Use the outline's block IDs to target kb_write edits; grep the spilled full result for content when the body is large.`;

/**
 * The `kbs` discovery form (§3 item 7): `kb_read` with `kb: "kbs"` returns
 * the active KB set without touching the kernel. The echoed `kb: "kbs"` is a
 * reserved marker, not a real KB — a deliberate exception to the
 * success-echo contract; the payload rides in `names`. The marker is
 * identical in both forms (populated and empty scope) so a consumer branching
 * on it never sees a shape it didn't expect.
 */
export function kbsDiscoveryEnvelope(validation: SessionValidation): Envelope {
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

export function registerReadTool(pi: ExtensionAPI, hooks: ReadToolHooks) {
	pi.registerTool({
		name: "kb_read",
		label: "KB Read",
		description: READ_DESCRIPTION,
		parameters: Type.Object({
			kb: Type.String({
				description:
					"KB name the doc belongs to — must be in the active scope, or the reserved discovery name 'kbs' to list active KBs",
			}),
			// Optional so the kb: "kbs" discovery form passes schema validation;
			// a real read with no docId is refused inside the gated op (item 7).
			docId: Type.Optional(
				Type.String({
					description:
						"Document root block ID (root_id from kb_query/kb_search rows)",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(
					errorEnvelope(
						"kb tools are not ready — session validation has not run",
					),
				);
			}
			// Discovery short-circuit (kb: "kbs"): ahead of breaker/cooldown —
			// discovery succeeds while the breaker is tripped or a lockout is
			// armed and leaves the breaker state untouched. It cannot route
			// through guardCall/runKbCall: guardCall's pinned order fuses shape
			// → breaker → cooldown and cannot stop between them, and
			// runKbCall's success path would reset the breaker counter. The
			// shape check is a deliberate duplicate of guardCall's first check —
			// kept a one-liner so the two cannot drift (§3 item 7).
			if (params.kb === "kbs") {
				if (validation.shapeErrors.length > 0) {
					return textResult(configRefusalEnvelope(validation.shapeErrors));
				}
				return textResult(kbsDiscoveryEnvelope(validation));
			}
			const kernel = hooks.getKernel();
			const envelope = await runKbCall(
				{ validation, breaker: hooks.breaker, kb: params.kb, arity: "single" },
				async (names) => {
					if (kernel === undefined) {
						return errorEnvelope(
							"kb tools are not ready — settings did not load",
						);
					}
					// The missing-docId refusal lives inside the gated op, after
					// the gate resolved a valid kb: a typo'd kb with no docId must
					// get the unknown-KB rejection, not the guidance. Returned as
					// refused (never thrown), so runKbCall treats it as a
					// successful call (recordSuccess) — the pre-existing pattern
					// for op-internal refusals. Never answered with a doc listing
					// or metrics: a success-shaped payload would mask the
					// lost-docId mistake the call almost always is.
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
): Promise<Envelope> {
	const boxId = validation.validKBs.get(name);
	if (boxId === undefined) {
		return errorEnvelope(`KB '${name}' is not in the valid set`);
	}
	// GFM only, never getDoc (§3). The ownership query doubles as the scope
	// check: a docId from another KB matches no row. The kernel route takes a
	// bare stmt (no bind params), so trusted ids ride escaped literals (§4).
	const ownershipStmt =
		`SELECT root_id FROM blocks WHERE id = ${sqlString(docId)}` +
		` AND box = ${sqlString(boxId)}`;
	const ownership = await kernel.query(ownershipStmt);
	if (ownership.length === 0) {
		return errorEnvelope(
			`no doc '${docId}' in KB '${name}' — docIds are root_id values echoed by kb_query/kb_search; an ID from another KB reads as nothing`,
		);
	}
	const rootId = String(ownership[0]?.root_id);
	const doc = await kernel.exportMarkdown(rootId);
	const envelope: Envelope = {
		status: "ok",
		message: `${doc.content.length} chars from ${doc.hPath}`,
		kb: name,
		docId: rootId,
		hpath: doc.hPath,
	};

	const outline = await renderOutline(kernel, sessionId, "kb_read", rootId);
	envelope.outline = outline.outline;
	if (outline.fullOutlinePath !== undefined) {
		envelope.fullOutlinePath = outline.fullOutlinePath;
	}

	// §3 read budget: the spill mechanism is the only limit — large docs spill
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
	envelope.fullResultPath = spillPath;
	return envelope;
}

/**
 * Outline ride-along (§3/§4): getChildBlocks walk in document order — never
 * SQL enumeration (the `sort` column is a type weight, not document order).
 * Shared by kb_read and the write flow (duplicate-stop rows, create echo).
 */
export async function renderOutline(
	kernel: KernelReadClient,
	sessionId: string,
	tool: string,
	rootId: string,
): Promise<{ outline: string; fullOutlinePath?: string }> {
	return renderOutlineFromWalk(
		sessionId,
		tool,
		await walkBlockTree(kernel, rootId, 1),
	);
}

/** Outline rendering from a walk already in hand — write flows render the
 * result outline from the verification walk without a second traversal. */
export function renderOutlineFromWalk(
	sessionId: string,
	tool: string,
	walk: WalkedBlock[],
): { outline: string; fullOutlinePath?: string } {
	const headings = walk.filter((b) => b.type === "h");
	const lines = headings.map((h) => {
		const level = Number(String(h.subType ?? "h1").slice(1)) || 1;
		return `${"  ".repeat(level - 1)}${h.content} → ${h.id}`;
	});
	if (lines.length > OUTLINE_HEADINGS) {
		const path = spillFile(
			sessionId,
			`${tool}-outline`,
			jsonl(headings),
			"jsonl",
		);
		return {
			outline:
				lines.slice(0, OUTLINE_HEADINGS).join("\n") +
				`\n… ${lines.length - OUTLINE_HEADINGS} more — full outline in ${path}`,
			fullOutlinePath: path,
		};
	}
	return { outline: lines.join("\n") };
}

export interface WalkedBlock {
	id: string;
	type: string;
	subType: string;
	content: string;
	/** Container depth in the walk (root's direct children = 1). Headings
	 * are leaf blocks, so their section content sits at the heading's own
	 * depth — depth is what keeps move-anchor derivation at section level. */
	depth: number;
}

export interface NestedBlock extends WalkedBlock {
	children: NestedBlock[];
}

/** getChildBlocks walk preserving container structure (§3). Headings are
 * leaves; only real containers (lists, blockquotes, superblocks) nest. */
export async function walkBlockTreeNested(
	kernel: KernelReadClient,
	rootId: string,
	depth: number,
): Promise<NestedBlock[]> {
	if (depth > MAX_WALK_DEPTH) return [];
	let children: Record<string, unknown>[];
	try {
		children = await kernel.getChildBlocks(rootId);
	} catch {
		return []; // a vanished container mid-walk ends that branch, not the doc
	}
	const nodes: NestedBlock[] = [];
	for (const child of children) {
		const node: NestedBlock = {
			id: String(child.id),
			type: String(child.type ?? ""),
			subType: String(child.subType ?? ""),
			content: String(child.content ?? ""),
			depth,
			children: [],
		};
		node.children = await walkBlockTreeNested(kernel, node.id, depth + 1);
		nodes.push(node);
	}
	return nodes;
}

/** Full unfiltered getChildBlocks walk in document order. The heading filter
 * is rendering-only — callers keep the full set as write-verification
 * evidence (§3). */
export async function walkBlockTree(
	kernel: KernelReadClient,
	rootId: string,
	depth: number,
): Promise<WalkedBlock[]> {
	const flat: WalkedBlock[] = [];
	function flatten(nodes: NestedBlock[]): void {
		for (const node of nodes) {
			const { children: _children, ...block } = node;
			flat.push(block);
			flatten(node.children);
		}
	}
	flatten(await walkBlockTreeNested(kernel, rootId, depth));
	return flat;
}

// ---------------------------------------------------------------------------
// Toolset (§5 tool-masking record)
// ---------------------------------------------------------------------------

export const READ_TOOLSET_ID = "gnubrain.read";
export const READ_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.read";

/** Register the three read tools and declare the read toolset (§5): the
 * toolset exists so the surface is maskable from day one — default behavior
 * unchanged, no toggle subcommand (nothing asks to hide reads yet). */
export function registerReadToolsAndToolset(
	pi: ExtensionAPI,
	hooks: ReadToolHooks,
): Toolset {
	registerQueryTool(pi, hooks);
	registerSearchTool(pi, hooks);
	registerReadTool(pi, hooks);
	return defineToolset(pi, {
		id: READ_TOOLSET_ID,
		label: "GNUbrain KB reads",
		names: new Set(["kb_query", "kb_search", "kb_read"]),
		persistKey: READ_TOOLSET_PERSIST_KEY,
		defaultEnabled: true,
	});
}

export function textResult(envelope: Envelope): {
	content: { type: "text"; text: string }[];
	details: Envelope;
} {
	return {
		content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
		details: envelope,
	};
}
