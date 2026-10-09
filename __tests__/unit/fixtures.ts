// Shared SessionValidation fixture for the unit tests. One canonical shape:
// recipes + projects configured and valid, scope = [recipes]. Overrides
// replace, they do not merge; names configured but absent from validKBs
// simulate stale/encrypted notebooks.
import { PINNED_SIYUAN_VERSION } from "siyuan-kb-primitives";
import type { SessionValidation } from "../../validation.js";

export function validation(overrides?: {
	scope?: string[];
	validKBs?: [string, string][];
	kbs?: { name: string; notebook: string }[];
	shapeErrors?: string[];
	warnings?: string[];
	probe?: SessionValidation["probe"];
	/** Extra/overriding settings fields (timeouts, unattended writes, ...). */
	settings?: Partial<SessionValidation["settings"]>;
}): SessionValidation {
	const kbs = overrides?.kbs ?? [
		{ name: "recipes", notebook: "nb-r" },
		{ name: "projects", notebook: "nb-p" },
	];
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs,
			...overrides?.settings,
		},
		shapeErrors: overrides?.shapeErrors ?? [],
		warnings: overrides?.warnings ?? [],
		probe: overrides?.probe ?? {
			verdict: "ok",
			kernelVersion: PINNED_SIYUAN_VERSION,
		},
		validKBs: new Map(
			overrides?.validKBs ?? kbs.map(({ name, notebook }) => [name, notebook]),
		),
		scope: overrides?.scope ?? ["recipes"],
		defaultKBs: ["recipes", "projects"],
		authFailed: false,
		lsNotebooksOk: true,
	};
}
