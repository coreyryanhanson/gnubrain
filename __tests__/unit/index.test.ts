import { describe, expect, it, vi } from "vitest";
import { SiYuanAuthError } from "siyuan-kernel-api";
import { TOOLSET_EVENTS } from "pi-tool-masking";
import register, { type GnubrainDeps } from "../../index.js";

interface EnvelopeShape {
	status: string;
	message: string;
	reason?: string;
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const entries: { type: string; customType?: string; data?: unknown }[] = [];
	const tools: { name: string }[] = [];
	const toolDefs = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ details: EnvelopeShape }> }
	>();
	// pi semantics: registered tools are active by default; masking rewrites
	// this set via setActiveTools.
	let active: string[] = [];
	const eventHandlers = new Map<string, Handler[]>();
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(
			name: string,
			options: {
				handler: (args: string, ctx: unknown) => Promise<void> | void;
			},
		) {
			commands.set(name, options);
		},
		registerTool(tool: { name: string; execute: unknown }) {
			tools.push({ name: tool.name });
			toolDefs.set(
				tool.name,
				tool as {
					execute: (...args: unknown[]) => Promise<{ details: EnvelopeShape }>;
				},
			);
			active = [...active, tool.name];
		},
		getAllTools: () => tools as never,
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
		events: {
			emit: () => {},
			on: (event: string, handler: Handler) => {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	};
	return {
		pi: pi as unknown as Parameters<typeof register>[0],
		emitEvent: async (event: string) =>
			Promise.all(
				(eventHandlers.get(event) ?? []).map((h) => h(event, undefined)),
			),
		fire: (event: string, ctx: unknown) =>
			Promise.all((handlers.get(event) ?? []).map((h) => h(event, ctx))),
		runCommand: async (args: string, ctx: unknown) =>
			await commands.get("kb")?.handler(args, ctx),
		runTool: async (name: string, params: unknown, ctx: unknown) => {
			const tool = toolDefs.get(name);
			if (tool === undefined) throw new Error(`no tool registered: ${name}`);
			return await tool.execute("test-id", params, undefined, undefined, ctx);
		},
		entries,
		tools,
	};
}

