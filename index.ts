import { readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { CircuitBreaker } from "./breaker.js";
import { loadGnubrainSettings } from "./settings.js";
import { renderKbStatus, type KbStatusInput } from "./status.js";
import {
	latestPersistedScope,
	runSessionValidation,
	type KernelProbeClient,
	type SessionValidation,
} from "./validation.js";

// Sprint 1 chassis: the machinery every kb tool call routes through —
// validation, scope resolution, breaker/cooldown gate, status slot. No tools
// are registered yet (Sprint 3) and no /kb command (Sprint 2); both extend
// this single register(pi, deps) seam.

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

	pi.on("session_start", async (_event, ctx) => {
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
		validation = await runSessionValidation({
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
		// An auth failure on the first authenticated call feeds the breaker.
		if (validation.authFailed) breaker.recordAuthFailure();
		renderStatus(ctx);
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
