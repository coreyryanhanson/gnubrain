// writeCreate tests — guard-stop draft staging (stagedPath byte-equality,
// retry message, no staging for file bodies / non-guard stops) and
// verified-create (by-ID asserts, nested parent read-back, stale-parent and
// ground-truth fail-loud) — executed through the registered kb_write tool
// via the shared harness.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SiYuanApiError, SiYuanNetworkError } from "siyuan-kernel-api";
import { VERIFIED_ROOT_STMT_HEAD } from "../../writeCreate.js";
import { type StubConfig, base, setup } from "./writeHarness.js";

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
		const { execute } = setup({ config: duplicateConfig });
		const r = await execute({ ...base, markdown: "the draft body" });
		const stagedPath = r.stagedPath as string;
		expect(stagedPath).toMatch(/draft-[0-9a-f]{16}\.md$/);
		expect(readFileSync(stagedPath, "utf8")).toBe("the draft body");
		expect(r.message).toContain(`markdownFile: '${stagedPath}'`);
	});

	it("markdownFile body: no staging", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		const path = join(dir, "body.md");
		writeFileSync(path, "file body", "utf8");
		try {
			const { execute } = setup({ config: duplicateConfig });
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: path,
			});
			expect(r.status).toBe("duplicate");
			expect(r.stagedPath).toBeUndefined();
			expect(r.message).not.toContain("markdownFile: '");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("vanished candidate mid-guard-stop: duplicate stop degrades, not errors", async () => {
		const { execute } = setup({
			config: {
				...duplicateConfig,
				armWalkError: (arm) => arm(new SiYuanApiError(404)),
			},
		});
		const r = await execute({ ...base, markdown: "the draft body" });
		expect(r.status).toBe("duplicate");
		const rows = r.rows as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.docId).toBe("d1");
		expect(rows[0]!.outline).toBe("");
	});

	it("near-match stop stages inline drafts; candidates stay excerpt-only", async () => {
		const { execute } = setup({
			config: {
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
		expect(r.status).toBe("near_matches");
		expect(r.stagedPath).toMatch(/draft-[0-9a-f]{16}\.md$/);
		const candidates = r.candidates as { markdownPath?: string }[];
		expect(candidates[0]?.markdownPath).toBeUndefined();
	});

	it("non-guard stops stage nothing", async () => {
		const { execute } = setup();
		const r = await execute({ ...base });
		expect(r.status).toBe("ok");
		expect(r.stagedPath).toBeUndefined();
	});
});

describe("mode-target shape (create leg)", () => {
	it("stray mode-target params refuse before any kernel call", async () => {
		const { execute, calls } = setup();
		const r = await execute({ ...base, docId: "d1", headingId: "h1" });
		expect(r.status).toBe("refused");
		expect(r.message).toContain(
			"mode 'create' does not take: docId, headingId",
		);
		expect(calls).toHaveLength(0);
	});
});

describe("verified-create", () => {
	const createdRow = {
		id: "d-new",
		root_id: "d-new",
		content: "Docker Networking",
		hpath: "/Docker Networking",
		updated: "20260101120000",
	};

	it("top-level create: submission path, by-ID assert, stored-shape echo", async () => {
		const { execute, calls } = setup({
			config: { createdRows: [createdRow] },
		});
		const r = await execute({ ...base, topic: " Docker Networking " });
		expect(r.status).toBe("ok");
		const create = calls.find((c) => c.method === "createDocWithMarkdown");
		// Trim is the only lossless transform; top-level path is /<title>.
		expect(create?.args).toEqual({
			notebook: "nb-r",
			path: "/Docker Networking",
			markdown: "some body",
		});
		// Echo carries root docId, stored title, real hpath, fresh outline.
		expect(r.docId).toBe("d-new");
		expect(r.title).toBe("Docker Networking");
		expect(r.hpath).toBe("/Docker Networking");
		expect(r.outline).toContain("Heading → h1");
	});

	it("child row missing after create → fail-loud after the bounded re-reads", async () => {
		const { execute, client } = setup({ config: { createdRows: [] } });
		let verifiedReads = 0;
		const baseQuery = client.query.bind(client);
		client.query = async (stmt: string) => {
			if (stmt.startsWith(VERIFIED_ROOT_STMT_HEAD)) {
				verifiedReads += 1;
				return [];
			}
			return baseQuery(stmt);
		};
		const r = await execute({ ...base });
		expect(r.status).toBe("error");
		expect(r.message).toContain("verified-create failed");
		// 1 initial read + 3 backoff re-reads, then fail-loud — never a retry
		// of the create itself.
		expect(verifiedReads).toBe(4);
	});

	it("index lag: blocks row not queryable on the first read appears on a backoff re-read → ok", async () => {
		const { execute, client } = setup();
		const baseQuery = client.query.bind(client);
		let verifiedReads = 0;
		client.query = async (stmt: string) => {
			// The verified-create assert is the only read on the returned id;
			// the guard legs are LIKE reads on the guard head.
			if (stmt.startsWith(VERIFIED_ROOT_STMT_HEAD)) {
				verifiedReads += 1;
				if (verifiedReads === 1) return [];
			}
			return baseQuery(stmt);
		};
		const r = await execute({ ...base });
		expect(r.status).toBe("ok");
		expect(verifiedReads).toBe(2);
	});

	it("nested create: parent hpath read-back + parentID sent", async () => {
		const { execute, calls } = setup({
			config: {
				parentRows: [{ id: "d1", hpath: "/Parent", content: "Parent" }],
				createdRows: [
					{ ...createdRow, content: "Child", hpath: "/Parent/Child" },
				],
			},
		});
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.status).toBe("ok");
		const create = calls.find((c) => c.method === "createDocWithMarkdown");
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
		const { execute } = setup({ config });
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.status).toBe("error");
		expect(r.message).toContain("ghost intermediate");
	});

	it("child hpath mismatch against ground truth fails loud", async () => {
		const { execute } = setup({
			config: {
				parentRows: [{ id: "d1", hpath: "/Parent", content: "Parent" }],
				createdRows: [
					{ ...createdRow, content: "Child", hpath: "/Parent/Wrong" },
				],
			},
		});
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.status).toBe("error");
		expect(r.message).toContain("ground truth");
	});

	it("stale/foreign parentId refuses before any create", async () => {
		const { execute, calls } = setup({ config: { parentRows: [] } });
		const r = await execute({ ...base, topic: "Child", parentId: "d1" });
		expect(r.status).toBe("error");
		expect(r.message).toContain("stale or foreign target");
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(false);
	});
});

