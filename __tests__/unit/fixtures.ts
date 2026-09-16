// Shared SessionValidation fixture for the unit tests. One canonical shape:
// recipes + projects configured and valid, scope = [recipes]. Overrides
// replace, they do not merge; names configured but absent from validKBs
// simulate stale/encrypted notebooks.
import type { SessionValidation } from "../../validation.js";

export function validation(overrides?: {
	scope?: string[];
	validKBs?: [string, string][];
	kbs?: { name: string; notebook: string }[];
	shapeErrors?: string[];
	probe?: SessionValidation["probe"];
	kernelVersion?: string;
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
		probe: overrides?.probe ?? "ok",
		kernelVersion: overrides?.kernelVersion ?? "3.8.3",
		validKBs: new Map(
			overrides?.validKBs ?? kbs.map(({ name, notebook }) => [name, notebook]),
		),
		scope: overrides?.scope ?? ["recipes"],
		defaultKBs: ["recipes", "projects"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	};
}
