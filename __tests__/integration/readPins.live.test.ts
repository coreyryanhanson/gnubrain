// Sprint 5b-b: the read-side integration cases — item 9 (search/query pins,
// first per §10's search-shape execution order), item 1 (title-guard kernel
// round-trip), items 2/3 (nested-mint + duplicate disambiguation, tool-path
// verified-create), item 4 (version-refusal contract pin). Runs against the
// live pinned kernel over the 5b-a fixtures; opt-in with
// SIYUAN_INTEGRATION=1, never in CI.

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { ContentBaselines } from "../../baselines.js";
import { CircuitBreaker } from "../../breaker.js";
import { globalSettingsPath, loadGnubrainSettings } from "../../settings.js";
import { RESULT_LIMIT } from "../../spill.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import { guardExactStmt } from "../../writeGuard.js";
import { registerWriteTool } from "../../write.js";
import { createWriteConfirmState } from "../../writeConfirm.js";
import {
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";
import {
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	awaitSearchable,
	mintDoc,
	pollUntil,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("5b-b read-side cases", () => {
	let fixtures: IntegrationFixtures;
	let client: SiYuanKernelClient;
	// Unique-suffix stamp shared by every title in the run, so guard pins
	// never collide with earlier runs' leftovers in the fresh fixtures.
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	let seq = 0;
	const unique = (stem: string): string => `${stem} ${stamp} ${++seq}`;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	/** Register the read tools on a fake pi, wired to a validation and the
	 * live client; returns a details-level runner. */
	function readSetup(validation: SessionValidation = fixtures.validation) {
		const { pi, runToolDetails } = createFakePi();
		registerReadToolsAndToolset(pi, {
			getValidation: () => validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			baselines: ContentBaselines.create(),
		});
		const { ctx } = createFakeCtx();
		return async (
			name: string,
			params: Record<string, unknown>,
		): Promise<Record<string, unknown> & { status: string }> =>
			runToolDetails(name, params, ctx);
	}

	/** Register kb_write over a create-call-counting view of the live client
	 * (prototype-chained, so the inherited methods keep their binding). */
	function writeSetup(validation: SessionValidation = fixtures.validation) {
		const createCalls: Record<string, unknown>[] = [];
		const kernel = Object.assign(Object.create(client), {
			createDocWithMarkdown: async (
				p: Parameters<SiYuanKernelClient["createDocWithMarkdown"]>[0],
			) => {
				createCalls.push(p as unknown as Record<string, unknown>);
				return client.createDocWithMarkdown(p);
			},
		}) as SiYuanKernelClient;
		const { pi, runToolDetails } = createFakePi();
		registerWriteTool(pi, {
			getValidation: () => validation,
			getKernel: () => kernel,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines: ContentBaselines.create(),
			confirm: async () => true,
		});
		const { ctx } = createFakeCtx();
		return {
			createCalls,
			run: async (
				params: Record<string, unknown>,
			): Promise<Record<string, unknown> & { status: string }> =>
				runToolDetails("kb_write", params, ctx),
		};
	}

	/** Envelope rows whether inline or spilled (a >64-row / >8k-char payload
	 * spills to the fullResultPath JSONL). */
	function rowsOf(env: Record<string, unknown>): Record<string, unknown>[] {
		if (Array.isArray(env.rows)) return env.rows;
		expect(env.fullResultPath).toBeDefined();
		return readFileSync(String(env.fullResultPath), "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	// -------------------------------------------------------------------
	// Item 9 — search + query pins (search-shape first, §10)
	// -------------------------------------------------------------------

	it(
		"item 9a: kb_query/kb_search scoping shape — every row carries a fixture box",
		async () => {
			const read = readSetup();
			const q = await read("kb_query", {
				kb: ["fixture-a"],
				sql: "SELECT id, root_id, box, hpath, updated FROM blocks LIMIT 50",
			});
			expect(q.status).toBe("ok");
			for (const row of rowsOf(q)) {
				expect(row.box).toBe(fixtures.notebookIds.fixtureA);
			}

			const s = await read("kb_search", {
				kb: ["fixture-a"],
				query: "a",
			});
			expect(s.status).toBe("ok");
			for (const row of rowsOf(s)) {
				expect(row.box).toBe("fixture-a");
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 9b: recall-loop echo — a two-fixture search hit carries root_id/box/resolved-KB/updated, and reads back",
		async () => {
			const term = unique("recall").replaceAll(" ", "-");
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				unique("/recall-a"),
				`# recall a\n\nanchor ${term} in fixture a\n`,
			);
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureB,
				unique("/recall-b"),
				`# recall b\n\nanchor ${term} in fixture b\n`,
			);
			await awaitSearchable(
				client,
				[fixtures.notebookIds.fixtureA, fixtures.notebookIds.fixtureB],
				term,
				2,
			);

			const read = readSetup();
			const res = await read("kb_search", {
				kb: ["fixture-a", "fixture-b"],
				query: term,
			});
			expect(res.status).toBe("ok");
			const rows = rowsOf(res);
			expect(rows.length).toBeGreaterThanOrEqual(2);
			expect(new Set(rows.map((r) => r.box))).toEqual(
				new Set(["fixture-a", "fixture-b"]),
			);
			for (const row of rows) {
				expect(row.root_id).toBeTruthy();
				expect(row.hpath).toBeTruthy();
				expect(String(row.updated)).toMatch(/^\d{14}$/);
			}
			// A hit's root_id is directly consumable as kb_read.
			const hit = rows.find((r) => r.box === "fixture-a")!;
			const readBack = await read("kb_read", {
				kb: "fixture-a",
				docId: hit.root_id,
			});
			expect(readBack.status).toBe("ok");
			expect(readBack.docId).toBe(hit.root_id);
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 9c: two-KB saturation — one saturated KB never crowds the other out (fan-out pin)",
		async () => {
			const term = unique("saturate").replaceAll(" ", "-");
			// RESULT_LIMIT + 1 matching paragraphs in fixture-a saturate its
			// per-KB window (pageSize = RESULT_LIMIT); exactly one hit in b.
			const paragraphs = Array.from(
				{ length: RESULT_LIMIT + 1 },
				(_, i) => `${term} paragraph ${i}`,
			).join("\n\n");
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				unique("/saturate-a"),
				`# saturate a\n\n${paragraphs}\n`,
			);
			await awaitSearchable(
				client,
				[fixtures.notebookIds.fixtureA],
				term,
				RESULT_LIMIT,
			);
			const bPath = unique("/saturate-b");
			await mintDoc(
				client,
				fixtures.notebookIds.fixtureB,
				bPath,
				`# saturate b\n\n${term} single hit\n`,
			);

			const read = readSetup();
			const res = await read("kb_search", {
				kb: ["fixture-a", "fixture-b"],
				query: term,
			});
			expect(res.status).toBe("ok");
			// fixture-a's window saturated → the truncation marker names 1 of 2.
			expect(String(res.truncated)).toContain("1 of 2");
			// The fan-out guarantee: fixture-b's hit survives the saturated
			// sibling window. The echo contract carries no content — the row's
			// hpath is the minted doc's.
			const rows = rowsOf(res);
			const bRow = rows.find((r) => r.box === "fixture-b");
			expect(bRow).toBeDefined();
			expect(String(bRow!.hpath)).toBe(bPath);
			expect(rows.filter((r) => r.box === "fixture-a").length).toBe(
				RESULT_LIMIT,
			);
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 9d: OR precedence under the scope splice — a top-level OR aggregate only reports fixture boxes",
		async () => {
			const read = readSetup();
			// If the box IN (...) splice lost its parenthesization, the OR's
			// right arm would escape the scoping predicate and out-of-scope
			// boxes would leak into the aggregate — aggregates are exempt from
			// the post-filter, so the leak would be visible here.
			const agg = await read("kb_query", {
				kb: ["fixture-a", "fixture-b"],
				sql: "SELECT box, COUNT(*) AS n FROM blocks WHERE type = 'p' OR type = 'h' GROUP BY box",
			});
			expect(agg.status).toBe("ok");
			const rows = rowsOf(agg);
			expect(rows.length).toBeGreaterThan(0);
			// Aggregates are exempt from the post-filter, so a leaked box would
			// be visible here — the box column carries the notebook id, never
			// the KB name (that rename is the search echo's contract).
			for (const row of rows) {
				expect([
					fixtures.notebookIds.fixtureA,
					fixtures.notebookIds.fixtureB,
				]).toContain(row.box);
				expect(Number(row.n)).toBeGreaterThan(0);
			}
			// AND-precedence control: the same aggregate per type — n(p) + n(h)
			// must equal the OR total (types are single-valued).
			const perType = await read("kb_query", {
				kb: ["fixture-a", "fixture-b"],
				sql: "SELECT type, COUNT(*) AS n FROM blocks WHERE type IN ('p', 'h') GROUP BY type",
			});
			expect(perType.status).toBe("ok");
			const byType = new Map(
				rowsOf(perType).map((r) => [String(r.type), Number(r.n)]),
			);
			const expected = (byType.get("p") ?? 0) + (byType.get("h") ?? 0);
			expect(rows.reduce((sum, r) => sum + Number(r.n), 0)).toBe(expected);
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 9e: exportMarkdown carries no block IDs — the read content never echoes the outline's ids",
		async () => {
			const docId = await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				unique("/export-pin"),
				"# Export pin\n\nplain paragraph\n",
			);
			const read = readSetup();
			const res = await read("kb_read", { kb: "fixture-a", docId });
			expect(res.status).toBe("ok");
			const content = String(res.content);
			expect(content).toContain("Export pin");
			// No IAL block attributes in the export.
			expect(content).not.toMatch(/\{: /);
			// None of the outline's block IDs appear in the content.
			for (const match of String(res.outline).matchAll(/→ (\S+)/g)) {
				expect(content).not.toContain(match[1]);
			}
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Item 1 — title-guard kernel round-trip
	// -------------------------------------------------------------------

	it(
		"item 1a: tab titles are refused at mint with zero kernel calls",
		async () => {
			const w = writeSetup();
			const result = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: "bad\ttitle",
				markdown: "body",
			});
			expect(result.status).toBe("refused");
			expect(String(result.message)).toContain("tab");
			expect(w.createCalls).toHaveLength(0);
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 1b: adversarial titles mint and re-find verbatim (blocks.content stores them unescaped) ('\"'→&quot;, ' verbatim, never &#30;/&#39;)",
		async () => {
			const w = writeSetup();
			const minted = new Map<string, string>();
			for (const title of ["A & B", 'say "hi"', "it's fine"]) {
				const ok = await w.run({
					kb: "fixture-a",
					mode: "create",
					topic: title,
					markdown: `body of ${title}`,
				});
				expect(ok.status).toBe("ok");
				minted.set(title, String(ok.docId));
			}

			// Re-create each title → the exact guard leg re-finds the minted
			// doc, and the row reports the kernel's stored form — verbatim
			// (live-verified: blocks.content is unescaped, unlike the ial).
			for (const [title, docId] of minted) {
				const dup = await w.run({
					kb: "fixture-a",
					mode: "create",
					topic: title,
					markdown: "x",
				});
				expect(dup.status).toBe("duplicate");
				expect(String(dup.message)).toContain(docId);
				const row = (dup.rows as Record<string, unknown>[])[0]!;
				expect(row.docId).toBe(docId);
				// Stored form is the submitted title verbatim — `"` and `&`
				// unescaped, `'` verbatim, never a numeric entity.
				expect(row.title).toBe(title);
			}
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 1c: clean titles store verbatim with the expected hpath (trim, Unicode, exactly-512-rune boundary)",
		async () => {
			const w = writeSetup();
			const trimmed = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: "  padded title  ",
				markdown: "body",
			});
			expect(trimmed.status).toBe("ok");
			expect(trimmed.title).toBe("padded title");
			expect(trimmed.hpath).toBe("/padded title");

			const unicode = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: "中文 标题 🎉",
				markdown: "body",
			});
			expect(unicode.status).toBe("ok");
			expect(unicode.title).toBe("中文 标题 🎉");
			expect(unicode.hpath).toBe("/中文 标题 🎉");

			// The exactly-512-rune boundary mints (the live pin for §4's
			// superset claim); one rune over is refused.
			const boundary = "x".repeat(512);
			const atLimit = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: boundary,
				markdown: "body",
			});
			expect(atLimit.status).toBe("ok");
			expect(atLimit.title).toBe(boundary);
			expect(atLimit.hpath).toBe(`/${boundary}`);

			const over = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: "x".repeat(513),
				markdown: "body",
			});
			expect(over.status).toBe("refused");
			expect(String(over.message)).toContain("512");
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 1d: renameDocByID mid-test — the guard re-finds by the new stored title",
		async () => {
			const w = writeSetup();
			const created = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: unique("Rename Original"),
				markdown: "body",
			});
			expect(created.status).toBe("ok");
			const docId = String(created.docId);

			const newTitle = unique("Renamed Title");
			await client.renameDocByID(docId, newTitle);
			await pollUntil(
				"renamed doc reaching the blocks index",
				async () =>
					(
						await client.query(
							guardExactStmt(fixtures.notebookIds.fixtureA, newTitle),
						)
					).length > 0,
			);

			const again = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: newTitle,
				markdown: "x",
			});
			expect(again.status).toBe("duplicate");
			expect((again.rows as Record<string, unknown>[])[0]!.docId).toBe(docId);
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Items 2/3 — nested-mint, duplicate disambiguation, verified-create
	// -------------------------------------------------------------------

	it(
		"item 2a: nested create → echo → read → guard on re-create; stale parent fails loud",
		async () => {
			const w = writeSetup();
			const parent = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: unique("Nest Parent"),
				markdown: "parent body",
			});
			expect(parent.status).toBe("ok");

			const childTitle = unique("Nest Child");
			const child = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: childTitle,
				parentId: parent.docId,
				markdown: "child body",
			});
			expect(child.status).toBe("ok");
			expect(child.hpath).toBe(`${parent.hpath}/${child.title}`);

			const read = readSetup();
			const readBack = await read("kb_read", {
				kb: "fixture-a",
				docId: child.docId,
			});
			expect(readBack.status).toBe("ok");
			expect(readBack.hpath).toBe(child.hpath);

			const dup = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: childTitle,
				parentId: parent.docId,
				markdown: "x",
			});
			expect(dup.status).toBe("duplicate");
			expect(String(dup.message)).toContain(String(child.docId));

			// Stale/foreign parent: fail loud before any mint.
			const orphan = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: unique("Orphan"),
				parentId: "20240101120000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				markdown: "x",
			});
			expect(orphan.status).toBe("error");
			expect(String(orphan.message)).toContain("does not resolve to a doc");
			expect(w.createCalls).toHaveLength(2); // parent + child only
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 2b: duplicate rows carry outlines + per-row spilled markdown; confirmNew third mint; deletes clear the guard",
		async () => {
			const w = writeSetup();
			const title = unique("Dup Pin");
			const d1 = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: `# ${title}

first body`,
			});
			expect(d1.status).toBe("ok");
			const d2 = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: `# ${title}

second body`,
				confirmNew: true,
			});
			expect(d2.status).toBe("ok");
			expect(d2.docId).not.toBe(d1.docId);

			// Third create, no confirmNew: a two-row duplicate stop with
			// outlines, spilled markdown, both docIds and the confirmNew exit.
			const stop = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: "third body",
			});
			expect(stop.status).toBe("duplicate");
			const rows = stop.rows as Record<string, unknown>[];
			expect(rows).toHaveLength(2);
			expect(String(stop.message)).toContain(String(d1.docId));
			expect(String(stop.message)).toContain(String(d2.docId));
			expect(String(stop.message)).toContain("confirmNew: true");
			for (const row of rows) {
				expect(String(row.outline).length).toBeGreaterThan(0);
				const md = readFileSync(String(row.markdownPath), "utf8");
				expect(md.length).toBeGreaterThan(0);
			}

			const d3 = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: `# ${title}

third body`,
				confirmNew: true,
			});
			expect(d3.status).toBe("ok");

			// Deletes via the tool; then the guard exact leg is clean again.
			for (const docId of [d1.docId, d2.docId, d3.docId]) {
				const del = await w.run({
					kb: "fixture-a",
					mode: "delete",
					docId,
					doc: true,
				});
				expect(del.status).toBe("ok");
			}
			const box = fixtures.notebookIds.fixtureA;
			await pollUntil(
				"deleted docs leaving the blocks index",
				async () =>
					(await client.query(guardExactStmt(box, title))).length === 0,
			);
			const d4 = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: "fourth body",
			});
			expect(d4.status).toBe("ok");
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 2c: guard-stop staging round-trip — markdownFile retry with confirmNew mints the staged body",
		async () => {
			const w = writeSetup();
			const title = unique("Stage Pin");
			const seed = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: "seed body",
			});
			expect(seed.status).toBe("ok");

			const bigBody = Array.from(
				{ length: 300 },
				(_, i) => `staging line ${i} for ${title}`,
			).join("\n\n");
			const stop = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: bigBody,
			});
			expect(stop.status).toBe("duplicate");
			const stagedPath = String(stop.stagedPath);
			expect(readFileSync(stagedPath, "utf8")).toBe(bigBody);

			const retry = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdownFile: stagedPath,
				confirmNew: true,
			});
			expect(retry.status).toBe("ok");
			// The export carries the kernel's YAML frontmatter + title heading;
			// the staged body itself must round-trip verbatim.
			const back = await client.exportMarkdown(String(retry.docId));
			expect(back.content).toContain(bigBody);
		},
		LIVE_TIMEOUT,
	);

	it(
		"item 3: tool-path verified-create — guard matches first, no create call fires, the duplicate stop echoes the existing doc",
		async () => {
			const title = unique("Pre-Existing");
			const existing = await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/${title}`,
				"existing body\n",
			);

			const w = writeSetup();
			const stop = await w.run({
				kb: "fixture-a",
				mode: "create",
				topic: title,
				markdown: "attempted body",
			});
			expect(stop.status).toBe("duplicate");
			expect(String(stop.message)).toContain(existing);
			expect((stop.rows as Record<string, unknown>[])[0]!.docId).toBe(existing);
			// No create call fired — the guard stopped before the mint.
			expect(w.createCalls).toHaveLength(0);
			// Single-row stop: the block-ID echo (straight edit) + spilled
			// markdown of the existing doc.
			const blockIds = stop.blockIds as Record<string, unknown>[];
			expect(Array.isArray(blockIds)).toBe(true);
			expect(blockIds.length).toBeGreaterThan(0);
			const md = readFileSync(
				String((stop.rows as Record<string, unknown>[])[0]!.markdownPath),
				"utf8",
			);
			expect(md).toContain("existing body");
		},
		LIVE_TIMEOUT,
	);

	// -------------------------------------------------------------------
	// Item 4 — version-refusal contract pin
	// -------------------------------------------------------------------

	it(
		"item 4: a deliberately wrong per-test pin refuses every write naming both versions; reads proceed with the drift warning",
		async () => {
			// Per-test config through the production seam (pinnedVersion rides
			// runSessionValidation) — the module constant is untouched, so the
			// setup's pin-equality assert still holds.
			const settingsText = JSON.stringify({ gnubrain: fixtures.settings });
			const loaded = await loadGnubrainSettings(
				async () => settingsText,
				globalSettingsPath("/gnubrain-it-fake-home"),
				undefined,
			);
			const drift = await runSessionValidation({
				loaded,
				kernel: client,
				pinnedVersion: "9.9.9",
			});
			expect(drift.probe).toBe("drift");
			expect(drift.kernelVersion).toBe("3.8.4");

			const w = writeSetup(drift);
			for (const params of [
				{
					kb: "fixture-a",
					mode: "create",
					topic: unique("Version Pin"),
					markdown: "x",
				},
				{
					kb: "fixture-a",
					mode: "edit",
					docId: "20240101120000-deadbeefdeadbeefdeadbeefdeadbeef",
					blockId: "20240101120000-cafebabecafebabecafebabecafebabe",
					markdown: "x",
				},
			]) {
				const refused = await w.run(params);
				expect(refused.status).toBe("refused");
				const msg = String(refused.message);
				expect(msg).toContain("3.8.4");
				expect(msg).toContain("9.9.9");
			}
			expect(w.createCalls).toHaveLength(0);

			// Reads proceed; the drift rides the envelope as a payload field.
			const read = readSetup(drift);
			const q = await read("kb_query", {
				kb: ["fixture-a"],
				sql: "SELECT id, root_id, box FROM blocks LIMIT 5",
			});
			expect(q.status).toBe("ok");
			const driftNote = String(q.drift);
			expect(driftNote).toContain("3.8.4");
			expect(driftNote).toContain("9.9.9");
		},
		LIVE_TIMEOUT,
	);
});
