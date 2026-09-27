import { homedir } from "node:os";
import { join } from "node:path";

// Offline shape validation of the `gnubrain` settings entry —
// no network, no kernel calls (the probe and notebook listing come later).
// project-vs-global split: `kbs` + connection keys + interaction dials are
// global-only; the project file supplies `defaultKBs` names only.

/** Layout of the extension's two settings files — single source of truth so
 * test harnesses (in-memory `readFile` mocks, temp-HOME seeding) key off the
 * same builders instead of copying the path strings. */
export function globalSettingsPath(homeDir?: string): string {
	return join(homeDir ?? homedir(), ".pi", "agent", "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

export interface KbEntry {
	name: string;
	notebook: string;
}

export interface GnubrainSettings {
	baseUrl: string;
	apiToken: string;
	kbs: KbEntry[];
	defaultKBs?: string[] | undefined;
	allowUnattendedWrites?: boolean | undefined;
	writeConfirmTimeout?: number | undefined;
}

export type ValidationResult =
	| { ok: true; settings: GnubrainSettings }
	| { ok: false; errors: string[] };

// reserved KB names — `all` is the set-wide toggle form, `tools` is the
// toolset dispatcher (/kb tools [read|write|off]), and `kbs` is the kb_read
// discovery name (kb: "kbs" lists the active set). A KB can never take any
// of these names. (`writes` was un-reserved when its verb moved under `tools`.)
const RESERVED_KB_NAMES = new Set(["all", "tools", "kbs"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	// Leading/trailing whitespace is rejected, not trimmed away, so the stored
	// value always matches what was validated (baseUrl/token/notebook are used
	// verbatim downstream).
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		value === value.trim()
	);
}

function checkName(name: string, errors: string[]): void {
	if (RESERVED_KB_NAMES.has(name)) {
		errors.push(`KB name '${name}' is reserved`);
	}
	if (/\s/.test(name) || name.includes("/")) {
		errors.push(`KB name '${name}' must not contain whitespace or /`);
	}
}

// Shared by both validators — one home for the rule and its message, so
// the global and project wordings can't drift apart. Absent is fine; a
// wrong shape is the only error here. Unknown names are not an error:
// scope resolution in validation.ts warns and drops them, whatever file
// supplied them.
function checkDefaultKBs(
	value: unknown,
	errors: string[],
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every((n) => typeof n === "string")) {
		errors.push("defaultKBs must be an array of KB name strings");
		return undefined;
	}
	return value;
}

// A project settings.json needs no `gnubrain` key at all (other extensions
// share the file); when present, only `defaultKBs` may live under it.
export interface ProjectValidation {
	/** Non-empty = shape failure → the session degrades. */
	errors: string[];
	defaultKBs: string[] | undefined;
}

export function validateProjectSettings(raw: unknown): ProjectValidation {
	if (!isRecord(raw)) {
		return {
			errors: ["project settings file must contain a JSON object"],
			defaultKBs: undefined,
		};
	}
	const config = raw["gnubrain"];
	if (config === undefined) {
		return { errors: [], defaultKBs: undefined };
	}
	if (!isRecord(config)) {
		return {
			errors: ["project gnubrain must be an object"],
			defaultKBs: undefined,
		};
	}
	const errors: string[] = [];
	for (const key of Object.keys(config)) {
		if (key !== "defaultKBs") {
			errors.push(
				`project gnubrain settings only support 'defaultKBs'; unexpected key '${key}'`,
			);
		}
	}
	const defaultKBs = checkDefaultKBs(config.defaultKBs, errors);
	return { errors, defaultKBs };
}

export interface LoadedSettings {
	global: ValidationResult;
	project: ProjectValidation;
}

/**
 * read path — injectable file read (unit tests mock it; the integration
 * suite injects fixture settings in memory through the same seam). The global
 * file carries everything; a missing global file is a shape failure. A missing
 * project file is simply "no project settings".
 */
export async function loadGnubrainSettings(
	readFile: (path: string) => Promise<string>,
	globalPath: string,
	projectPath: string | undefined,
): Promise<LoadedSettings> {
	const read = async (
		path: string,
	): Promise<{ found: boolean; raw: string } | { found: false }> => {
		try {
			return { found: true, raw: await readFile(path) };
		} catch (err) {
			if (
				err instanceof Error &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "ENOENT"
			) {
				return { found: false };
			}
			throw err;
		}
	};

	let global: ValidationResult;
	const globalFile = await read(globalPath);
	if (!globalFile.found) {
		global = {
			ok: false,
			errors: [`global settings file not found: ${globalPath}`],
		};
	} else {
		try {
			global = validateGnubrainSettings(JSON.parse(globalFile.raw));
		} catch {
			global = {
				ok: false,
				errors: [`global settings file is not valid JSON: ${globalPath}`],
			};
		}
	}

	let project: ProjectValidation = { errors: [], defaultKBs: undefined };
	if (projectPath !== undefined) {
		const projectFile = await read(projectPath);
		if (projectFile.found) {
			try {
				project = validateProjectSettings(JSON.parse(projectFile.raw));
			} catch {
				project = {
					errors: [`project settings file is not valid JSON: ${projectPath}`],
					defaultKBs: undefined,
				};
			}
		}
	}
	return { global, project };
}

export function validateGnubrainSettings(raw: unknown): ValidationResult {
	if (!isRecord(raw) || !isRecord(raw["gnubrain"])) {
		return {
			ok: false,
			errors: ["settings.json must contain a 'gnubrain' object"],
		};
	}
	const config = raw["gnubrain"];
	const errors: string[] = [];

	if (!isNonEmptyString(config.baseUrl)) {
		errors.push("baseUrl is required and must be a non-empty string");
	}
	if (!isNonEmptyString(config.apiToken)) {
		errors.push("apiToken is required and must be a non-empty string");
	}

	const names = new Set<string>();
	if (Array.isArray(config.kbs)) {
		config.kbs.forEach((entry, i) => {
			if (!isRecord(entry)) {
				errors.push(`kbs[${i}] must be an object with 'name' and 'notebook'`);
				return;
			}
			if (isNonEmptyString(entry.name)) {
				if (names.has(entry.name)) {
					errors.push(`duplicate KB name '${entry.name}'`);
				}
				names.add(entry.name);
				checkName(entry.name, errors);
			} else {
				errors.push(`kbs[${i}].name must be a non-empty string`);
			}
			if (!isNonEmptyString(entry.notebook)) {
				errors.push(`kbs[${i}].notebook must be a non-empty string`);
			}
		});
	} else {
		errors.push("kbs is required and must be an array");
	}

	const defaultKBs = checkDefaultKBs(config.defaultKBs, errors);

	if (
		config.allowUnattendedWrites !== undefined &&
		typeof config.allowUnattendedWrites !== "boolean"
	) {
		errors.push("allowUnattendedWrites must be a boolean");
	}
	if (
		config.writeConfirmTimeout !== undefined &&
		(typeof config.writeConfirmTimeout !== "number" ||
			!Number.isInteger(config.writeConfirmTimeout) ||
			config.writeConfirmTimeout < 0)
	) {
		errors.push(
			"writeConfirmTimeout must be a non-negative number (seconds, 0 = wait indefinitely)",
		);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}
	return {
		ok: true,
		settings: {
			baseUrl: config.baseUrl as string,
			apiToken: config.apiToken as string,
			kbs: config.kbs as KbEntry[],
			defaultKBs,
			allowUnattendedWrites: config.allowUnattendedWrites as
				| boolean
				| undefined,
			writeConfirmTimeout: config.writeConfirmTimeout as number | undefined,
		},
	};
}
