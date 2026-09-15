import { describe, expect, it } from "vitest";
import { SiYuanAuthError } from "siyuan-kernel-api";
import register, { type GnubrainDeps } from "./index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const entries: { type: string; customType?: string; data?: unknown }[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerCommand(
			name: string,
			options: {
				handler: (args: string, ctx: unknown) => Promise<void> | void;
			},
		) {
			commands.set(name, options);
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	};
	return {
		pi: pi as unknown as Parameters<typeof register>[0],
		fire: (event: string, ctx: unknown) => handlers.get(event)?.(event, ctx),
		runCommand: async (args: string, ctx: unknown) =>
			await commands.get("kb")?.handler(args, ctx),
		entries,
	};
}

function fakeCtx(options?: {
	cwd?: string;
	entries?: { type: string; customType?: string; data?: unknown }[];
}) {
	const statuses: [string, string | undefined][] = [];
	const notifications: [string, string | undefined][] = [];
	return {
		ctx: {
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
				notify: (message: string, severity?: string) => {
					notifications.push([message, severity]);
				},
				theme: { fg: (_c: string, t: string) => t },
			},
			cwd: options?.cwd ?? "/project",
			sessionManager: {
				getEntries: () => options?.entries ?? [],
			},
		},
		statuses,
		notifications,
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
	notebooksError?: Error;
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
				if (options?.notebooksError) throw options.notebooksError;
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

	it("/kb <name> off persists a complete post-toggle snapshot and repaints the slot", async () => {
		const { pi, fire, runCommand, entries } = fakePi();
		register(pi, deps());
		const { ctx, statuses, notifications } = fakeCtx();
		await fire("session_start", ctx);
		await runCommand("dev off", ctx);
		expect(entries.at(-1)).toEqual({
			type: "custom",
			customType: "kb-scope",
			data: { active: [] },
		});
		expect(statuses.at(-1)?.[1]).toBe("○ kb: (none)");
		expect(notifications.at(-1)?.[0]).toContain("scope: (none)");
	});

	it("/kb <name> on activates an inactive KB and persists it", async () => {
		const { pi, fire, runCommand, entries } = fakePi();
		register(pi, deps());
		const { ctx } = fakeCtx({ entries });
		await fire("session_start", ctx);
		await runCommand("dev off", ctx);
		await runCommand("dev on", ctx);
		expect(entries.at(-1)?.data).toEqual({ active: ["dev"] });
	});

	it("an idempotent re-toggle does not append another scope entry", async () => {
		const { pi, fire, runCommand, entries } = fakePi();
		register(pi, deps());
		const { ctx } = fakeCtx();
		await fire("session_start", ctx);
		await runCommand("dev on", ctx); // already active via defaultKBs
		expect(entries).toEqual([]);
	});

	it("a /kb dispatch re-runs validation and recovers a degraded session", async () => {
		const { pi, fire, runCommand, entries } = fakePi();
		let versionError: Error | undefined = new Error("connection refused");
		const d = deps();
		const base = d.createClient!;
		d.createClient = (baseUrl, token) => {
			const client = base(baseUrl, token) as unknown as Record<string, unknown>;
			if (versionError) {
				client.getVersion = () => Promise.reject(versionError!);
			}
			return client as never;
		};
		register(pi, d);
		const { ctx, statuses, notifications } = fakeCtx();
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev"); // unreachable: filled glyph

		versionError = undefined; // the kernel comes back
		await runCommand("dev off", ctx);
		// The re-check succeeded: toggle applied, snapshot persisted.
		expect(entries.at(-1)?.data).toEqual({ active: [] });
		expect(statuses.at(-1)?.[1]).toBe("○ kb: (none)");
		expect(notifications.at(-1)?.[0]).toContain("scope: (none)");
	});

	it("a failed re-check re-engages degradation without looping", async () => {
		const { pi, fire, runCommand } = fakePi();
		const d = deps({ notebooksError: new Error("kernel gone") });
		register(pi, d);
		const { ctx, statuses, notifications } = fakeCtx();
		await fire("session_start", ctx);
		const callsAfterStart = d.notebooks();
		await runCommand("all on", ctx);
		expect(d.notebooks()).toBe(callsAfterStart + 1); // exactly one re-check
		expect(notifications.at(-1)?.[1]).toBe("warning");
		expect(statuses.at(-1)?.[1]).not.toBe("○ kb: dev");
	});

	it("a corrected apiToken takes effect on the next /kb dispatch", async () => {
		const { pi, fire, runCommand } = fakePi();
		const d = deps();
		const base = d.createClient!;
		let authError: Error | undefined = new SiYuanAuthError(401);
		d.createClient = () => {
			const client = base("", "") as unknown as Record<string, unknown>;
			if (authError) {
				client.listNotebooks = () => Promise.reject(authError!);
			}
			return client as never;
		};
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		// Three consecutive dispatches under the bad token trip the breaker.
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: breaker");

		authError = undefined; // the token is fixed
		await runCommand("all on", ctx);
		// The re-check cleared the breaker and the empty valid set.
		expect(statuses.at(-1)?.[1]).toBe("○ kb: dev");
	});
});
