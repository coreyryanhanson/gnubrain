// writeCreate tests — guard-stop draft staging (stagedPath byte-equality,
// retry message, no staging for file bodies / non-guard stops) and
// verified-create (by-ID asserts, nested parent read-back, stale-parent and
// ground-truth fail-loud) — executed through the registered kb_write tool
// via the shared harness.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	SiYuanApiError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
} from "siyuan-kb-primitives";
import { statementKind } from "siyuan-kb-primitives/testing";
import { CircuitBreaker } from "../../breaker.js";
import { validation } from "./fixtures.js";
import {
	type StubConfig,
	base,
	setup,
	storedContentStub,
} from "./writeHarness.js";

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
				// The kernel's real vanished-id refusal: HTTP 200, code -1.
				armWalkError: (arm) =>
					arm(
						new SiYuanApiError(
							200,
							-1,
							"block not found or its encrypted notebook is locked",
						),
					),
			},
		});
		const r = await execute({ ...base, markdown: "the draft body" });
		expect(r.status).toBe("duplicate");
		const rows = r.rows as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.docId).toBe("d1");
		// The vanished branch is named in the outline, not silently dropped:
		// the walk's incompleteness fact rides the render call, so the
		// served marker says the empty outline may be missing branches.
		expect(rows[0]!.outline).toBe(
			"\n… (outline incomplete: a container vanished or its notebook locked while reading — some branches may be missing)",
		);
	});

	it("candidate deleted between the walk and the spill read: exportMarkdown degrades to an empty excerpt, the outline survives", async () => {
		// The walk arm reaches the outline leg only — the exportMarkdown catch
		// (the guard query matched, the spill read lost the race) needs its
		// own arm.
		const { execute, calls } = setup({
			config: {
				...duplicateConfig,
				armExportError: (arm) => arm(new SiYuanApiError(404)),
			},
		});
		const r = await execute({ ...base, markdown: "the draft body" });
		expect(r.status).toBe("duplicate");
		const rows = r.rows as Record<string, unknown>[];
		expect(rows).toHaveLength(1);
		expect(rows[0]!.docId).toBe("d1");
		// The walk (and the outline it seeds) succeeded — only the spill read
		// degraded to an empty body.
		expect(rows[0]!.outline).not.toBe("");
		expect(calls.filter((c) => c.method === "exportMarkdown")).toHaveLength(1);
	});

	/** Single-row duplicate stop over a doc with a heading and a paragraph —
	 * the served outline + blockIds rows the seeding legs ride. Per-doc seeds
	 * (childrenFor, not the create-flow alias childRows) so unseeded walk ids
	 * stay childless. */
	const stopChildren = [
		{ id: "h1", type: "h", subType: "h1", content: "Heading" },
		{ id: "p1", type: "p", subType: "", content: "served body" },
	];
	const seededStopConfig: StubConfig = {
		...duplicateConfig,
		childrenFor: { d1: stopChildren, "d-doc": stopChildren },
	};

	/** Scripted `WHERE id IN` content reads from a live map — the test
	 * mutates it after the stop to simulate a concurrent kernel-side edit. */
	function storedContentHarness(stored: Record<string, string>) {
		const harness = setup({
			config: {
				...seededStopConfig,
				blockRows: [{ id: "p1", content: "served body" }],
			},
		});
		storedContentStub(harness, stored);
		return harness;
	}

	it("duplicate stop seeds baselines for the served outline + blockIds rows", async () => {
		const harness = storedContentHarness({ p1: "served body" });
		const r = await harness.execute({ ...base, markdown: "the draft body" });
		expect(r.status).toBe("duplicate");
		const blockIds = r.blockIds as { id: string }[];
		expect(blockIds.map((b) => b.id)).toContain("p1");
		// The serve-time snapshot exists — the follow-up edit verifies against
		// what the agent saw, not against content read at edit time.
		expect(harness.baselines.servedHash("h1")).toBeDefined();
		expect(harness.baselines.servedHash("p1")).toBeDefined();
	});

	it("concurrent change after the duplicate stop → the follow-up edit refuses stale_content", async () => {
		const stored: Record<string, string> = { p1: "served body" };
		const harness = storedContentHarness(stored);
		const stop = await harness.execute({ ...base, markdown: "the draft body" });
		expect(stop.status).toBe("duplicate");
		// The user edits the block after the stop served it — the change
		// lands in the live tree the precondition re-reads (and in the
		// index's stored map, which now lags behind it).
		stored.p1 = "concurrently rewritten";
		const treeP1 = harness.childrenFor["d-doc"]?.find(
			(r) => (r as { id?: string }).id === "p1",
		) as { content: string } | undefined;
		expect(treeP1).toBeDefined();
		treeP1!.content = "concurrently rewritten";
		const edit = await harness.execute({
			kb: "recipes",
			mode: "edit",
			docId: "d-doc",
			blockId: "p1",
			markdown: "overwrite",
		});
		expect(edit.status).toBe("refused");
		expect(edit.reason).toBe("stale_content");
		expect(edit.currentContent).toBe("concurrently rewritten");
		expect(
			harness.calls.filter((c) => c.method === "updateBlock"),
		).toHaveLength(0);
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
		expect(r.outline).toContain("# Heading → h1");
	});

	it("child row missing after create → fail-loud after the bounded re-reads", async () => {
		const { execute, client } = setup({ config: { createdRows: [] } });
		let verifiedReads = 0;
		const baseQuery = client.query.bind(client);
		client.query = async (stmt: string) => {
			if (statementKind(stmt) === "verified-root") {
				verifiedReads += 1;
				return [];
			}
			return baseQuery(stmt);
		};
		const r = await execute({ ...base });
		expect(r.status).toBe("error");
		expect(r.message).toContain("verified-create failed");
		// 1 initial read + 5 backoff re-reads, then fail-loud — never a retry
		// of the create itself.
		expect(verifiedReads).toBe(6);
	});

	it("index lag: blocks row not queryable on the first read appears on a backoff re-read → ok", async () => {
		const { execute, client } = setup();
		const baseQuery = client.query.bind(client);
		let verifiedReads = 0;
		client.query = async (stmt: string) => {
			// The verified-create assert is the only read on the returned id;
			// the guard legs are LIKE reads on the guard head.
			if (statementKind(stmt) === "verified-root") {
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

// A transport failure ON the create call itself: the kernel's response
// never arrived, so the mint may or may not exist — the outcome-unverified
// verdict, never the retry-inviting "unreachable".
describe("transport failure on the create call itself", () => {
	it("timeout on createDocWithMarkdown → outcome unverified, no docId", async () => {
		const { execute, calls } = setup({
			config: {
				onCreate: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
		});
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("outcome is unverified");
		expect(r.message).toContain("do NOT retry blindly");
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(r.docId).toBeUndefined();
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});

	it("network drop on createDocWithMarkdown classifies the same way", async () => {
		const { execute } = setup({
			config: {
				onCreate: () => {
					throw new SiYuanNetworkError();
				},
			},
		});
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("outcome is unverified");
		expect(r.message).not.toContain("SiYuan unreachable");
	});
});

describe("breaker reset (structural contact)", () => {
	/** The gate's observable is recordSuccess: an op that reached the kernel
	 * resets the consecutive count exactly once per call, an op-internal
	 * zero-contact refusal (drift) must not. Contact is observed
	 * structurally — the op runs against the gate's tracked client, so any
	 * method invocation marks it and the probe (getVersion) does not. */

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

	it("a duplicate stop that reached the kernel resets the count", async () => {
		const breaker = new CircuitBreaker();
		const recordSuccess = vi.spyOn(breaker, "recordSuccess");
		const { execute } = setup({ breaker, config: duplicateConfig });
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("duplicate");
		expect(recordSuccess).toHaveBeenCalledTimes(1);
	});

	it("confirmNew bypass resets the count — the mint reached the kernel", async () => {
		const breaker = new CircuitBreaker();
		const recordSuccess = vi.spyOn(breaker, "recordSuccess");
		const { execute } = setup({ breaker });
		const r = await execute({ ...base, confirmNew: true });
		expect(r.status).toBe("ok");
		expect(recordSuccess).toHaveBeenCalledTimes(1);
	});

	it("a drift refusal invokes no method — count not reset", async () => {
		const breaker = new CircuitBreaker();
		const recordSuccess = vi.spyOn(breaker, "recordSuccess");
		const { execute } = setup({
			breaker,
			validation: validation({
				probe: { verdict: "drift", kernelVersion: "3.8.5" },
			}),
		});
		const r = await execute({ ...base, topic: "Docker Networking" });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("3.8.5");
		expect(recordSuccess).not.toHaveBeenCalled();
	});
});
