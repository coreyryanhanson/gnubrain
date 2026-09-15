// writeCreate tests — guard-stop draft staging (stagedPath byte-equality,
// retry message, no staging for file bodies / non-guard stops) and
// verified-create (by-ID asserts, nested parent read-back, stale-parent and
// ground-truth fail-loud) — executed through the registered kb_write tool
// via the shared harness.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
		const r = await execute({ ...base, topic: " Docker Networking " });
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
