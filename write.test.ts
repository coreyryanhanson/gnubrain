// Sprint 4 unit ACs — write confirmation, file-path input, title guard,
// mint policy, verified-create, guard-stop staging — executed through the
// registered kb_write definition on a fake pi (§10).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "./breaker.js";
import type { SessionValidation } from "./validation.js";
import {
	createWriteConfirmState,
	guardExactPattern,
	guardNearPatterns,
	readBodyFile,
	registerWriteTool,
	validateMintTitle,
	type WriteKernelClient,
	type WriteParams,
	type WriteToolHooks,
} from "./write.js";

function validation(overrides: Partial<SessionValidation["settings"]> = {}) {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "recipes", notebook: "nb-r" }],
			...overrides,
		},
		shapeErrors: [],
		probe: "ok",
		kernelVersion: "3.8.3",
		validKBs: new Map([["recipes", "nb-r"]]),
		scope: ["recipes"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	} satisfies SessionValidation;
}

interface StubConfig {
	exactRows?: Record<string, unknown>[];
	nearRows?: Record<string, unknown>[];
	parentRows?: Record<string, unknown>[];
	createdRows?: Record<string, unknown>[];
	children?: Record<string, unknown>[];
	onCreate?: () => void;
}

/** Kernel stub with a SQL router: guard legs vs parent lookup vs the
 * verified-create read, plus a create-call log. */
/** Kernel stub with a SQL router: guard legs vs parent lookup vs the
 * verified-create read, plus a create-call log. Verified rows default to a
 * well-formed minted row unless the test pins the read (empty array =
 * missing row → fail-loud). */
function writeKernelStub(config: StubConfig = {}) {
	const calls: { method: string; args: unknown }[] = [];
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => "3.8.3",
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (stmt.includes(" OR content LIKE")) return config.nearRows ?? [];
			if (stmt.includes("LIKE")) return config.exactRows ?? [];
			if (stmt.includes("SELECT id, hpath, content FROM blocks")) {
				return config.parentRows ?? [];
			}
			if (stmt.includes("SELECT id, root_id, content, hpath, updated")) {
				return (
					config.createdRows ?? [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
							hpath: "/Docker Networking",
							updated: "20260101120000",
						},
					]
				);
			}
			throw new Error(`stub has no route for: ${stmt}`);
		},
		async search() {
			throw new Error("write flow never searches");
		},
		async exportMarkdown(id) {
			calls.push({ method: "exportMarkdown", args: id });
			return { hPath: "/doc", content: `# markdown of ${id}\nbody` };
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			return (
				config.children ?? [
					{ id: "h1", type: "h", subType: "h1", content: "Heading" },
				]
			);
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			config.onCreate?.();
			return "d-new";
		},
	};
	return { calls, client };
}

type Exec = (params: Record<string, unknown>) => Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown> & { status: string; message: string };
}>;

/** Test hooks + stub-config pass-through (a local intersection, not a
 * module augmentation — the production interface stays clean). */
type TestHooks = Partial<WriteToolHooks> & { __config?: StubConfig };

function setup(hooks: TestHooks = {}, v = validation()) {
	const tools = new Map<string, { execute: unknown }>();
	const pi = {
		registerTool(tool: { name: string; execute: unknown }) {
			tools.set(tool.name, tool);
		},
	};
	const { __config, ...hookRest } = hooks;
	const kernel = writeKernelStub(__config ?? {});
	registerWriteTool(
		pi as unknown as Parameters<typeof registerWriteTool>[0],
		{
			getValidation: () => v,
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			...hookRest,
		} as WriteToolHooks,
	);
	const tool = tools.get("kb_write") as unknown as {
		execute: (
			id: string,
			params: WriteParams,
			signal: undefined,
			onUpdate: undefined,
			ctx: unknown,
		) => Promise<{ details: Record<string, unknown> }>;
		parameters: unknown;
	};
	const ctx = {
		sessionManager: { getSessionId: () => "sess-w" },
		hasUI: hooks.hasUI ?? true,
		// Default dialog: the user always confirms — tests inject overrides.
		ui: { confirm: async () => true },
	};
	const execute = ((params: Record<string, unknown>) =>
		(
			tool.execute as (
				id: string,
				params: WriteParams,
				s: undefined,
				o: undefined,
				c: unknown,
			) => Promise<{
				details: Record<string, unknown> & { status: string; message: string };
			}>
		)("id", params as WriteParams, undefined, undefined, ctx)) as Exec;
	return { execute, kernel, tool };
}

