// writeGuard tests — mint policy rejections and the execute-driven title
// guard cases (duplicate/near stops, confirmNew bypass) through the
// registered kb_write tool via the shared harness. The pure pattern cases
// (LIKE escaping, verbatim stored-form patterns, near-match variants,
// statement shapes) live in siyuan-kb-primitives, beside the builders.

import { describe, expect, it } from "vitest";
import { GUARD_EXACT_CAP } from "siyuan-kb-primitives";
import { statementKind } from "siyuan-kb-primitives/testing";
import { validateMintTitle } from "../../writeGuard.js";
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

	it("trims before validating", () => {
		const mint = validateMintTitle(" Docker Networking ");
		expect(mint.ok && mint.title).toBe("Docker Networking");
	});
});

describe("title guard", () => {
	it("runs the exact leg as a verbatim equality against the single notebook", async () => {
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
		// Verbatim submission: the exact leg is a `content =` equality
		// (BINARY collation — case-sensitive), so only the verbatim title
		// stops as a duplicate; an ASCII case variant falls to the near leg
		// (LIKE folds case there) and classifies `near`.
		const r = await execute({ ...base, topic: "docker networking" });
		expect(r.status).toBe("duplicate");
		const exact = calls.find(
			(c) => c.method === "query" && String(c.args).includes("content ="),
		);
		expect(String(exact?.args)).toContain("box = 'nb-r'");
		expect(String(exact?.args)).toContain("type = 'd'");
		expect(String(exact?.args)).toContain("content = 'docker networking'");
		expect(String(exact?.args)).not.toContain("LIKE");
		// Explicit LIMIT from the primitives — the kernel's silent statement
		// cap never applies to the exact leg.
		expect(String(exact?.args)).toContain(`LIMIT ${GUARD_EXACT_CAP + 1}`);
	});

	it("duplicate stop caps rendering and names the truncation at the exact cap", async () => {
		const exactRows = Array.from({ length: GUARD_EXACT_CAP + 1 }, (_, i) => ({
			id: `d${i}`,
			root_id: `d${i}`,
			content: "Docker Networking",
			updated: "20260101120000",
		}));
		const { execute } = setup({ config: { exactRows } });
		const r = await execute({ ...base });
		expect(r.status).toBe("duplicate");
		// Rendering is capped at GUARD_EXACT_CAP rows — a walk plus a markdown
		// export per row — while the count reads "64+" and the truncated
		// marker carries the cap.
		expect(r.rows as unknown[]).toHaveLength(GUARD_EXACT_CAP);
		expect(r.message).toContain(`${GUARD_EXACT_CAP}+ existing docs`);
		expect(r.truncated).toContain(`capped at ${GUARD_EXACT_CAP}`);
	});

	it("matches HTML-special titles verbatim — the kernel stores them unescaped", async () => {
		const { execute, calls } = setup();
		await execute({ ...base, topic: "R&D" });
		const exact = calls.find(
			(c) => c.method === "query" && String(c.args).includes("content ="),
		);
		expect(String(exact?.args)).toContain("content = 'R&D'");
	});

	it("separator-only titles mint instead of failing on malformed SQL", async () => {
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
		// Only verified-create's read-back runs — no guard leg (exact or near)
		// fires behind confirmNew.
		const guardQueries = calls.filter(
			(c) => c.method === "query" && statementKind(String(c.args)) === "guard",
		);
		expect(guardQueries).toHaveLength(0);
	});
});
