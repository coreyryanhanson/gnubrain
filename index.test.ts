import { describe, expect, it } from "vitest";
import register, { type GnubrainDeps } from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	return {
		pi: pi as unknown as Parameters<typeof register>[0],
		fire: (event: string, ctx: unknown) => handlers.get(event)?.(event, ctx),
	};
}

function fakeCtx(options?: {
	cwd?: string;
	entries?: { type: string; customType?: string; data?: unknown }[];
}) {
	const statuses: [string, string | undefined][] = [];
	return {
		ctx: {
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
				theme: { fg: (_c: string, t: string) => t },
			},
			cwd: options?.cwd ?? "/project",
			sessionManager: {
				getEntries: () => options?.entries ?? [],
			},
		},
		statuses,
	};
}

const GLOBAL_SETTINGS = JSON.stringify({
	gnubrain: {
		baseUrl: "http://127.0.0.1:6806",
		apiToken: "token",
		kbs: [{ name: "dev", notebook: "nb-1" }],
		defaultKBs: ["dev"],
	},
});

function deps(options?: {
	global?: string;
	project?: string;
	version?: string;
}): GnubrainDeps & { notebooks: () => number } {
	let notebookCalls = 0;
	return {
		readFile: async (path: string) => {
			if (path.startsWith("/project")) {
				if (options?.project === undefined) {
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				}
				return options.project;
			}
			return options?.global ?? GLOBAL_SETTINGS;
		},
		createClient: () => ({
			baseUrl: "http://127.0.0.1:6806",
			getVersion: async () => options?.version ?? "3.8.3",
			listNotebooks: () => {
				notebookCalls++;
				return Promise.resolve({
					notebooks: [
						{
							id: "nb-1",
							name: "dev",
							encrypted: false,
							unlocked: true,
							closed: false,
						},
					],
				});
			},
		}),
		notebooks: () => notebookCalls,
	};
}

describe("index wiring", () => {
	it("session_start validates, resolves scope from defaultKBs, and renders the hollow slot", async () => {
		const { pi, fire } = fakePi();
		const d = deps();
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		expect(d.notebooks()).toBe(1);
		expect(statuses.at(-1)?.[0]).toBe("kb");
		expect(statuses.at(-1)?.[1]).toBe("○ kb: dev");
	});

	it("session_start picks up the persisted kb-scope snapshot over defaultKBs", async () => {
		const { pi, fire } = fakePi();
		register(pi, deps());
		const { ctx, statuses } = fakeCtx({
			entries: [
				{ type: "custom", customType: "kb-scope", data: { active: [] } },
			],
		});
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("○ kb: (none)");
	});

	it("a shape failure degrades the session and the slot shows the config tag", async () => {
		const { pi, fire } = fakePi();
		const d = deps({ global: "{ broken" });
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		expect(d.notebooks()).toBe(0); // no kernel calls past a shape failure
		expect(statuses.at(-1)?.[1]).toBe("● kb: config");
	});

	it("the slot re-renders after a session_tree restore and clears on session_shutdown", async () => {
		const { pi, fire } = fakePi();
		register(pi, deps());
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		statuses.length = 0;
		await fire("session_tree", ctx);
		expect(statuses).toEqual([["kb", "○ kb: dev"]]);
		await fire("session_shutdown", ctx);
		expect(statuses.at(-1)).toEqual(["kb", undefined]);
	});
});
