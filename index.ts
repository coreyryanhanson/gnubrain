import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

// Sprint 1 chassis: the machinery every kb tool call routes through —
// validation, scope resolution, breaker/cooldown gate, status slot. Sprint 2
// adds the /kb command (scope toggles + recovery) on the same register(pi,
// deps) seam; tools arrive in Sprint 3.

const STATUS_KEY = "kb";

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

	const statusInput = (
		validation: SessionValidation | undefined,
	): KbStatusInput => ({
		probe: validation?.probe ?? "never-probed",
		shapeErrors: validation?.shapeErrors ?? [],
		breakerTripped: breaker.tripped,
		scope: validation?.scope ?? [],
		// Sprint 1: no toolsets registered yet — hollow. Sprints 3/5 wire the
		// live read/write toolset state into these flags.
		readsEnabled: false,
		writesEnabled: false,
	});

	function renderStatus(ctx: ExtensionContext) {
		try {
			ctx.ui.setStatus(
				STATUS_KEY,
				renderKbStatus(statusInput(validation), ctx.ui.theme),
			);
		} catch {
			// Headless / no UI — the slot is best-effort by design (§5).
		}
	}

	/** The full validation pass — shared by session_start and /kb recovery
	 * (§5: every /kb dispatch re-runs it; corrected credentials and
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
		validation = await revalidate(ctx);
		// An auth failure on the first authenticated call feeds the breaker.
		if (validation.authFailed) breaker.recordAuthFailure();
		renderStatus(ctx);
	});

	// §5 /kb command (Sprint 2): every dispatch first re-runs the full
	// validation pass — success clears degradation + the breaker counter,
	// failure re-engages all-or-nothing — before the subcommand runs.
	pi.registerCommand("kb", {
		description:
			"Show or toggle active KBs (usage: /kb | /kb <name> on|off | /kb all on|off)",
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
				// The re-check's own auth failure feeds the breaker (§5 counting).
				breaker.recordAuthFailure();
			} else if (validation.lsNotebooksOk) {
				// Recovery succeeded: clears degradation + the breaker counter.
				// The 429 cooldown is deliberately untouched — it self-heals.
				breaker.reset();
			}
			const result = dispatchKbCommand(args, validation);
			if (result.newScope !== undefined) {
				// §5: a complete snapshot of the active set; latest entry wins.
				pi.appendEntry(KB_SCOPE_ENTRY_TYPE, { active: result.newScope });
				validation.scope = result.newScope;
			}
			renderStatus(ctx);
			ui.notify(result.message, result.severity);
		},
	});

	// Post-restore re-render (§5): the slot reflects the restored scope.
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
	});
}

export default function (pi: ExtensionAPI, deps: GnubrainDeps = {}) {
	register(pi, deps);
}
