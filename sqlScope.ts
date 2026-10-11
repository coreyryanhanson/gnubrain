// SQL certification: parser-based SELECT certification, scoped rebuild with
// re-parse verification, and the post-filter backstop. Pure layer — no
// kernel, no pi (the unit suite and the live smoke import it directly).

import type { AST, BaseFrom, Binary, Select } from "node-sql-parser";
import { Parser } from "node-sql-parser";
import { RESULT_LIMIT } from "./spill.js";

const CERT_TABLES = new Set(["blocks", "refs"]);
const parser = new Parser();
const SQL_DIALECT = { type: "sqlite" } as const;

/** True anywhere in the value tree a parsed subquery node sits. The top-level
 * FROM loop in certifySelect only sees FROM entries; subqueries also parse
 * into WHERE, the SELECT list, and ORDER BY, so the scan covers the rest of
 * the AST. Only a select node carries type "select", so legitimate aggregate
 * /GROUP BY queries never trip it. */
function containsNestedSelect(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if ((value as { type?: unknown }).type === "select") return true;
	return Object.values(value).some(containsNestedSelect);
}

type CertResult = { ok: true; ast: Select } | { ok: false; reason: string };

/** rung 1 — parser-based certification, never a token scan. Worst case
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
	// astify does not reject multi-statement input — it returns an array,
	// so the cert rejects on Array.isArray.
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
	// The kernel's readonly layer permits WITH — rung 1 is the only line of
	// defense against a CTE shadowing an allowlisted table.
	if (node.with !== undefined && node.with !== null) {
		return { ok: false, reason: "CTEs (WITH) are not allowed" };
	}
	// UNION parses as type 'select' with the second arm in _next/set_op,
	// so rejection keys on those fields, not the type string.
	if (node._next !== undefined || node.set_op !== undefined) {
		return { ok: false, reason: "UNION / compound queries are not allowed" };
	}
	if (node.having !== undefined && node.having !== null) {
		return { ok: false, reason: "HAVING is not allowed" };
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
	// An output alias named `box` collides with the scope predicate at the
	// post-filter: every row would carry a `box` field whose value is not a
	// box id, so the whole result would drop to "0 rows". The alias covers
	// both `AS box` and the bare `expr box` form; a plain `SELECT box` column
	// (the real scope column) has no alias and stays allowed.
	if (Array.isArray(node.columns)) {
		for (const col of node.columns) {
			if (col.as === "box") {
				return {
					ok: false,
					reason: "projection may not alias a column to 'box'",
				};
			}
		}
	}
	// The root is itself a select, so the scan starts at its property values.
	if (Object.values(node).some(containsNestedSelect)) {
		return { ok: false, reason: "subqueries are not allowed" };
	}
	return { ok: true, ast: node };
}

/** The sqlite LIMIT of a parsed select. The comma form (`LIMIT m, n`) puts
 * the OFFSET in the first slot and the limit in the second; a negative limit
 * is sqlite's "no limit". Non-finite → undefined (the sqlite grammar only
 * admits numeric literals here, so this also guards parser-shape drift). */
function limitOf(limit: Select["limit"]): number | undefined {
	if (limit === undefined || limit === null || !Array.isArray(limit.value)) {
		return undefined;
	}
	const value = Number(limit.value[limit.seperator === "," ? 1 : 0]?.value);
	return Number.isFinite(value) ? value : undefined;
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

interface RebuiltStatement {
	stmt: string;
	limit: number;
}

/**
 * rung 2 rebuild: splice `(existing) AND box IN (...)` into the top-level
 * WHERE (fresh WHERE when none — never a bare concatenation, which would turn
 * `a OR b` into `a OR (b AND box IN ...)`), inject LIMIT iff the AST shows
 * none, serialize, and re-parse for verification.
 */
export function rebuildWithScope(
	ast: Select,
	boxes: string[],
): RebuiltStatement {
	const boxIn = boxInAst(boxes);
	if (ast.limit === undefined || ast.limit === null) {
		ast.limit = {
			seperator: "",
			value: [{ type: "number", value: RESULT_LIMIT }],
		};
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
	// After the injection above the AST always carries a limit; the fallback
	// only fires if the parser stopped producing the documented node shape.
	return { stmt, limit: limitOf(ast.limit) ?? RESULT_LIMIT };
}

const norm = (x: unknown): string => JSON.stringify(x);

/**
 * rung 2 verification: the executed statement is the re-parsed one, and
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
	const reLimit = limitOf(re.limit);
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

/** rung 3 — post-filter backstop. Rows that carry a `box` field are
 * dropped unless `box` is in the resolved set; aggregate rows (no `box`)
 * are exempt — rung 2 guarantees the injected predicate on the executed
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

/** Re-parse a rebuilt statement with the certification dialect — the
 * verification layer runs on the re-parsed AST, never the serialized text. */
export function reparse(stmt: string): AST {
	return parser.astify(stmt, SQL_DIALECT) as AST;
}
