// validation steps 2–3 and the scope read rule.
// Order is fixed: shape (settings.ts) → kernel probe → notebook existence.
// A shape failure degrades the session and skips the network steps; every
// later tool call is rejected with the problem named, never a crash.

import {
	PINNED_SIYUAN_VERSION,
	SiYuanAuthError,
	probeKernel,
	type KernelProbeClient,
	type KernelProbeResult,
	type NotebookList,
} from "siyuan-kb-primitives";
import type { GnubrainSettings, LoadedSettings } from "./settings.js";

/** probe verdict, cached for the session. A discriminated union of objects:
 * the ok/drift members carry the observed kernel version (one home that
 * cannot disagree with the verdict); `never-probed` = the shape check
 * failed before the probe ran (a distinct state from unreachable); the two
 * session-lifecycle members are this pipeline's own states — the primitives
 * package never produces them. */
export type ProbeVerdict =
	| KernelProbeResult
	| { verdict: "unreachable" }
	| { verdict: "never-probed" };

export interface SessionValidation {
	/** undefined when shape validation failed. */
	settings: GnubrainSettings | undefined;
	/** Non-empty = degraded session: every tool call refused with the problem named. */
	shapeErrors: string[];
	probe: ProbeVerdict;
	/** Post-validation KB name → notebook id (stale/encrypted dropped). */
	validKBs: Map<string, string>;
	/** Active scope names, all valid; empty = nothing active (never activate-all). */
	scope: string[];
	/** The configured default (project defaultKBs over global) — retained so
	 * /tree navigation can re-resolve scope offline from the new branch. */
	defaultKBs: string[];
	warnings: string[];
	/** A call-level auth failure on `lsNotebooks` — feeds the breaker. Network drops never set it. */
	authFailed: boolean;
	/** Whether the authenticated notebook listing itself succeeded — /kb
	 * recovery resets the breaker only on this (a successful authenticated
	 * call), not on a network-failed pass. */
	lsNotebooksOk: boolean;
	/** The effective version pin (per-test override or module constant) —
	 * both gates resolve drift against this, never the module constant. */
	pinnedVersion?: string;
	/** Set when validation was skipped because the 429 cooldown was armed —
	 * kb-name refusals must name the skip, not "stale or encrypted". */
	skippedDueToRateLimit?: boolean;
}

/** scope persistence payload — a complete snapshot of the active set. */
export const KB_SCOPE_ENTRY_TYPE = "kb-scope";

/** Latest `kb-scope` entry wins; none → undefined (caller falls back to defaultKBs). */
export function latestPersistedScope(
	entries: { type: string; customType?: string; data?: unknown }[],
): string[] | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "custom" && entry.customType === KB_SCOPE_ENTRY_TYPE) {
			const data = entry.data as { active?: unknown } | undefined;
			if (Array.isArray(data?.active)) {
				return data.active.filter((n): n is string => typeof n === "string");
			}
			return [];
		}
	}
	return undefined;
}

/** Scope filter shared by startup validation and /tree re-resolution:
 * warn-and-drop unknown names (no global-default fallback — stale-notebook
 * precedent), warn-and-drop stale/encrypted names, keep valid siblings. */
export function resolveValidatedScope(
	requested: readonly string[],
	settings: GnubrainSettings,
	validKBs: Map<string, string>,
	warnings: string[],
): string[] {
	const scope: string[] = [];
	for (const name of requested) {
		if (!settings.kbs.some((kb) => kb.name === name)) {
			// Project-file unknown names: warn and drop, keep valid siblings;
			// never fall back to the global default (stale-notebook precedent).
			warnings.push(`KB '${name}' is not configured — dropped from scope`);
		} else if (!validKBs.has(name)) {
			warnings.push(
				`KB '${name}' is not in the valid set (stale or encrypted notebook) — dropped from scope`,
			);
		} else {
			scope.push(name);
		}
	}
	return scope;
}

/** Degraded all-or-nothing result: the config is unusable → no probe ran,
 * nothing valid, every tool call refused with the problems named. Shared by
 * runSessionValidation's fail-closed branches and a revalidate() that threw. */
export function degradedValidation(errors: string[]): SessionValidation {
	return {
		settings: undefined,
		shapeErrors: errors,
		probe: { verdict: "never-probed" },
		pinnedVersion: PINNED_SIYUAN_VERSION,
		validKBs: new Map(),
		scope: [],
		defaultKBs: [],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: false,
	};
}

/** Rate-limited session: settings parsed, but the kernel is inside a 429 lock
 * the extension must not extend — validation skipped both kernel calls. Shape
 * errors stay empty so tool calls reach the gate's cooldown refusal (deadline
 * + Retry-After) instead of a config-degraded refusal; `/kb` re-validates for
 * real once the cooldown expires. Config problems still win: a broken settings
 * file degrades exactly as it would without a lock. */
