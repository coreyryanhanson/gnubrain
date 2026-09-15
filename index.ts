import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineToolset, TOOLSET_EVENTS, type Toolset } from "pi-tool-masking";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { CircuitBreaker } from "./breaker.js";
import { dispatchKbCommand } from "./kbCommand.js";
import { loadGnubrainSettings } from "./settings.js";
import { renderKbStatus, type KbStatusInput } from "./status.js";
import {
	KB_SCOPE_ENTRY_TYPE,
	latestPersistedScope,
	runSessionValidation,
	type KernelProbeClient,
	type SessionValidation,
} from "./validation.js";
import { registerReadToolsAndToolset, type KernelReadClient } from "./tools.js";
import { READ_TOOLSET_ID } from "./tools.js";
import { createWriteConfirmState } from "./writeConfirm.js";
import {
	createContentBaselines,
	type WriteKernelClient,
} from "./writeResult.js";
import {
	registerWriteTool,
	WRITE_TOOLSET_ID,
	WRITE_TOOLSET_PERSIST_KEY,
} from "./write.js";

// Chassis: the machinery every kb tool call routes through —
// validation, scope resolution, breaker/cooldown gate, status slot, the
// /kb command (scope toggles + recovery), the read tools (kb_query /
// kb_search / kb_read) and read toolset, kb_write (write confirmation
// gate + create flow), and the write toolset (requires the read toolset —
// live-toggle cascade), the /kb tools write verb, the fresh-content
// baselines, and the write-mode dispatch (writeModes.ts).
// All of it hangs off the same register(pi, deps) seam.

const STATUS_KEY = "kb";

/** Runtime deps the write tool adds to the register seam. */
export interface GnubrainDeps {
	/** Injectable file read — unit tests mock it; the integration suite injects fixture settings in memory through the same seam. */
	readFile?: (path: string) => Promise<string>;
	homeDir?: string;
	/** Test seam for the kernel client. */
	createClient?: (baseUrl: string, token: string) => KernelProbeClient;
}

function defaultReadFile(path: string): Promise<string> {
	return fsReadFile(path, "utf8");
}