function fakeCtx(options?: {
	cwd?: string;
	entries?: { type: string; customType?: string; data?: unknown }[];
	hasUI?: boolean;
	confirm?: (
		title: string,
		message: string,
		opts?: { signal?: AbortSignal },
	) => Promise<boolean>;
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
				confirm: options?.confirm,
			},
			hasUI: options?.hasUI,
			cwd: options?.cwd ?? "/project",
			sessionManager: {
				getEntries: () => options?.entries ?? [],
				getBranch: () => options?.entries ?? [],
				getSessionId: () => "test-session",
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
	globalReadError?: Error;
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
			if (options?.globalReadError) throw options.globalReadError;
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
	it("settings read error at session_start degrades instead of throwing", async () => {
		const { pi, fire } = fakePi();
		register(
			pi,
			deps({
				globalReadError: Object.assign(new Error("boom"), { code: "EACCES" }),
			}),
		);
		const { ctx, statuses } = fakeCtx();
		// A rejected handler here would be an unhandled rejection — fire must
		// resolve, and the slot must name the degraded config cause.
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: config");
	});

	it("session_start validates, resolves scope from defaultKBs, and renders the hollow slot", async () => {
		const { pi, fire } = fakePi();
		const d = deps();
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		expect(d.notebooks()).toBe(1);
		expect(statuses.at(-1)?.[0]).toBe("kb");
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
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
		expect(statuses.at(-1)?.[1]).toBe("● kb: (none)");
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
		expect(statuses).toEqual([["kb", "● kb: dev"]]);
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
		expect(statuses.at(-1)?.[1]).toBe("● kb: (none)");
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
		expect(statuses.at(-1)?.[1]).toBe("● kb: (none)");
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
		expect(statuses.at(-1)?.[1]).not.toBe("● kb: dev");
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
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
	});

	it("a new session does not inherit a tipped breaker count", async () => {
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
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: breaker");

		await fire("session_shutdown", ctx);
		authError = undefined; // the token is fixed, but the closure lives on
		await fire("session_start", ctx);
		// The count restarted: a healthy re-check renders the healthy slot,
		// not the carried breaker tag.
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
	});

	it("confirm_timeout does not survive a session restart — the re-request gets a fresh dialog", async () => {
		vi.useFakeTimers();
		try {
			// writeConfirmTimeout: 1 so the dialog's abort timer is one fake tick.
			const settings = JSON.stringify({
				gnubrain: {
					baseUrl: "http://127.0.0.1:6806",
					apiToken: "token",
					kbs: [{ name: "dev", notebook: "nb-1" }],
					defaultKBs: ["dev"],
					writeConfirmTimeout: 1,
				},
			});
			const { pi, fire, runTool } = fakePi();
			const d = deps({ global: settings });
			const base = d.createClient!;
			d.createClient = () =>
				({ ...base("", ""), query: async () => [] }) as never;
			register(pi, d);
			// First dialog hangs until the abort, then answers false —
			// the timed-out path, not an explicit decline.
			let hangDialog = true;
			const { ctx } = fakeCtx({
				hasUI: true,
				confirm: (_t, _m, opts) =>
					new Promise<boolean>((resolve) => {
						if (!hangDialog) resolve(false);
						else opts?.signal?.addEventListener("abort", () => resolve(false));
					}),
			});
			await fire("session_start", ctx);
			const params = { kb: "dev", mode: "create", topic: "T", markdown: "b" };
			const first = runTool("kb_write", params, ctx);
			await vi.advanceTimersByTimeAsync(1000);
			const timedOut = (await first).details;
			expect(timedOut.status).toBe("refused");
			expect(timedOut.reason).toBe("confirm_timeout");

			// Same session: the refusal is terminal — no new dialog.
			const retried = await runTool("kb_write", params, ctx);
			expect(retried.details.reason).toBe("confirm_timeout");

			// New session in the same process: the timeout is forgotten —
			// the re-request reaches a fresh dialog (explicit decline, not
			// the terminal refusal).
			await fire("session_shutdown", ctx);
			await fire("session_start", ctx);
			hangDialog = false;
			const fresh = await runTool("kb_write", params, ctx);
			expect(fresh.details.status).toBe("refused");
			expect(fresh.details.message).toContain("declined by the user");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("read + write toolset wiring", () => {
	it("registers the kb tools as active-by-default tools (read + write toolsets)", () => {
		const { pi, tools } = fakePi();
		register(pi, deps());
		expect(tools.map((t) => t.name)).toEqual([
			"kb_query",
			"kb_search",
			"kb_read",
			"kb_write",
		]);
	});

	it("bare /kb prints both toolset-state lines", async () => {
		const { pi, fire, runCommand } = fakePi();
		register(pi, deps());
		const { ctx, notifications } = fakeCtx();
		await fire("session_start", ctx);
		await runCommand("", ctx);
		const printed = notifications.at(-1)?.[0] ?? "";
		expect(printed).toContain(
			"read toolset (kb_query, kb_search, kb_read): on",
		);
		expect(printed).toContain("write toolset (kb_write): on");
	});

	it("/kb tools write targets read+write (cascade); /kb tools read lands read-only; /kb tools off masks both", async () => {
		const { pi, fire, runCommand } = fakePi();
		register(pi, deps());
		const { ctx, notifications, statuses } = fakeCtx();
		await fire("session_start", ctx);
		await runCommand("tools write", ctx);
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
			"kb_write",
		]);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
		await runCommand("tools read", ctx);
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
		]);
		expect(notifications.at(-1)?.[0]).toContain("read-only");
		await runCommand("tools off", ctx);
		expect(pi.getActiveTools()).toEqual([]);
		expect(statuses.at(-1)?.[1]).toBe("○ kb: dev");
		await runCommand("tools write", ctx);
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
			"kb_write",
		]);
	});

	it("a masked read toolset turns the healthy slot hollow and prints the absence", async () => {
		const { pi, fire, runCommand } = fakePi();
		register(pi, deps());
		const { ctx, statuses, notifications } = fakeCtx();
		await fire("session_start", ctx);
		// Any disabler (toolsetDefaults pin, allowlist mode, external manager)
		// shows up as removed active tools (glyph reads live state).
		pi.setActiveTools([]);
		await fire("session_tree", ctx);
		expect(statuses.at(-1)?.[1]).toBe("○ kb: dev");
		await runCommand("", ctx);
		expect(notifications.at(-1)?.[0]).toContain(
			"read toolset (kb_query, kb_search, kb_read): off",
		);
	});

	it("TOOLSET_EVENTS repaint the status slot without a ctx-bearing trigger", async () => {
		const { pi, fire, emitEvent } = fakePi();
		register(pi, deps());
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
		// External masking (allowlist mode, toolsetDefaults) fires the event
		// with no ctx — the repaint must reuse the last render's ctx.
		pi.setActiveTools([]);
		await emitEvent(TOOLSET_EVENTS.changed);
		expect(statuses.at(-1)?.[1]).toBe("○ kb: dev");
		pi.setActiveTools(["kb_query", "kb_search", "kb_read", "kb_write"]);
		await emitEvent(TOOLSET_EVENTS.restored);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
	});
});
