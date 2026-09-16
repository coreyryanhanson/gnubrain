import { describe, expect, it, vi } from "vitest";
import { SiYuanAuthError } from "siyuan-kernel-api";
import { TOOLSET_EVENTS, getRegisteredToolsets } from "pi-tool-masking";
import register, { type GnubrainDeps } from "../../index.js";
import {
	createFakeCtx as fakeCtx,
	createFakePi as fakePi,
} from "../helpers/fakePi.js";
import { READ_TOOLSET_ID } from "../../tools.js";
import { WRITE_TOOLSET_ID, WRITE_TOOLSET_PERSIST_KEY } from "../../write.js";

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
		// Probe-only stub: these tests exercise validation paths, never a
		// write/read method, so the full WriteKernelClient shape is unexercised.
		createClient: () =>
			({
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
			}) as never,
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

	it("session_tree re-resolves scope from the active branch — an abandoned branch's toggle does not leak", async () => {
		const { pi, fire } = fakePi();
		register(pi, deps());
		// Branch A: no scope toggles → defaultKBs apply. Branch B: dev toggled
		// off (its snapshot lives only on B's path).
		const { ctx: ctxA, statuses: statusesA } = fakeCtx({ entries: [] });
		const { ctx: ctxB, statuses: statusesB } = fakeCtx({
			entries: [],
			branch: [
				{ type: "custom", customType: "kb-scope", data: { active: [] } },
			],
		});
		await fire("session_start", ctxB);
		expect(statusesB.at(-1)?.[1]).toBe("● kb: (none)");
		// /tree to branch A: defaultKBs apply again (no snapshot on A's path).
		await fire("session_tree", ctxA);
		expect(statusesA.at(-1)?.[1]).toBe("● kb: dev");
		// And back: the branch-scoped snapshot wins again on B.
		await fire("session_tree", ctxB);
		expect(statusesB.at(-1)?.[1]).toBe("● kb: (none)");
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

	// The write toolset is a single-tool, read-requiring toolset. The
	// settings tier applies toolsetDefaults pins per-toolset at restore
	// WITHOUT re-running the requires cascade — the documented reachable
	// write-without-read state. That restore behavior is pinned by
	// pi-tool-masking's own suite; what gnubrain owns is the spec shape
	// (asserted here) and the live-toggle cascade (the /kb tools verbs
	// below), plus the backstop record: masking is the outer layer, and
	// confirmation + headless default-deny remain in force on every write
	// regardless of how the toolset state was reached.
	it("the write toolset spec: single kb_write member, read-requiring, default-enabled, pinned persist key", () => {
		const { pi } = fakePi();
		register(pi, deps());
		const write = getRegisteredToolsets().find(
			(t) => t.spec.id === WRITE_TOOLSET_ID,
		);
		expect(write).toBeDefined();
		expect([...write!.spec.names]).toEqual(["kb_write"]);
		expect(write!.spec.requires).toEqual([READ_TOOLSET_ID]);
		expect(write!.spec.defaultEnabled).toBe(true);
		expect(write!.spec.persistKey).toBe(WRITE_TOOLSET_PERSIST_KEY);
	});

	it("a per-test pinnedVersion override refuses writes naming both versions; reads proceed", async () => {
		const { pi, fire, runTool } = fakePi();
		const d = deps({ version: "3.8.3" });
		register(pi, { ...d, pinnedVersion: "9.9.9" });
		const { ctx, statuses } = fakeCtx({
			hasUI: true,
			confirm: async () => true,
		});
		await fire("session_start", ctx);
		// The drift verdict drives the status cause tag; the write refusal
		// names the overridden pin alongside the kernel-reported version.
		expect(statuses.at(-1)?.[1]).toBe("● kb: version");
		const refused = (
			await runTool(
				"kb_write",
				{ kb: "dev", mode: "create", topic: "T", markdown: "b" },
				ctx,
			)
		).details;
		expect(refused.status).toBe("refused");
		expect(refused.message).toContain("3.8.3");
		expect(refused.message).toContain("9.9.9");

		// A drift session never blocks the kbs discovery short-circuit
		// (zero kernel calls) — writes refuse, reads answer.
		const read = (await runTool("kb_read", { kb: "kbs" }, ctx)).details;
		expect(read.status).toBe("ok");
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

	it("a TOOLSET_EVENT after session_shutdown does not repaint the cleared slot", async () => {
		const { pi, fire, emitEvent } = fakePi();
		register(pi, deps());
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
		await fire("session_shutdown", ctx);
		expect(statuses.at(-1)).toEqual(["kb", undefined]);
		// The closure lives on after shutdown; a toolset event from another
		// extension must not paint a stale "(none)" into the cleared slot.
		await emitEvent(TOOLSET_EVENTS.changed);
		expect(statuses.at(-1)).toEqual(["kb", undefined]);
	});
});
