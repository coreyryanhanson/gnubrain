import { describe, expect, it } from "vitest";
import {
	SiYuanAuthError,
	SiYuanNetworkError,
	PINNED_SIYUAN_VERSION,
	type KernelProbeClient,
	type NotebookList,
} from "siyuan-kb-primitives";
import { loadGnubrainSettings } from "../../settings.js";
import {
	latestPersistedScope,
	runSessionValidation,
	type SessionValidation,
} from "../../validation.js";

function notebookList(
	notebooks: Partial<NotebookList["notebooks"][number]>[],
): NotebookList {
	return {
		notebooks: notebooks.map((n) => ({
			id: n.id ?? "nb-1",
			name: n.name ?? "NB",
			encrypted: n.encrypted ?? false,
			unlocked: n.unlocked ?? true,
			closed: n.closed ?? false,
		})),
	};
}

interface StubCalls {
	version: number;
	notebooks: number;
}

function stubKernel(options?: {
	version?: string;
	list?: NotebookList;
	probeError?: Error;
	listError?: Error;
}): { kernel: KernelProbeClient; calls: StubCalls } {
	const calls: StubCalls = { version: 0, notebooks: 0 };
	return {
		calls: calls,
		kernel: {
			baseUrl: "http://127.0.0.1:6806",
			async getVersion() {
				calls.version++;
				if (options?.probeError) throw options.probeError;
				return options?.version ?? PINNED_SIYUAN_VERSION;
			},
			async listNotebooks() {
				calls.notebooks++;
				if (options?.listError) throw options.listError;
				return options?.list ?? notebookList([{ id: "nb-1", name: "dev" }]);
			},
		},
	};
}

function globalSettings(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		gnubrain: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "dev", notebook: "nb-1" }],
			...overrides,
		},
	});
}

async function loaded(globalRaw: string, projectRaw?: string) {
	// Mock file system: "global" holds globalRaw; "project" exists only when
	// projectRaw is given (ENOENT otherwise, matching the loader's read seam).
	const files = new Map<string, string>([["global", globalRaw]]);
	if (projectRaw !== undefined) files.set("project", projectRaw);
	const readFile = async (path: string) => {
		const content = files.get(path);
		if (content === undefined) {
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		}
		return content;
	};
	return loadGnubrainSettings(
		readFile,
		"global",
		projectRaw === undefined ? undefined : "project",
	);
}

describe("startup validation order", () => {
	it("runs shape → probe → notebooks, and shape failure skips the network steps", async () => {
		const { kernel, calls } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(`{ "gnubrain": { "baseUrl": 42 } }`),
			kernel,
		});
		expect(calls.version).toBe(0);
		expect(calls.notebooks).toBe(0);
		expect(result.shapeErrors).toContain(
			"baseUrl is required and must be a non-empty string",
		);
		expect(result.probe).toEqual({ verdict: "never-probed" });
		expect(result.validKBs.size).toBe(0);
		expect(result.scope).toEqual([]);
	});

	it("probe failure still runs the notebook step (fail-closed empty valid set)", async () => {
		const { kernel, calls } = stubKernel({
			probeError: new SiYuanNetworkError(),
		});
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
		});
		expect(calls.version).toBe(1);
		expect(calls.notebooks).toBe(1);
		expect(result.probe).toEqual({ verdict: "unreachable" });
	});

	it("strict full-version match — a dev suffix or a shorter version drifts", async () => {
		for (const version of [`${PINNED_SIYUAN_VERSION}-dev`, "3.8", "3.8.5"]) {
			const { kernel } = stubKernel({ version });
			const result = await runSessionValidation({
				loaded: await loaded(globalSettings()),
				kernel,
			});
			expect(result.probe).toEqual({
				verdict: "drift",
				kernelVersion: version,
			});
		}
	});

	it("the pinned version is overridable per test (the version-refusal seam)", async () => {
		const { kernel } = stubKernel({ version: "3.9.0" });
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
			pinnedVersion: "3.9.0",
		});
		expect(result.probe).toEqual({ verdict: "ok", kernelVersion: "3.9.0" });
	});
});

