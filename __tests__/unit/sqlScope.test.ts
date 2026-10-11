// sqlScope unit coverage — parser certification, the rebuild + re-parse
// verification, and the post-filter backstop.

import { describe, expect, it } from "vitest";
import { type AST, type Binary, Parser } from "node-sql-parser";
import {
	certifySelect,
	postFilterRows,
	rebuildWithScope,
	verifyRebuilt,
} from "../../sqlScope.js";
import { RESULT_LIMIT } from "../../spill.js";

// ---------------------------------------------------------------------------
// Rung 1 — parser certification
// ---------------------------------------------------------------------------

describe("parser certification", () => {
	it("rejects DML", () => {
		expect(certifySelect("UPDATE blocks SET content = 'x'").ok).toBe(false);
		expect(certifySelect("DELETE FROM blocks").ok).toBe(false);
		expect(certifySelect("INSERT INTO blocks (id) VALUES ('x')").ok).toBe(
			false,
		);
	});

	it("rejects multi-statement input (astify returns an array)", () => {
		const result = certifySelect("SELECT 1; SELECT 2");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("multiple statements");
	});

	it("rejects a plain wrong table (FROM-allowlist violation)", () => {
		const result = certifySelect("SELECT * FROM sqlite_master");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("only blocks and refs");
	});

	it("rejects a comma cross-join", () => {
		const result = certifySelect("SELECT * FROM blocks, refs");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("single-table FROM");
	});

	it("rejects a CTE shadowing an allowlisted table (the kernel permits WITH)", () => {
		const result = certifySelect(
			"WITH blocks AS (SELECT 1 AS box) SELECT * FROM blocks",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("CTEs");
	});

	it("rejects subqueries", () => {
		const result = certifySelect("SELECT * FROM (SELECT id FROM blocks) AS t");
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("subqueries");
	});

	it("rejects subqueries in WHERE (the rebuild only scopes the outer WHERE)", () => {
		const inClause = certifySelect(
			"SELECT id FROM blocks WHERE id IN (SELECT id FROM refs)",
		);
		expect(inClause.ok).toBe(false);
		expect(!inClause.ok && inClause.reason).toContain("subqueries");
		const exists = certifySelect(
			"SELECT id FROM blocks WHERE EXISTS (SELECT 1 FROM refs)",
		);
		expect(exists.ok).toBe(false);
		expect(!exists.ok && exists.reason).toContain("subqueries");
	});

	it("rejects subqueries in the SELECT list", () => {
		const column = certifySelect(
			"SELECT (SELECT content FROM blocks LIMIT 1) AS leaked FROM blocks",
		);
		expect(column.ok).toBe(false);
		expect(!column.ok && column.reason).toContain("subqueries");
	});

	it("rejects UNION (parses as type 'select' with the second arm in _next/set_op)", () => {
		const result = certifySelect(
			"SELECT id FROM blocks UNION SELECT id FROM refs",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("UNION");
	});

	it("rejects JOINs (single-table-FROM policy)", () => {
		const result = certifySelect(
			"SELECT * FROM blocks JOIN refs ON blocks.id = refs.block_id",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("JOINs");
	});

	it("rejects HAVING", () => {
		const result = certifySelect(
			"SELECT box, COUNT(*) FROM blocks GROUP BY box HAVING COUNT(*) > 1",
		);
		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toContain("HAVING");
	});

	it("accepts a certified SELECT over blocks", () => {
		const result = certifySelect(
			"SELECT id, root_id, box, hpath, updated FROM blocks WHERE content LIKE '%foo%'",
		);
		expect(result.ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Rung 2 — AST rebuild + re-parse verification
// ---------------------------------------------------------------------------

describe("injected-predicate rebuild + re-parse", () => {
	// The executed statement is the re-parsed one, so verification runs on a
	// fresh parse of the serialized statement — the same flow the tool runs.
	const parser = new Parser();
	function rebuildAndVerify(sql: string, boxes = ["nb-r"]) {
		const certified = certifySelect(sql);
		if (!certified.ok) throw new Error(certified.reason);
		const originalWhere = certified.ast.where as Binary | null;
		const rebuilt = rebuildWithScope(certified.ast, boxes);
		const re = parser.astify(rebuilt.stmt, { type: "sqlite" }) as AST;
		const problem = verifyRebuilt(re, boxes, originalWhere, rebuilt.limit);
		return { rebuilt, problem };
	}

	it("OR precedence: the original expression stays grouped under AND", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE box = 'x' OR content LIKE '%y%'",
		);
		expect(problem).toBeUndefined();
		// Without the parens the serializer would render
		// `box = 'x' OR content LIKE '%y%' AND box IN (...)`.
		expect(rebuilt.stmt).toContain("(`box` = 'x' OR `content` LIKE '%y%')");
	});

	it("round-trips escaped quotes", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'O''Brien'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips LIKE backslash escapes", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content LIKE 'a\\\\_%'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips clause keywords inside strings", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'select where union having'",
		);
		expect(problem).toBeUndefined();
	});

	it("round-trips non-ASCII literals", () => {
		const { problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = '日本語テスト'",
		);
		expect(problem).toBeUndefined();
	});

	it("keeps the injected LIMIT on an ||-containing statement (the kernel's vitess path rejects ||)", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks WHERE content = 'a' || 'b'",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.stmt).toContain("LIMIT 64");
	});

	it("injects LIMIT iff the AST shows none", () => {
		const without = certifySelect("SELECT id FROM blocks");
		if (!without.ok) throw new Error(without.reason);
		const rebuilt = rebuildWithScope(without.ast, ["nb-r"]);
		expect(rebuilt.stmt).toContain(`LIMIT ${RESULT_LIMIT}`);
		expect(rebuilt.limit).toBe(RESULT_LIMIT);

		const withLimit = certifySelect("SELECT id FROM blocks LIMIT 5");
		if (!withLimit.ok) throw new Error(withLimit.reason);
		const kept = rebuildWithScope(withLimit.ast, ["nb-r"]);
		expect(kept.limit).toBe(5);
		expect(kept.stmt).toContain("LIMIT 5");
	});

	it("an agent-supplied LIMIT passes through uncapped", () => {
		const withBigLimit = certifySelect("SELECT id FROM blocks LIMIT 100000");
		if (!withBigLimit.ok) throw new Error(withBigLimit.reason);
		const rebuilt = rebuildWithScope(withBigLimit.ast, ["nb-r"]);
		expect(rebuilt.limit).toBe(100000);
		expect(rebuilt.stmt).toContain("LIMIT 100000");
		expect(rebuilt.stmt).toContain("`box` IN");
	});

	// Parser-shape pins for the non-plain LIMIT forms the sqlite grammar
	// admits: they parse into the same limit node, so a parser upgrade that
	// reshuffles slots turns these red instead of silently corrupting the
	// truncation marker.
	it("LIMIT m, n: the limit is the second number (the first is the OFFSET)", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT 2, 10",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(10);
		expect(rebuilt.stmt).toContain("LIMIT 2, 10");
	});

	it("LIMIT n OFFSET m: the limit is the first number", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT 5 OFFSET 2",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(5);
	});

	it("LIMIT -1 (sqlite's no-limit) verifies with the limit passed through", () => {
		const { rebuilt, problem } = rebuildAndVerify(
			"SELECT id FROM blocks LIMIT -1",
		);
		expect(problem).toBeUndefined();
		expect(rebuilt.limit).toBe(-1);
	});
});

// ---------------------------------------------------------------------------
// Rung 3 — post-filter backstop
// ---------------------------------------------------------------------------

describe("post-filter backstop", () => {
	it("drops rows whose box is out of scope and flags post_filtered", () => {
		const { kept, dropped } = postFilterRows(
			[
				{ box: "nb-r", id: "1" },
				{ box: "nb-other", id: "2" },
			],
			["nb-r"],
		);
		expect(kept).toEqual([{ box: "nb-r", id: "1" }]);
		expect(dropped).toBe(1);
	});

	it("box-less aggregate rows are exempt (they carry no box column)", () => {
		const { kept, dropped } = postFilterRows([{ "COUNT(*)": 42 }], ["nb-r"]);
		expect(kept).toEqual([{ "COUNT(*)": 42 }]);
		expect(dropped).toBe(0);
	});
});