export function register(pi: ExtensionAPI, deps: GnubrainDeps = {}) {
	const readFile = deps.readFile ?? defaultReadFile;
	const createClient =
		deps.createClient ??
		((baseUrl, token) => new SiYuanKernelClient(baseUrl, token));

	// Session-scoped state; "never-probed" until session_start validation runs.
	let validation: SessionValidation | undefined;
	const breaker = new CircuitBreaker();
	// Kernel client built from the freshest settings on every validation pass.
	let kernelClient: KernelProbeClient | undefined;

	// Read tools + toolset: the hooks read the live closure state,
	// so masking and post-toggle scope compose mid-session.
	const readToolset: Toolset = registerReadToolsAndToolset(pi, {
		getValidation: () => validation,
		getKernel: () => kernelClient as KernelReadClient | undefined,
		breaker,
	});

	// Write tool: rides the same gate + probe verdict. The confirm state is
	// session-scoped machinery, same lifecycle class as the breaker; the
	// fresh-content baselines ride the same lifecycle (decision record —
	// empty after resume/fork, the no-baseline fallback applies).
	const confirmState = createWriteConfirmState();
	const baselines = createContentBaselines();
	registerWriteTool(pi, {
		getValidation: () => validation,
		getKernel: () => kernelClient as WriteKernelClient | undefined,
		breaker,
		confirmState,
		baselines,
	});

	// Write toolset (tool-masking record): one tool, all mutation modes;
	// requires the read toolset — enabling writes cascades reads on,
	// disabling reads cascades writes off (live toggles only; the settings
	// tier applies pins per-toolset without the cascade — the documented
	// write-without-read boundary, backstopped by confirmation + headless
	// default-deny).
	const writeToolset: Toolset = defineToolset(pi, {
		id: WRITE_TOOLSET_ID,
		label: "GNUbrain KB writes",
		names: new Set(["kb_write"]),
		persistKey: WRITE_TOOLSET_PERSIST_KEY,
		defaultEnabled: true,
		requires: [READ_TOOLSET_ID],
	});

	const statusInput = (
		validation: SessionValidation | undefined,
	): KbStatusInput => ({
		probe: validation?.probe ?? "never-probed",
		shapeErrors: validation?.shapeErrors ?? [],
		breakerTripped: breaker.tripped,
		scope: validation?.scope ?? [],
		// Glyph state reads live toolset state — any disabler (our toggle,
		// toolsetDefaults pins, allowlist mode) is reflected.
		readsEnabled: readToolset.isEnabled(pi),
		writesEnabled: writeToolset.isEnabled(pi),
	});

	// Last ctx seen by a render — TOOLSET_EVENTS carry no ctx, so the glyph
	// repaints against it (/kb tools verbs recolor mid-session).
	let lastRenderCtx: ExtensionContext | undefined;

	function renderStatus(ctx: ExtensionContext) {
		lastRenderCtx = ctx;
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				renderKbStatus(statusInput(validation), ctx.ui.theme),
			);
		} catch {
			// Headless / no UI — the slot is best-effort by design.
		}
	}

	for (const event of [TOOLSET_EVENTS.changed, TOOLSET_EVENTS.restored]) {
		pi.events.on(event, () => {
			if (lastRenderCtx !== undefined) renderStatus(lastRenderCtx);
		});
	}

	/** The full validation pass — shared by session_start and /kb recovery
	 * every /kb dispatch re-runs it; corrected credentials and
	 * defaultKBs edits take effect mid-session). */
	async function revalidate(ctx: ExtensionContext): Promise<SessionValidation> {
		const loaded = await loadGnubrainSettings(
			readFile,
			join(deps.homeDir ?? homedir(), ".pi", "agent", "settings.json"),
			join(ctx.cwd, ".pi", "settings.json"),
		);
		const kernel =
			loaded.global.ok && loaded.global.settings
				? createClient(
						loaded.global.settings.baseUrl,
						loaded.global.settings.apiToken,
					)
				: undefined;
		if (kernel !== undefined) kernelClient = kernel;
		// A kernel stub is only needed past shape validation; when the shape
		// failed the pipeline skips the network steps regardless.
		const persisted = latestPersistedScope(ctx.sessionManager.getEntries());
		return runSessionValidation({
			loaded,
			kernel:
				kernel ??
				({
					baseUrl: "",
					getVersion: () => Promise.reject(new Error("no settings")),
					listNotebooks: () => Promise.reject(new Error("no settings")),
				} satisfies KernelProbeClient),
			persistedScope: persisted,
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// The breaker counts per session; a new session in this process must
		// not inherit a partial or tipped count from the previous one. The 429
		// cooldown is deliberately untouched — wall-clock and self-healing.
		breaker.reset();
		// Same lifecycle class: a confirm_timeout is terminal "in this session"
		// and baselines are session-scoped — neither may leak across a new
		// session in the same process.
		confirmState.timedOut.clear();
		baselines.clear();
		validation = await revalidate(ctx);
		// An auth failure on the first authenticated call feeds the breaker.
		if (validation.authFailed) breaker.recordAuthFailure();
		renderStatus(ctx);
	});

	// /kb command: every dispatch first re-runs the full
	// validation pass — success clears degradation + the breaker counter,
	// failure re-engages all-or-nothing — before the subcommand runs.
	pi.registerCommand("kb", {
		description:
			"Show or toggle active KBs and kb tools (usage: /kb | /kb <name> on|off | /kb all on|off | /kb tools [read|write|off])",
		handler: async (args, ctx) => {
			const ui = ctx.ui;
			try {
				validation = await revalidate(ctx);
			} catch (err) {
				ui.notify(
					`/kb re-validation failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				renderStatus(ctx);
				return;
			}
			if (validation.authFailed) {
				// The re-check's own auth failure feeds the breaker (counting).
				breaker.recordAuthFailure();
			} else if (validation.lsNotebooksOk) {
				// Recovery succeeded: clears degradation + the breaker counter.
				// The 429 cooldown is deliberately untouched — it self-heals.
				breaker.reset();
			}
			const result = dispatchKbCommand(
				args,
				validation,
				[
					// Bare `/kb` toolset-state lines (tool-masking record): a masked
					// toolset is printed, never silent.
					`read toolset (kb_query, kb_search, kb_read): ${
						readToolset.isEnabled(pi)
							? "on"
							: "off — masked (toggle, settings pin, or external manager)"
					}`,
					`write toolset (kb_write): ${
						writeToolset.isEnabled(pi)
							? "on"
							: "off — masked (toggle, settings pin, or external manager)"
					}`,
				],
				// The /kb tools verbs are state setters over the live toolset state.
				readToolset.isEnabled(pi),
				writeToolset.isEnabled(pi),
			);
			if (result.newScope !== undefined) {
				// A complete snapshot of the active set; latest entry wins.
				pi.appendEntry(KB_SCOPE_ENTRY_TYPE, { active: result.newScope });
				validation.scope = result.newScope;
			}
			if (result.newReadsEnabled !== undefined) {
				if (result.newReadsEnabled) {
					readToolset.enable(pi);
				} else {
					readToolset.disable(pi); // cascades write off (requires)
				}
			}
			if (result.newWritesEnabled !== undefined) {
				if (result.newWritesEnabled) {
					writeToolset.enable(pi); // cascades reads on (requires)
				} else {
					writeToolset.disable(pi);
				}
			}
			renderStatus(ctx);
			ui.notify(result.message, result.severity);
		},
	});

	// Post-restore re-render: the slot reflects the restored scope.
	pi.on("session_tree", (_event, ctx) => {
		renderStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Headless — nothing to clear.
		}
		validation = undefined;
		kernelClient = undefined;
		confirmState.timedOut.clear();
		baselines.clear();
	});
}

export default function (pi: ExtensionAPI, deps: GnubrainDeps = {}) {
	register(pi, deps);
}
