import { describe, expect, it, vi } from "vitest";
import {
	SiYuanAuthError,
	SiYuanRateLimitError,
	PINNED_SIYUAN_VERSION,
} from "siyuan-kb-primitives";
import { TOOLSET_EVENTS, getRegisteredToolsets } from "pi-tool-masking";
import register, { type GnubrainDeps } from "../../index.js";
import {
	createFakeCtx as fakeCtx,
	createFakePi as fakePi,
} from "../helpers/fakePi.js";
import { READ_TOOLSET_ID, WRITE_TOOLSET_ID } from "../../toolsetIds.js";
import { GRANT_SESSION, GRANT_YES } from "../../writeConfirm.js";

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
				getVersion: async () => options?.version ?? PINNED_SIYUAN_VERSION,
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

	it("/kb with a mid-session settings read error degrades instead of keeping the old verdict", async () => {
		const { pi, fire, runCommand } = fakePi();
		const base = deps();
		let readError: Error | undefined;
		register(pi, {
			...base,
			readFile: async (path: string) => {
				if (readError !== undefined) throw readError;
				return base.readFile!(path);
			},
		});
		const { ctx, statuses, notifications } = fakeCtx();
		await fire("session_start", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
		readError = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		statuses.length = 0;
		await runCommand("", ctx);
		// The degraded verdict must replace the previously healthy one — the
		// slot repaints config and bare /kb names the reason instead of
		// printing a scope the tools no longer serve.
		expect(statuses.at(-1)?.[1]).toBe("● kb: config");
		expect(notifications.at(-1)?.[0]).toContain(
			"settings load failed: permission denied",
		);
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

	/** A client whose listNotebooks rejects until cleared — the shared
	 * apiToken-failure fixture for the breaker-recovery tests. The override
	 * must be applied before register(): index.ts captures deps.createClient
	 * at registration time. */
	function authFailingDeps(): {
		d: ReturnType<typeof deps>;
		clearAuthError: () => void;
	} {
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
		return {
			d,
			clearAuthError: () => {
				authError = undefined;
			},
		};
	}

	it("a corrected apiToken takes effect on the next /kb dispatch", async () => {
		const { pi, fire, runCommand } = fakePi();
		const { d, clearAuthError } = authFailingDeps();
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		// Three consecutive dispatches under the bad token trip the breaker.
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: breaker");

		clearAuthError(); // the token is fixed
		await runCommand("all on", ctx);
		// The re-check cleared the breaker and the empty valid set.
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
	});

	it("a new session does not inherit a tipped breaker count", async () => {
		const { pi, fire, runCommand } = fakePi();
		const { d, clearAuthError } = authFailingDeps();
		register(pi, d);
		const { ctx, statuses } = fakeCtx();
		await fire("session_start", ctx);
		await runCommand("all on", ctx);
		await runCommand("all on", ctx);
		expect(statuses.at(-1)?.[1]).toBe("● kb: breaker");

		await fire("session_shutdown", ctx);
		clearAuthError(); // the token is fixed, but the closure lives on
		await fire("session_start", ctx);
		// The count restarted: a healthy re-check renders the healthy slot,
		// not the carried breaker tag.
		expect(statuses.at(-1)?.[1]).toBe("● kb: dev");
	});

	it("session_start during an armed 429 cooldown makes no kernel calls; /kb after expiry re-validates", async () => {
		vi.useFakeTimers();
		try {
			const { pi, fire, runCommand, runToolDetails } = fakePi();
			const d = deps();
			const base = d.createClient!;
			let locked = false;
			let versionCalls = 0;
			d.createClient = () => {
				const client = base("", "") as unknown as Record<string, unknown>;
				client.getVersion = () => {
					versionCalls++;
					return Promise.resolve(PINNED_SIYUAN_VERSION);
				};
				client.query = () => {
					if (locked) throw new SiYuanRateLimitError(429, 60);
					return Promise.resolve([]);
				};
				return client as never;
			};
			register(pi, d);
			const { ctx } = fakeCtx();
			await fire("session_start", ctx);
			expect(versionCalls).toBe(1);
			expect(d.notebooks()).toBe(1);

			// A 429 from a read arms the cooldown and refuses with the lockout.
			locked = true;
			const hit = await runToolDetails(
				"kb_query",
				{ kb: ["dev"], sql: "SELECT id FROM blocks" },
				ctx,
			);
			expect(hit.status).toBe("refused");
			expect(hit.message).toContain("rate-limit lockout");

			// While the lock is armed, a new session in this process skips both
			// validation probes — any kernel call would extend the lock.
			await fire("session_shutdown", ctx);
			await fire("session_start", ctx);
			expect(versionCalls).toBe(1);
			expect(d.notebooks()).toBe(1);

			// Tool calls in the rate-limited session refuse via the gate's
			// cooldown branch, not a config-degraded refusal.
			const cooled = await runToolDetails(
				"kb_query",
				{ kb: ["dev"], sql: "SELECT id FROM blocks" },
				ctx,
			);
			expect(cooled.status).toBe("refused");
			expect(cooled.message).toContain("rate-limit lockout");

			// After the lock expires, calls refuse with the rate-limit skip named
			// — never "stale or encrypted" — until /kb re-validates for real.
			locked = false;
			await vi.advanceTimersByTimeAsync(61_000);
			const afterLock = await runToolDetails(
				"kb_query",
				{ kb: ["dev"], sql: "SELECT id FROM blocks" },
				ctx,
			);
			expect(afterLock.status).toBe("refused");
			expect(afterLock.message).toContain("validation was skipped");
			expect(afterLock.message).not.toContain("stale or encrypted");

			await runCommand("all on", ctx);
			expect(versionCalls).toBe(2);
			expect(d.notebooks()).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a terminal write denial does not survive a session restart — the re-request gets a fresh dialog", async () => {
		const settings = JSON.stringify({
			gnubrain: {
				baseUrl: "http://127.0.0.1:6806",
				apiToken: "token",
				kbs: [{ name: "dev", notebook: "nb-1" }],
				defaultKBs: ["dev"],
			},
		});
		const { pi, fire, runTool } = fakePi();
		const d = deps({ global: settings });
		const base = d.createClient!;
		d.createClient = () =>
			({ ...base("", ""), query: async () => [] }) as never;
		register(pi, d);
		// First dialog answers undefined — pi's native timeout/ESC dismissal,
		// indistinguishable from an abort and terminal under one arm.
		let selectCalls = 0;
		let answer: string | undefined = undefined;
		const { ctx } = fakeCtx({
			hasUI: true,
			select: async () => {
				selectCalls++;
				return answer;
			},
		});
		await fire("session_start", ctx);
		const params = { kb: "dev", mode: "create", topic: "T", markdown: "b" };
		const first = await runTool("kb_write", params, ctx);
		expect(first.details.status).toBe("refused");
		expect(first.details.reason).toBe("write_denied");

		// Same session: the refusal is terminal — no new dialog.
		const retried = await runTool("kb_write", params, ctx);
		expect(retried.details.reason).toBe("write_denied");
		expect(selectCalls).toBe(1);

		// New session in the same process: the denial is forgotten — the
		// re-request reaches a fresh dialog, and a Yes lets the write proceed
		// past the grant gate (the stub's empty kernel fails it later — the
		// point here is that it is no longer the terminal refusal).
		await fire("session_shutdown", ctx);
		await fire("session_start", ctx);
		answer = "Yes";
		const fresh = await runTool("kb_write", params, ctx);
		expect(selectCalls).toBe(2);
		expect(fresh.details.message).not.toContain("no write grant");
	});

	it("agent_settled re-arms the interaction boundary — a Yes re-prompts, 'Always this session' survives", async () => {
		const setup = async (answer: string) => {
			const { pi, fire, runTool } = fakePi();
			const d = deps();
			const base = d.createClient!;
			d.createClient = () =>
				({ ...base("", ""), query: async () => [] }) as never;
			register(pi, d);
			let selectCalls = 0;
			const { ctx } = fakeCtx({
				hasUI: true,
				select: async () => {
					selectCalls++;
					return answer;
				},
			});
			await fire("session_start", ctx);
			const params = { kb: "dev", mode: "create", topic: "T", markdown: "b" };
			return { fire, runTool, ctx, params, selectCalls: () => selectCalls };
		};

		// A Yes is a turn grant: once the interaction settles, the next write
		// to the KB opens a fresh dialog instead of riding the spent approval.
		const turn = await setup(GRANT_YES);
		await turn.runTool("kb_write", turn.params, turn.ctx);
		expect(turn.selectCalls()).toBe(1);
		await turn.fire("agent_settled", turn.ctx);
		const next = await turn.runTool("kb_write", turn.params, turn.ctx);
		expect(turn.selectCalls()).toBe(2);
		expect(next.details.message).not.toContain("no write grant");

		// "Always this session" is not an interaction grant: the same settle
		// leaves it standing and no second dialog opens.
		const held = await setup(GRANT_SESSION);
		await held.runTool("kb_write", held.params, held.ctx);
		await held.fire("agent_settled", held.ctx);
		const still = await held.runTool("kb_write", held.params, held.ctx);
		expect(held.selectCalls()).toBe(1);
		expect(still.details.message).not.toContain("no write grant");
	});

	it("session_start clears session grants — 'Always this session' re-prompts in a new session", async () => {
		const { pi, fire, runTool } = fakePi();
		const d = deps();
		const base = d.createClient!;
		d.createClient = () =>
			({ ...base("", ""), query: async () => [] }) as never;
		register(pi, d);
		let selectCalls = 0;
		const { ctx } = fakeCtx({
			hasUI: true,
			select: async () => {
				selectCalls++;
				return GRANT_SESSION;
			},
		});
		await fire("session_start", ctx);
		const params = { kb: "dev", mode: "create", topic: "T", markdown: "b" };
		await runTool("kb_write", params, ctx);
		expect(selectCalls).toBe(1);

		// Same session: the session grant holds — no new dialog.
		await runTool("kb_write", params, ctx);
		expect(selectCalls).toBe(1);

		// New session in the same process: the session grant is forgotten —
		// session_start alone sweeps it (no shutdown fired in between).
		await fire("session_start", ctx);
		await runTool("kb_write", params, ctx);
		expect(selectCalls).toBe(2);
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
	// the grant gate + headless default-deny remain in force on every
	// write regardless of how the toolset state was reached.
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
		expect(write!.spec.persistKey).toBe("toolset-state:gnubrain.write");
	});

	it("a kernel-reported drift refuses writes naming both versions; reads proceed", async () => {
		const { pi, fire, runTool } = fakePi();
		// The probe stub reports a drifted version.
		register(pi, deps({ version: "9.9.9" }));
		const { ctx, statuses } = fakeCtx({
			hasUI: true,
			select: async () => "Yes",
		});
		await fire("session_start", ctx);
		// The drift verdict drives the status cause tag; the write refusal
		// names both versions.
		expect(statuses.at(-1)?.[1]).toBe("● kb: version");
		const refused = (
			await runTool(
				"kb_write",
				{ kb: "dev", mode: "create", topic: "T", markdown: "b" },
				ctx,
			)
		).details;
		expect(refused.status).toBe("refused");
		expect(refused.message).toContain(PINNED_SIYUAN_VERSION);
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
		// Masked ≠ refused: the off-lines are computed from live toolset
		// state, so an externally pinned toolset prints its absence too.
		await runCommand("", ctx);
		expect(notifications.at(-1)?.[0]).toContain(
			"read toolset (kb_query, kb_search, kb_read): off — masked",
		);
		expect(notifications.at(-1)?.[0]).toContain(
			"write toolset (kb_write): off — masked",
		);
		await runCommand("tools write", ctx);
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
			"kb_write",
		]);
	});

	it("/kb tools under allowlist governance renders the refusal and toggles nothing", async () => {
		const { pi, fire, runCommand } = fakePi();
		register(pi, deps());
		await fire("session_start", fakeCtx().ctx);
		// The governance mode lives on the branch; a hand-built mode entry is
		// the same shape pi-tool-masking's own appendEntry produces.
		const { ctx, notifications } = fakeCtx({
			branch: [
				{
					type: "custom",
					customType: "toolset-resolution-mode",
					data: {
						mode: "allowlist",
						allowlist: ["other.extension.tools"],
					},
				},
			],
		});
		await runCommand("tools read", ctx);
		expect(notifications.at(-1)?.[0]).toContain("allowlist governance");
		expect(notifications.at(-1)?.[1]).toBe("error");
		// Atomic refusal: the live set is untouched.
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
			"kb_write",
		]);
	});

	it("/kb tools in a deferring child no-ops and reports honestly", async () => {
		const { pi, fire, runCommand } = fakePi();
		register(pi, deps());
		const { ctx, notifications } = fakeCtx();
		await fire("session_start", ctx);
		// The library's defer signal is a per-process env pid tag; a value
		// other than this process's pid reads as a deferring child.
		process.env.PI_TOOLMASKING_DEFER = String(process.pid + 1);
		try {
			await runCommand("tools read", ctx);
		} finally {
			delete process.env.PI_TOOLMASKING_DEFER;
		}
		expect(notifications.at(-1)?.[0]).toContain("kb tools unchanged");
		expect(notifications.at(-1)?.[1]).toBe("warning");
		expect([...pi.getActiveTools()].sort()).toEqual([
			"kb_query",
			"kb_read",
			"kb_search",
			"kb_write",
		]);
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
