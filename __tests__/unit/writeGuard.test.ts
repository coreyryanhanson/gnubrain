// writeGuard tests — mint policy rejections and the title guard (verbatim
// stored-form patterns, near-match variants, separator-only fallback, uniform
// duplicate stops, confirmNew bypass) — executed through the registered
// kb_write tool via the shared harness.

import { describe, expect, it } from "vitest";
import {
	guardExactPattern,
	guardNearPatterns,
	guardNearStmt,
	validateMintTitle,
} from "../../writeGuard.js";
import { base, setup } from "./writeHarness.js";

describe("mint policy", () => {
	it("rejects each mint violation with its message and zero kernel calls", async () => {
		const cases: [string, string][] = [
			[" ", "empty after trim"],
			["a/b", "contains '/'"],
			["x".repeat(513), "512 runes"],
			["has\ttab", "tab/newline/control"],
			["has\nnewline", "tab/newline/control"],
		];
		for (const [topic, expected] of cases) {
			const { execute, calls } = setup();
			const r = await execute({ ...base, topic });
			expect(r.status).toBe("refused");
			expect(r.message).toContain(expected);
			expect(calls).toHaveLength(0);
		}
	});

	it("accepts the exactly-512-rune boundary and HTML-special characters", () => {
		expect(validateMintTitle("x".repeat(512)).ok).toBe(true);
		expect(validateMintTitle("R&D").ok).toBe(true);
		expect(validateMintTitle("O'Reilly").ok).toBe(true);
	});

	it("trims before validating", () => {
		const mint = validateMintTitle(" Docker Networking ");
		expect(mint.ok && mint.title).toBe("Docker Networking");
	});
});

describe("title guard", () => {
	it("runs the exact leg against the single notebook, ASCII-cased variants included via LIKE", async () => {
		const { execute, calls } = setup({
			config: {
				exactRows: [
					{
						id: "d1",
						root_id: "d1",
						content: "docker networking",
						updated: "20260101120000",
					},
				],
			},
		});
		// Submitted casing differs only in ASCII case — the exact leg matches
		// (LIKE is ASCII-case-insensitive) and returns a uniform duplicate stop.
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("duplicate");
		const exact = calls.find(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(String(exact?.args)).toContain("box = 'nb-r'");
		expect(String(exact?.args)).toContain("type = 'd'");
		// Escape parity: pattern = the title verbatim (the kernel stores doc
		// titles unescaped in blocks.content), % and _ LIKE-escaped.
		expect(String(exact?.args)).toContain(
			guardExactPattern("Docker Networking"),
		);
	});

	it("matches HTML-special titles verbatim — the kernel stores them unescaped", async () => {
		const { execute, calls } = setup();
		await execute({ ...base, topic: "R&D" });
		const exact = calls.find(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(String(exact?.args)).toContain("R&D");
	});

	it("escapes % and _ in the guard patterns", () => {
		expect(guardExactPattern("100%_devops")).toBe("100\\%\\_devops");
	});

	it("leaves double quotes verbatim — the kernel stores content unescaped", () => {
		expect(guardExactPattern('a"b')).toBe('a"b');
		expect(guardNearPatterns('a"b')).toEqual(['a"b%']);
	});

	it("leaves the apostrophe verbatim — the kernel does not escape it", () => {
		expect(guardExactPattern("it's")).toBe("it's");
		expect(guardNearPatterns("it's")).toEqual(["it's%"]);
	});

	it("near-match legs include the underscore variant (kebab-vs-snake)", () => {
		expect(guardNearPatterns("docker networking")).toEqual([
			"docker networking%",
			"docker-networking%",
			"docker\\_networking%",
		]);
	});

	it("near-match fragments are built from the verbatim title", () => {
		// One-word titles dedupe to a single leg.
		expect(guardNearPatterns("R&D")).toEqual(["R&D%"]);
	});

	it("separator-only titles still yield a well-formed near leg (no empty parens)", async () => {
		for (const topic of ["-", "_", "---", "- _ -"]) {
			expect(guardNearPatterns(topic).length).toBeGreaterThan(0);
			expect(guardNearStmt("nb-r", topic)).not.toContain("AND ()");
		}
		// End to end: the create mints instead of failing on malformed SQL.
		const { execute, calls } = setup();
		const r = await execute({ ...base, topic: "-" });
		expect(r.status).toBe("ok");
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});

	it("exact stop: uniform duplicate for multi-row, all rows + per-row markdown spills", async () => {
		const { execute } = setup({
			config: {
				exactRows: [
					{
						id: "d1",
						root_id: "d1",
						content: "Docker Networking",
						updated: "20260101120000",
					},
					{
						id: "d2",
						root_id: "d2",
						content: "Docker Networking",
						updated: "20260102090000",
					},
				],
			},
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("duplicate");
		const rows = r.rows as { docId: string; markdownPath: string }[];
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.docId).toMatch(/^d[12]$/);
			expect(row.markdownPath).toMatch(/kb_write-candidate-[0-9a-f]{16}\.md$/);
		}
		expect(r.blockIds).toBeUndefined();
		// Message names all docIds and the confirmNew exit.
		expect(r.message).toContain("d1, d2");
		expect(r.message).toContain("confirmNew: true");
	});

	it("single-row duplicate adds the block-ID echo", async () => {
		const { execute } = setup({
			config: {
				exactRows: [
					{
						id: "d1",
						root_id: "d1",
						content: "Docker Networking",
						updated: "20260101120000",
					},
				],
			},
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("duplicate");
		const blocks = r.blockIds as { id: string; content: string }[];
		expect(blocks[0]?.id).toBe("h1");
		expect(blocks[0]?.content).toBe("Heading");
	});

	it("near-match stop: excerpt-only candidates, no candidate spill, cap + marker", async () => {
		const nearRows = Array.from({ length: 21 }, (_, i) => ({
			id: `d${i}`,
			root_id: `d${i}`,
			content: `docker networking part ${i}`,
			updated: "20260101120000",
		}));
		const { execute, calls } = setup({
			config: {
				nearRows,
				childRows: [
					{ id: "p1", type: "p", subType: "", content: "first para" },
				],
			},
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("near_matches");
		const candidates = r.candidates as {
			docId: string;
			firstParagraph: string;
			markdownPath?: string;
		}[];
		expect(candidates).toHaveLength(20);
		expect(candidates[0]?.firstParagraph).toBe("first para");
		for (const c of candidates) {
			expect(c.markdownPath).toBeUndefined();
		}
		expect(r.truncated).toContain("capped at 20");
		// Guard ran both legs: exact (empty) then near.
		const stmts = calls.filter((c) => c.method === "query");
		expect(stmts.length).toBe(2);
		expect(String(stmts[1]?.args)).toContain("OR content LIKE");
	});

	it("confirmNew bypasses both guard legs (zero guard queries)", async () => {
		const { execute, calls } = setup({
			config: {
				exactRows: [
					{
						id: "d1",
						root_id: "d1",
						content: "Docker Networking",
						updated: "20260101120000",
					},
				],
			},
		});
		const r = await execute({ ...base, confirmNew: true });
		expect(r.status).toBe("ok");
		// Only verified-create's read-back runs — no LIKE (guard) statements.
		const guardQueries = calls.filter(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(guardQueries).toHaveLength(0);
	});
});