// near-match enrichment: a genuine API miss on a candidate (vanished doc
// mid-scan) leaves an empty excerpt; auth/rate-limit/network errors rethrow
// for runKbCall's classification instead of being masked as a missing excerpt.
describe("near-match enrichment error handling", () => {
	const nearRow = {
		id: "d1",
		root_id: "d1",
		content: "docker networking",
		updated: "20260101120000",
	};

	it("SiYuanApiError on a candidate: row still shown with empty excerpt", async () => {
		const { execute } = setup({
			config: {
				nearRows: [nearRow],
				armWalkError: (arm) => arm(new SiYuanApiError(404)),
			},
		});
		const r = await execute({ ...base, markdown: "body" });
		expect(r.status).toBe("near_matches");
		const candidates = r.candidates as { firstParagraph?: string }[];
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.firstParagraph).toBe("");
	});

	it("SiYuanNetworkError on a candidate: propagates, classified as unreachable", async () => {
		const { execute } = setup({
			config: {
				nearRows: [nearRow],
				armWalkError: (arm) => arm(new SiYuanNetworkError()),
			},
		});
		const r = await execute({ ...base, markdown: "body" });
		expect(r.status).toBe("error");
		expect(r.message).toContain("unreachable");
	});
});

// A network drop after a successful mint must report verificationFailed,
// never "unreachable" — the doc exists and a blind retry would duplicate it.
describe("network drop after a landed create", () => {
	it("verified-create reads fail → verificationFailed, not 'unreachable'", async () => {
		const { execute, calls, client } = setup({
			config: {
				createdRows: [
					{
						id: "d-new",
						root_id: "d-new",
						content: "Docker Networking",
						hpath: "/Docker Networking",
						updated: "20260101120000",
					},
				],
			},
		});
		const origCreate = client.createDocWithMarkdown.bind(client);
		client.createDocWithMarkdown = async (params) => {
			client.query = async () => {
				throw new SiYuanNetworkError();
			};
			return origCreate(params);
		};
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("post-write verification reads failed");
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});
});
