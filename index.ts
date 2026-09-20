import { readFile as fsReadFile } from "node:fs/promises";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineToolset, TOOLSET_EVENTS, type Toolset } from "pi-tool-masking";
import { SiYuanKernelClient } from "siyuan-kernel-api";
import { CircuitBreaker } from "./breaker.js";
import { dispatchKbCommand } from "./kbCommand.js";
import {
	globalSettingsPath,
	loadGnubrainSettings,
	projectSettingsPath,
} from "./settings.js";
import { renderKbStatus, type KbStatusInput } from "./status.js";
import {
	KB_SCOPE_ENTRY_TYPE,
	degradedValidation,
	latestPersistedScope,
	rateLimitedValidation,
	resolveValidatedScope,
	runSessionValidation,
	type SessionValidation,
} from "./validation.js";
import { READ_TOOLSET_ID, registerReadToolsAndToolset } from "./tools.js";
import { ContentBaselines } from "./baselines.js";
import {
	clearInteractionGrants,
	clearSessionGrants,
	createWriteGrantState,
} from "./writeConfirm.js";
import { type WriteKernelClient } from "./kernel.js";
import {
	registerWriteTool,
	WRITE_TOOLSET_ID,
	WRITE_TOOLSET_PERSIST_KEY,
} from "./write.js";

// Chassis: the machinery every kb tool call routes through —
// validation, scope resolution, breaker/cooldown gate, status slot, the
// /kb command (scope toggles + recovery), the read tools (kb_query /
// kb_search / kb_read) and read toolset, kb_write (per-KB write grant gate
// + create flow), and the write toolset (requires the read toolset —
// live-toggle cascade), the /kb tools write verb, the fresh-content
// baselines, and the write-mode dispatch (over the
// writeSchema/writeFlow/writeEdit/... files).
// All of it hangs off the same register(pi, deps) seam.

const STATUS_KEY = "kb";

/** Runtime deps the write tool adds to the register seam. */
export interface GnubrainDeps {
	/** Injectable file read — unit tests mock it; the integration suite injects
	 * fixture settings in memory through the same seam. Key mocks off
	 * globalSettingsPath/projectSettingsPath, and mind the two file shapes: the
	 * global file must carry the full `gnubrain` object (baseUrl/apiToken/kbs);
	 * a project file may omit `gnubrain` entirely or hold only
	 * `{gnubrain: {defaultKBs}}` — connection keys there fail shape validation
	 * and degrade the whole session. */
	readFile?: (path: string) => Promise<string>;
	homeDir?: string;
	/** Test seam for the kernel client. */
	createClient?: (baseUrl: string, token: string) => WriteKernelClient;
	/** Per-test version-pin override; absent → the module pin applies. */
	pinnedVersion?: string;
}

function defaultReadFile(path: string): Promise<string> {
	return fsReadFile(path, "utf8");
}