const base = {
	kb: "recipes",
	mode: "create",
	topic: "Docker Networking",
	markdown: "some body",
};

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Schema + param contract
// ---------------------------------------------------------------------------

describe("kb_write schema", () => {
	it("does not declare confirmNew (learned only from rejections, §4)", () => {
		const { tool } = setup() as unknown as { tool: { parameters: unknown } };
		const props = Object.keys(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(props).toContain("kb");
		expect(props).toContain("mode");
		expect(props).not.toContain("confirmNew");
	});

	it("rejects kb: 'kbs' via the existing unknown-KB rejection — zero kernel calls", async () => {
		const { execute, kernel } = setup();
		const r = await execute({ ...base, kb: "kbs" });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("unknown KB 'kbs'");
		expect(kernel.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Mint policy (§4)
// ---------------------------------------------------------------------------

describe("mint policy", () => {
	it("rejects each mint violation with its message and zero kernel calls", async () => {
		const cases: [string, string][] = [
			["   ", "empty after trim"],
			["a/b", "contains '/'"],
			["x".repeat(513), "512 runes"],
			["has\ttab", "tab/newline/control"],
			["has\nnewline", "tab/newline/control"],
		];
		for (const [topic, expected] of cases) {
			const { execute, kernel } = setup();
			const r = await execute({ ...base, topic });
			expect(r.details.status).toBe("refused");
			expect(r.details.message).toContain(expected);
			expect(kernel.calls).toHaveLength(0);
		}
	});

	it("accepts the exactly-512-rune boundary and HTML-special characters", () => {
		expect(validateMintTitle("x".repeat(512)).ok).toBe(true);
		expect(validateMintTitle("R&D").ok).toBe(true);
		expect(validateMintTitle("O'Reilly").ok).toBe(true);
	});

	it("trims before validating", () => {
		const mint = validateMintTitle("  Docker Networking  ");
		expect(mint.ok && mint.title).toBe("Docker Networking");
	});
});

// ---------------------------------------------------------------------------
// File-path input (§4)
// ---------------------------------------------------------------------------

describe("markdownFile input", () => {
	it("errors on a missing file with zero kernel calls", async () => {
		const { execute, kernel } = setup();
		const r = await execute({
			...base,
			markdown: undefined,
			markdownFile: "/nope/missing.md",
		});
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("/nope/missing.md");
		expect(kernel.calls).toHaveLength(0);
	});

	it("errors on a non-regular file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		try {
			const { execute } = setup();
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: dir,
			});
			expect(r.details.status).toBe("error");
			expect(r.details.message).toContain("not a regular file");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("errors when both markdown and markdownFile are passed", async () => {
		const { execute, kernel } = setup();
		const r = await execute({ ...base, markdownFile: "/tmp/x.md" });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("exactly one");
		expect(kernel.calls).toHaveLength(0);
	});

	it("errors when neither is passed", async () => {
		const { execute, kernel } = setup();
		const r = await execute({ ...base, markdown: undefined });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("exactly one");
		expect(kernel.calls).toHaveLength(0);
	});

	it("captures the file once at call start — mid-flow mutation never applies", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		const path = join(dir, "body.md");
		writeFileSync(path, "v1", "utf8");
		let reads = 0;
		try {
			const { execute, kernel } = setup({
				readBodyFile: async (p) => {
					reads++;
					expect(reads).toBe(1);
					const content = readFileSync(p, "utf8");
					// Mid-flow mutation after the capture.
					writeFileSync(p, "v2-mutated", "utf8");
					return content;
				},
			});
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: path,
			});
			expect(r.details.status).toBe("ok");
			const create = kernel.calls.find(
				(c) => c.method === "createDocWithMarkdown",
			);
			expect((create?.args as { markdown: string } | undefined)?.markdown).toBe(
				"v1",
			);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("readBodyFile — missing file throws a structured error naming the path", async () => {
		await expect(readBodyFile("/nope/missing.md")).rejects.toThrow(
			"/nope/missing.md",
		);
	});
});

// ---------------------------------------------------------------------------
// Write confirmation (§5)
// ---------------------------------------------------------------------------

describe("write confirmation", () => {
	it("proceeds when confirmed; explicit decline is recoverable", async () => {
		const confirm = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const { execute } = setup({ confirm, hasUI: true });
		const declined = await execute({ ...base });
		expect(declined.details.status).toBe("refused");
		expect(confirm).toHaveBeenCalledTimes(1);
		// The decline answered nothing about the write itself — a re-ask is
		// legitimate (§5), so the second call runs a fresh dialog.
		const allowed = await execute({ ...base });
		expect(allowed.details.status).toBe("ok");
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it("cancelled and timed-out confirms both refuse; timeout is terminal (§10)", async () => {
		vi.useFakeTimers();
		// A dialog the user never answers: resolves false on abort.
		const confirm = vi.fn(
			(_t: string, _m: string, opts: { signal?: AbortSignal }) =>
				new Promise<boolean>((resolve) => {
					opts.signal?.addEventListener("abort", () => resolve(false));
				}),
		);
		const { execute } = setup(
			{ confirm, hasUI: true, __config: {} },
			validation({ writeConfirmTimeout: 1 }),
		);
		const promise = execute({ ...base });
		await vi.advanceTimersByTimeAsync(1500);
		const timedOut = await promise;
		expect(timedOut.details.status).toBe("refused");
		expect(timedOut.details.reason).toBe("confirm_timeout");
		expect(confirm).toHaveBeenCalledTimes(1);

		// Re-request of the same write: immediate terminal refusal, no new dialog.
		const again = await execute({ ...base });
		expect(again.details.status).toBe("refused");
		expect(again.details.reason).toBe("confirm_timeout");
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("an explicit decline does not mark the write terminal", async () => {
		const confirm = vi.fn().mockResolvedValue(false);
		const { execute } = setup({ confirm, hasUI: true });
		await execute({ ...base });
		await execute({ ...base });
		// Both calls asked — a decline never arms the terminal refusal.
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it("timeout 0 issues an untimed confirm", async () => {
		vi.useFakeTimers();
		let seenOpts: { signal?: AbortSignal } | undefined;
		const confirm = vi.fn(
			(_t: string, _m: string, opts: { signal?: AbortSignal }) => {
				seenOpts = opts;
				return Promise.resolve(true);
			},
		);
		const { execute } = setup(
			{ confirm, hasUI: true },
			validation({ writeConfirmTimeout: 0 }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("ok");
		// No signal — the dialog is untimed and can never fire confirm_timeout.
		expect(seenOpts?.signal).toBeUndefined();
		// No timer was armed that could abort anything later.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(r.details.status).toBe("ok");
	});
});

// ---------------------------------------------------------------------------
// Headless write default-deny (§5)
// ---------------------------------------------------------------------------

describe("headless default-deny", () => {
	it("refuses with no UI and allowUnattendedWrites absent — zero confirm/kernel calls", async () => {
		const confirm = vi.fn();
		const { execute, kernel } = setup({ confirm, hasUI: false });
		const r = await execute({ ...base });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("allowUnattendedWrites");
		expect(confirm).not.toHaveBeenCalled();
		expect(kernel.calls).toHaveLength(0);
	});

	it("refuses with no UI and allowUnattendedWrites: false", async () => {
		const { execute } = setup(
			{ hasUI: false },
			validation({ allowUnattendedWrites: false }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("refused");
	});

	it("allowUnattendedWrites: true proceeds unattended — dialog skipped", async () => {
		const confirm = vi.fn();
		const { execute, kernel } = setup(
			{ confirm, hasUI: false },
			validation({ allowUnattendedWrites: true }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("ok");
		expect(confirm).not.toHaveBeenCalled();
		expect(kernel.calls.some((c) => c.method === "createDocWithMarkdown")).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// Title guard (§4)
// ---------------------------------------------------------------------------

describe("title guard", () => {
	it("runs the exact leg against the single notebook, ASCII-cased variants included via LIKE", async () => {
		const { execute, kernel } = setup({
			__config: {
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
		expect(r.details.status).toBe("duplicate");
		const exact = kernel.calls.find(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(String(exact?.args)).toContain("box = 'nb-r'");
		expect(String(exact?.args)).toContain("type = 'd'");
		// Escape parity: pattern = HTML-escaped title, % and _ LIKE-escaped.
		expect(String(exact?.args)).toContain(
			guardExactPattern("Docker Networking"),
		);
	});

	it("matches HTML-special titles via escape parity", async () => {
		const { execute, kernel } = setup();
		await execute({ ...base, topic: "R&D" });
		const exact = kernel.calls.find(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(String(exact?.args)).toContain("R&amp;D");
	});

	it("escapes % and _ in the guard patterns", () => {
		expect(guardExactPattern("100%_devops")).toBe("100\\%\\_devops");
	});

	it("near-match legs include the underscore variant (kebab-vs-snake)", () => {
		expect(guardNearPatterns("docker networking")).toEqual([
			"docker networking%",
			"docker-networking%",
			"docker\\_networking%",
		]);
	});

	it("near-match fragments are built from the HTML-escaped title", () => {
		// One-word titles dedupe to a single leg.
		expect(guardNearPatterns("R&D")).toEqual(["R&amp;D%"]);
	});

	it("exact stop: uniform duplicate for multi-row, all rows + per-row markdown spills", async () => {
		const { execute } = setup({
			__config: {
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
		expect(r.details.status).toBe("duplicate");
		const rows = r.details.rows as { docId: string; markdownPath: string }[];
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.docId).toMatch(/^d[12]$/);
			expect(row.markdownPath).toMatch(/kb_write-candidate-[0-9a-f]{16}\.md$/);
		}
		expect(r.details.blockIds).toBeUndefined();
		// Message names all docIds and the confirmNew exit.
		expect(r.details.message).toContain("d1, d2");
		expect(r.details.message).toContain("confirmNew: true");
	});

	it("single-row duplicate adds the block-ID echo", async () => {
		const { execute } = setup({
			__config: {
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
		expect(r.details.status).toBe("duplicate");
		const blocks = r.details.blockIds as { id: string; content: string }[];
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
		const { execute, kernel } = setup({
			__config: {
				nearRows,
				children: [{ id: "p1", type: "p", subType: "", content: "first para" }],
			},
		});
		const r = await execute({ ...base });
		expect(r.details.status).toBe("near_matches");
		const candidates = r.details.candidates as {
			docId: string;
			firstParagraph: string;
			markdownPath?: string;
		}[];
		expect(candidates).toHaveLength(20);
		expect(candidates[0]?.firstParagraph).toBe("first para");
		for (const c of candidates) {
			expect(c.markdownPath).toBeUndefined();
		}
		expect(r.details.truncated).toContain("capped at 20");
		// Guard ran both legs: exact (empty) then near.
		const stmts = kernel.calls.filter((c) => c.method === "query");
		expect(stmts.length).toBe(2);
		expect(String(stmts[1]?.args)).toContain("OR content LIKE");
	});

	it("confirmNew bypasses both guard legs (zero guard queries)", async () => {
		const { execute, kernel } = setup({
			__config: {
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
		expect(r.details.status).toBe("ok");
		// Only verified-create's read-back runs — no LIKE (guard) statements.
		const guardQueries = kernel.calls.filter(
			(c) => c.method === "query" && String(c.args).includes("LIKE"),
		);
		expect(guardQueries).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Guard-stop staging (§4)
// ---------------------------------------------------------------------------

describe("guard-stop staging", () => {
	const duplicateConfig: StubConfig = {
		exactRows: [
			{
				id: "d1",
				root_id: "d1",
				content: "Docker Networking",
				updated: "20260101120000",
			},
		],
	};

	it("inline body: stagedPath byte-equal, retry message names markdownFile", async () => {
		const { execute } = setup({ __config: duplicateConfig });
		const r = await execute({ ...base, markdown: "the draft body" });
		const stagedPath = r.details.stagedPath as string;
		expect(stagedPath).toMatch(/draft-[0-9a-f]{16}\.md$/);
		expect(readFileSync(stagedPath, "utf8")).toBe("the draft body");
		expect(r.details.message).toContain(`markdownFile: '${stagedPath}'`);
	});

	it("markdownFile body: no staging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		const path = join(dir, "body.md");
		writeFileSync(path, "file body", "utf8");
		try {
			const { execute } = setup({ __config: duplicateConfig });
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: path,
			});
			expect(r.details.status).toBe("duplicate");
			expect(r.details.stagedPath).toBeUndefined();
			expect(r.details.message).not.toContain("markdownFile: '");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("near-match stop stages inline drafts; candidates stay excerpt-only", async () => {
		const { execute } = setup({
			__config: {
				nearRows: [
					{
						id: "d1",
						root_id: "d1",
						content: "docker networking",
						updated: "20260101120000",
					},
				],
			},
		});
		const r = await execute({ ...base, markdown: "the draft body" });
		expect(r.details.status).toBe("near_matches");
		expect(r.details.stagedPath).toMatch(/draft-[0-9a-f]{16}\.md$/);
		const candidates = r.details.candidates as { markdownPath?: string }[];
		expect(candidates[0]?.markdownPath).toBeUndefined();
	});

	it("non-guard stops stage nothing", async () => {
		const { execute } = setup();
		const r = await execute({ ...base });
		expect(r.details.status).toBe("ok");
		expect(r.details.stagedPath).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Verified-create + echo (§4)
// ---------------------------------------------------------------------------

describe("verified-create", () => {
	const createdRow = {
		id: "d-new",
		root_id: "d-new",
		content: "Docker Networking",
		hpath: "/Docker Networking",
		updated: "20260101120000",
	};

	it("top-level create: submission path, by-ID assert, stored-shape echo", async () => {
		const { execute, kernel } = setup({
			__config: { createdRows: [createdRow] },
		});
		const r = await execute({ ...base, topic: "  Docker Networking  " });
		expect(r.details.status).toBe("ok");
		const create = kernel.calls.find(
			(c) => c.method === "createDocWithMarkdown",
		);
		// Trim is the only lossless transform; top-level path is /<title>.
		expect(create?.args).toEqual({
			notebook: "nb-r",
			path: "/Docker Networking",
			markdown: "some body",
		});
		// Echo carries root docId, stored title, real hpath, fresh outline.
		expect(r.details.docId).toBe("d-new");
		expect(r.details.title).toBe("Docker Networking");
		expect(r.details.hpath).toBe("/Docker Networking");
		expect(r.details.outline).toContain("Heading → h1");
	});

	it("child row missing after create → fail-loud", async () => {
		const { execute } = setup({ __config: { createdRows: [] } });
		const r = await execute({ ...base });
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("verified-create failed");
	});

	it("nested create: parent hpath read-back + parentID sent", async () => {
		const { execute, kernel } = setup({
			__config: {
				parentRows: [{ id: "d1", hpath: "/Parent", content: "Parent" }],
				createdRows: [
					{ ...createdRow, content: "Child", hpath: "/Parent/Child" },
				],
			},
		});
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.details.status).toBe("ok");
		const create = kernel.calls.find(
			(c) => c.method === "createDocWithMarkdown",
		);
		expect(create?.args).toEqual({
			notebook: "nb-r",
			path: "/Parent/Child",
			markdown: "some body",
			parentID: "d1",
		});
	});

	it("stale parent (deleted between read-back and create) fails loud", async () => {
		const config: StubConfig = {
			parentRows: [{ id: "d1", hpath: "/Parent", content: "Parent" }],
			createdRows: [
				{ ...createdRow, content: "Child", hpath: "/Parent/Child" },
			],
		};
		// The kernel silently mints a ghost intermediate; the parent re-read
		// no longer resolves the moment the create lands.
		config.onCreate = () => {
			config.parentRows = [];
		};
		const { execute } = setup({ __config: config });
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("ghost intermediate");
	});

	it("child hpath mismatch against ground truth fails loud", async () => {
		const { execute } = setup({
			__config: {
				parentRows: [{ id: "d1", hpath: "/Parent", content: "Parent" }],
				createdRows: [
					{ ...createdRow, content: "Child", hpath: "/Parent/Wrong" },
				],
			},
		});
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("ground truth");
	});

	it("stale/foreign parentId refuses before any create", async () => {
		const { execute, kernel } = setup({ __config: { parentRows: [] } });
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("stale or foreign target");
		expect(kernel.calls.some((c) => c.method === "createDocWithMarkdown")).toBe(
			false,
		);
	});
});