describe("notebook validation (lsNotebooks)", () => {
	it("drops a stale notebook ID with a warning and keeps valid siblings", async () => {
		const { kernel } = stubKernel({
			list: notebookList([{ id: "nb-1", name: "live" }]),
		});
		const result = await runSessionValidation({
			loaded: await loaded(
				globalSettings({
					kbs: [
						{ name: "dev", notebook: "nb-1" },
						{ name: "gone", notebook: "nb-missing" },
					],
					defaultKBs: ["dev"],
				}),
			),
			kernel,
		});
		expect([...result.validKBs.keys()]).toEqual(["dev"]);
		expect(result.scope).toEqual(["dev"]);
		expect(result.warnings.some((w) => w.includes("'gone'"))).toBe(true);
	});

	it.each([true, false])(
		"rejects an encrypted notebook for both lock states (unlocked: %s)",
		async (unlocked) => {
			const { kernel } = stubKernel({
				list: notebookList([
					{ id: "nb-1", name: "secret", encrypted: true, unlocked },
				]),
			});
			const result = await runSessionValidation({
				loaded: await loaded(globalSettings()),
				kernel,
			});
			expect(result.validKBs.size).toBe(0);
			expect(result.warnings.some((w) => w.includes("'dev'"))).toBe(true);
		},
	);

	it("a call-level auth failure keeps the valid set empty and flags the breaker feed", async () => {
		const { kernel } = stubKernel({
			listError: new SiYuanAuthError(401),
		});
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
		});
		expect(result.validKBs.size).toBe(0);
		expect(result.authFailed).toBe(true);
		expect(result.scope).toEqual([]);
	});

	it("a network drop keeps the valid set empty but never counts toward the breaker", async () => {
		const { kernel } = stubKernel({
			listError: new SiYuanNetworkError(),
		});
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
		});
		expect(result.validKBs.size).toBe(0);
		expect(result.authFailed).toBe(false);
	});
});

describe("scope resolution", () => {
	it("persisted scope wins over defaultKBs", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings({ defaultKBs: ["dev"] })),
			kernel,
			persistedScope: ["dev"],
		});
		expect(result.scope).toEqual(["dev"]);
	});

	it("absent defaultKBs and no persisted scope → empty set, never activate-all", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
		});
		expect(result.scope).toEqual([]);
	});

	it("a persisted scope name that is no longer valid drops with a warning", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings()),
			kernel,
			persistedScope: ["dev", "phantom"],
		});
		expect(result.scope).toEqual(["dev"]);
		expect(result.warnings.some((w) => w.includes("'phantom'"))).toBe(true);
	});

	it("global defaultKBs naming an unknown KB warns and drops it, keeping valid siblings", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(globalSettings({ defaultKBs: ["dev", "missing"] })),
			kernel,
		});
		expect(result.shapeErrors).toEqual([]);
		expect(result.scope).toEqual(["dev"]);
		expect(result.warnings.some((w) => w.includes("'missing'"))).toBe(true);
	});

	it("project defaultKBs naming an unknown KB warns, drops it, keeps valid siblings, never falls back to the global default", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(
				globalSettings({ defaultKBs: ["dev"] }),
				JSON.stringify({
					gnubrain: { defaultKBs: ["dev", "missing"] },
				}),
			),
			kernel,
		});
		expect(result.shapeErrors).toEqual([]);
		expect(result.scope).toEqual(["dev"]);
		expect(result.warnings.some((w) => w.includes("'missing'"))).toBe(true);
	});

	it("dropping an unknown project default never falls back to the global defaultKBs", async () => {
		const { kernel } = stubKernel();
		const result = await runSessionValidation({
			loaded: await loaded(
				globalSettings({ defaultKBs: ["dev"] }),
				JSON.stringify({ gnubrain: { defaultKBs: ["missing"] } }),
			),
			kernel,
		});
		// Dropping names can only shrink scope — no silent expansion.
		expect(result.scope).toEqual([]);
	});
});

describe("latestPersistedScope", () => {
	it("returns the latest kb-scope entry's active set", () => {
		const entries = [
			{ type: "custom", customType: "kb-scope", data: { active: ["a"] } },
			{ type: "message" },
			{ type: "custom", customType: "kb-scope", data: { active: ["b", "c"] } },
		];
		expect(latestPersistedScope(entries)).toEqual(["b", "c"]);
	});

	it("returns undefined when no kb-scope entry exists", () => {
		expect(latestPersistedScope([{ type: "message" }])).toBeUndefined();
	});
});

describe("validation pipeline result sanity", () => {
	it("exposes the loaded settings and valid KB map on success", async () => {
		const { kernel } = stubKernel();
		const result: SessionValidation = await runSessionValidation({
			loaded: await loaded(globalSettings({ defaultKBs: ["dev"] })),
			kernel,
		});
		expect(result.settings?.apiToken).toBe("token");
		expect(result.validKBs.get("dev")).toBe("nb-1");
		expect(result.probe).toEqual({
			verdict: "ok",
			kernelVersion: PINNED_SIYUAN_VERSION,
		});
	});
});