export default function register(pi: ExtensionAPI, deps: GnubrainDeps = {}) {
	const readFile = deps.readFile ?? defaultReadFile;
	const createClient =
		deps.createClient ??
		((baseUrl, token) => new SiYuanKernelClient(baseUrl, token));

	// Session-scoped state; "never-probed" until session_start validation runs.
	let validation: SessionValidation | undefined;
	const breaker = new CircuitBreaker();
	// Kernel client built from the freshest settings on every validation pass.
	let kernelClient: WriteKernelClient | undefined;
	// Session-scoped fresh-content baselines: the read tools feed it where
	// content is served, the write precondition checks against it (decision
	// record — empty after resume/fork, the no-baseline fallback applies).
	const baselines = ContentBaselines.create();

	// Read tools + toolset: the hooks read the live closure state,
	// so masking and post-toggle scope compose mid-session.
	const readToolset: Toolset = registerReadToolsAndToolset(pi, {
		getValidation: () => validation,
		getKernel: () => kernelClient,
		breaker,
		baselines,
	});

	// Write tool: rides the same gate + probe verdict. The grant state is
	// session-scoped machinery, same lifecycle class as the breaker.
	const grantState = createWriteGrantState();
	registerWriteTool(pi, {
		getValidation: () => validation,
		getKernel: () => kernelClient,
		breaker,
		grantState,
		baselines,
	});

	// Write toolset (tool-masking record): one tool, all mutation modes;
	// requires the read toolset — enabling writes cascades reads on,
	// disabling reads cascades writes off (live toggles only; the settings
	// tier applies pins per-toolset without the cascade — the documented
	// write-without-read boundary, backstopped by the per-KB write grant +
	// headless default-deny).
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
	 * (every /kb dispatch re-runs it; corrected credentials and defaultKBs
	 * edits take effect mid-session). Never throws: a settings read error
	 * (EACCES, EISDIR, ...) degrades here rather than in the callers, so the
	 * two stay mirrored by construction — a thrown error can never leave the
	 * previous verdict live. */
	async function revalidate(ctx: ExtensionContext): Promise<SessionValidation> {
		try {
			return await runRevalidate(ctx);
		} catch (err) {
			return degradedValidation([
				`settings load failed: ${err instanceof Error ? err.message : String(err)}`,
			]);
		}
	}

	async function runRevalidate(
		ctx: ExtensionContext,
	): Promise<SessionValidation> {
		const loaded = await loadGnubrainSettings(
			readFile,
			globalSettingsPath(deps.homeDir),
			projectSettingsPath(ctx.cwd),
		);
		// An armed 429 cooldown means the kernel refuses us per-IP and any call
		// extends the lock — including these two probes. Skip them: the session
		// comes up rate-limited, tools refuse locally via the gate, and /kb after
		// the cooldown re-validates for real. In-process only: restarting pi (or
		// the kernel) starts fresh by design — do not persist the deadline.
		if (breaker.inCooldown()) {
			return rateLimitedValidation({
				loaded,
				...(deps.pinnedVersion !== undefined && {
					pinnedVersion: deps.pinnedVersion,
				}),
			});
		}
		const kernel =
			loaded.global.ok && loaded.global.settings
				? createClient(
						loaded.global.settings.baseUrl,
						loaded.global.settings.apiToken,
					)
				: undefined;
		if (kernel !== undefined) kernelClient = kernel;
		// Branch-scoped read: only the active branch's scope snapshot counts —
		// a scope toggle on an abandoned branch must not leak back in.
		const persisted = latestPersistedScope(ctx.sessionManager.getBranch());
		return runSessionValidation({
			loaded,
			kernel,
			persistedScope: persisted,
			...(deps.pinnedVersion !== undefined && {
				pinnedVersion: deps.pinnedVersion,
			}),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// The breaker counts per session; a new session in this process must
		// not inherit a partial or tipped count from the previous one. The 429
		// cooldown is deliberately untouched — wall-clock and self-healing.
		breaker.reset();
		// Same lifecycle: a shape-failed revalidate builds no client, so the
		// previous session's client must not linger in the closure.
		kernelClient = undefined;
		// Same lifecycle class: grants and denials are terminal within their
		// scope and baselines are session-scoped — none may leak across a new
		// session in the same process (session grants are the only ones that
		// need this hook, but all three sets are swept: a stale denial must
		// not survive a session replacement).
		clearSessionGrants(grantState);
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
			// revalidate degrades rather than throwing, so a failed re-check
			// re-engages all-or-nothing right here.
			validation = await revalidate(ctx);
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

	// /tree navigation: the active branch changed, so branch-derived state
	// must be re-derived from the new branch — nothing else is re-probed
	// (settings/kernel state is navigation-invariant; /new, /resume and /fork
	// all fire session_start, which re-runs the full pipeline).
	pi.on("session_tree", (_event, ctx) => {
		const v = validation;
		if (v !== undefined && v.settings !== undefined) {
			// Offline re-resolution against the cached valid set: no kernel
			// probe (the status slot reflects the result).
			const persisted = latestPersistedScope(ctx.sessionManager.getBranch());
			// A scratch warning sink: bare /kb renders only the session's own
			// warnings, and appending per navigation would accumulate here; the
			// drop decisions are already reflected in the resulting scope (the
			// slot shows it).
			v.scope = resolveValidatedScope(
				persisted ?? v.defaultKBs,
				v.settings,
				v.validKBs,
				[],
			);
		}
		// A different branch is a different conversation history: served-content
		// baselines from the old branch must not verify writes on this one.
		baselines.clear();
		renderStatus(ctx);
	});

	// Interaction boundary: turn grants and the turn-denial set clear once
	// nothing is left in this interaction (no retry, compaction, or queued
	// follow-up pending) — the dialog re-arms for the next message. Session
	// grants survive. agent_settled, not agent_end: the latter fires per
	// low-level run, and clearing there would re-prompt mid-conversation
	// when a retry or follow-up continues the same interaction.
	pi.on("agent_settled", () => {
		clearInteractionGrants(grantState);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Headless — nothing to clear.
		}
		validation = undefined;
		kernelClient = undefined;
		// A later toolset event must not repaint the cleared slot against a
		// dead ctx — drop the render anchor with the session.
		lastRenderCtx = undefined;
		clearSessionGrants(grantState);
		baselines.clear();
	});
}
