// validation steps 2–3 and the scope read rule.
// Order is fixed: shape (settings.ts) → kernel probe → notebook existence.
// A shape failure degrades the session and skips the network steps; every
// later tool call is rejected with the problem named, never a crash.

import { SiYuanAuthError, type NotebookList } from "siyuan-kernel-api";
import type { GnubrainSettings, LoadedSettings } from "./settings.js";

export const PINNED_SIYUAN_VERSION = "3.8.3";

/** probe verdict, cached for the session. `never-probed` = the shape
 * check failed before the probe ran (a distinct state from unreachable). */
export type ProbeVerdict = "ok" | "drift" | "unreachable" | "never-probed";

/** Structural client subset the validation pipeline needs (tests stub it). */
export interface KernelProbeClient {
	/** Kernel origin without trailing slash (for unreachable-kernel messages). */
	readonly baseUrl: string;
	getVersion(): Promise<string>;
	listNotebooks(): Promise<NotebookList>;
}

export interface SessionValidation {
	/** undefined when shape validation failed. */
	settings: GnubrainSettings | undefined;
	/** Non-empty = degraded session: every tool call refused with the problem named. */
	shapeErrors: string[];
	probe: ProbeVerdict;
	kernelVersion: string | undefined;
	/** Post-validation KB name → notebook id (stale/encrypted dropped). */
	validKBs: Map<string, string>;
	/** Active scope names, all valid; empty = nothing active (never activate-all). */
	scope: string[];
	warnings: string[];
	/** A call-level auth failure on `lsNotebooks` — feeds the breaker. Network drops never set it. */
	authFailed: boolean;
	/** Whether the authenticated notebook listing itself succeeded — /kb
	 * recovery resets the breaker only on this (a successful authenticated
	 * call), not on a network-failed pass. */
	lsNotebooksOk: boolean;
}

/** scope persistence payload — a complete snapshot of the active set. */
export const KB_SCOPE_ENTRY_TYPE = "kb-scope";

/** Latest `kb-scope` entry wins; none → undefined (caller falls back to defaultKBs). */
export function latestPersistedScope(
	entries: { type: string; customType?: string; data?: unknown }[],
): string[] | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry === undefined) continue;
		if (entry.type === "custom" && entry.customType === KB_SCOPE_ENTRY_TYPE) {
			const data = entry.data as { active?: unknown } | undefined;
			if (Array.isArray(data?.active)) {
				return data.active.filter((n): n is string => typeof n === "string");
			}
			return [];
		}
	}
	return undefined;
}

/** Degraded all-or-nothing result: the config is unusable → no probe ran,
 * nothing valid, every tool call refused with the problems named. Shared by
 * the shape branch of runSessionValidation and a revalidate() that threw. */
export function degradedValidation(errors: string[]): SessionValidation {
	return {
		settings: undefined,
		shapeErrors: errors,
		probe: "never-probed",
		kernelVersion: undefined,
		validKBs: new Map(),
		scope: [],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: false,
	};
}

/**
 * The full startup validation pass. Also the `/kb` recovery hook's body:
 * re-running it re-reads settings and updates every cached verdict.
 */
export async function runSessionValidation(input: {
	loaded: LoadedSettings;
	kernel: KernelProbeClient;
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

	// Step 2 — kernel probe: unauthenticated, connectivity + version only.
	// Strict full-version match; drift fails writes closed, reads proceed.
	let probe: ProbeVerdict;
	let kernelVersion: string | undefined;
	try {
		kernelVersion = await input.kernel.getVersion();
		probe = kernelVersion === pinnedVersion ? "ok" : "drift";
	} catch {
		probe = "unreachable";
	}

	// Step 3 — notebook existence + encryption state. The first authenticated
	// call: an auth failure feeds the breaker; a network drop never counts.
	const validKBs = new Map<string, string>();
	try {
		const list: NotebookList = await input.kernel.listNotebooks();
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
			kernelVersion,
			validKBs,
			scope: [],
			warnings,
			authFailed: err instanceof SiYuanAuthError,
			lsNotebooksOk: false,
		};
	}

	// Scope resolution: persisted scope wins, else defaultKBs — the project
	// file's value when present, else the global one. Absent = empty set.
	const persisted = input.persistedScope;
	const configuredDefault = project.defaultKBs ?? settings.defaultKBs ?? [];
	const requested = persisted ?? configuredDefault;
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

	return {
		settings,
		shapeErrors,
		probe,
		kernelVersion,
		validKBs,
		scope,
		warnings,
		authFailed: false,
		lsNotebooksOk: true,
	};
}