export function rateLimitedValidation(input: {
	loaded: LoadedSettings;
	pinnedVersion?: string;
}): SessionValidation {
	const { global, project } = input.loaded;
	const shapeErrors = [...(global.ok ? [] : global.errors), ...project.errors];
	const settings = global.ok ? global.settings : undefined;
	if (shapeErrors.length > 0 || settings === undefined)
		return degradedValidation(shapeErrors);
	return {
		settings,
		shapeErrors: [],
		// Not "never-probed" (that name means the shape gate stopped us) and no
		// probe ran — "unreachable" is the honest verdict: the kernel cannot
		// serve this session right now, and a write attempt may re-probe it.
		probe: { verdict: "unreachable" },
		pinnedVersion: input.pinnedVersion ?? PINNED_SIYUAN_VERSION,
		validKBs: new Map(),
		scope: [],
		defaultKBs: project.defaultKBs ?? settings.defaultKBs ?? [],
		warnings: [
			"kernel is rate-limited (429 cooldown) — validation skipped so the lock is not extended; run /kb after the cooldown expires to re-validate",
		],
		authFailed: false,
		lsNotebooksOk: false,
		skippedDueToRateLimit: true,
	};
}

/**
 * The full startup validation pass. Also the `/kb` recovery hook's body:
 * re-running it re-reads settings and updates every cached verdict.
 */
export async function runSessionValidation(input: {
	loaded: LoadedSettings;
	/** A client exists iff the global settings parsed — undefined means they
	 * didn't, which the shape gate below refuses before the kernel is touched. */
	kernel: KernelProbeClient | undefined;
	/** The version-refusal pin overrides this per-test. */
	pinnedVersion?: string;
	/** Latest persisted `kb-scope` snapshot, when the session carries one. */
	persistedScope?: string[] | undefined;
}): Promise<SessionValidation> {
	const pinnedVersion = input.pinnedVersion ?? PINNED_SIYUAN_VERSION;
	const warnings: string[] = [];
	const { global, project } = input.loaded;

	// Step 1 — shape. The global file runs the full validator; the project
	// file supplies defaultKBs names only (settings.ts). Either failing degrades.
	const shapeErrors = [...(global.ok ? [] : global.errors), ...project.errors];
	const settings = global.ok ? global.settings : undefined;
	if (shapeErrors.length > 0 || settings === undefined) {
		// No probe ran — the connection settings are unusable. The status slot
		// shows the config cause, not an unreachable kernel.
		return degradedValidation(shapeErrors);
	}

	if (input.kernel === undefined) {
		// Unreachable: a parsed global settings file always yields a client.
		return degradedValidation(["validation ran without a kernel client"]);
	}
	const kernel = input.kernel;

	// Step 2 — kernel probe: unauthenticated, connectivity + version only.
	// Strict full-version match; drift fails writes closed, reads proceed.
	// The comparison lives in the pin-owning package (probeKernel); this
	// caller owns its own swallow policy — a failed probe is "unreachable".
	let probe: ProbeVerdict;
	try {
		probe = await probeKernel(kernel, pinnedVersion);
	} catch {
		probe = { verdict: "unreachable" };
	}

	// Step 3 — notebook existence + encryption state. The first authenticated
	// call: an auth failure feeds the breaker; a network drop never counts.
	// The configured default (project defaultKBs over global) is retained on
	// every result so /tree navigation can re-resolve scope offline.
	const configuredDefault = project.defaultKBs ?? settings.defaultKBs ?? [];
	const validKBs = new Map<string, string>();
	try {
		const list: NotebookList = await kernel.listNotebooks();
		const byId = new Map(list.notebooks.map((n) => [n.id, n]));
		for (const kb of settings.kbs) {
			const notebook = byId.get(kb.notebook);
			if (notebook === undefined) {
				warnings.push(
					`KB '${kb.name}' notebook ${kb.notebook} not found on the kernel — dropped from the valid set`,
				);
			} else if (notebook.encrypted) {
				// One rejection for both lock states: `encrypted` is always present
				// in lsNotebooks output regardless of lock state.
				warnings.push(
					`KB '${kb.name}' uses an encrypted notebook — rejected at startup (the SQL surface cannot see encrypted boxes)`,
				);
			} else {
				validKBs.set(kb.name, kb.notebook);
			}
		}
	} catch (err) {
		// Fail-closed: the valid set stays empty; every tool call's `kb` name is
		// rejected as not-in-scope until /kb recovery re-runs validation.
		validKBs.clear();
		warnings.push(
			`lsNotebooks failed (${err instanceof Error ? err.message : String(err)}) — no KBs are valid until /kb re-validates`,
		);
		return {
			settings,
			shapeErrors,
			probe,
			pinnedVersion,
			validKBs,
			scope: [],
			defaultKBs: configuredDefault,
			warnings,
			authFailed: err instanceof SiYuanAuthError,
			lsNotebooksOk: false,
		};
	}

	// Scope resolution: persisted scope wins, else the configured default.
	const scope = resolveValidatedScope(
		input.persistedScope ?? configuredDefault,
		settings,
		validKBs,
		warnings,
	);

	return {
		settings,
		shapeErrors,
		probe,
		pinnedVersion,
		validKBs,
		scope,
		defaultKBs: configuredDefault,
		warnings,
		authFailed: false,
		lsNotebooksOk: true,
	};
}
