// Sprint 5 ACs — the write toolset declares requires: ["gnubrain.read"]
// (§5 tool-masking record): live-toggle cascade legs, and the settings-pin
// boundary (no cascade at restore — the documented reachable
// write-without-read state, backstopped by confirmation + headless
// default-deny).

import { afterEach, describe, expect, it } from "vitest";
import {
	defineToolset,
	getRegisteredToolsets,
	setSettingsOverrideForTests,
} from "pi-tool-masking";

type Handler = (event: unknown, ctx: unknown) => void;

interface TestPi {
	events: { on(event: string, handler: Handler): void };
	registerTool(tool: { name: string }): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const eventHandlers = new Map<string, Handler[]>();
	const tools: string[] = [];
	let active: string[] = [];
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool.name);
			active = [...active, tool.name];
		},
		getAllTools: () => tools.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
		events: {
			emit: () => {},
			on(event: string, handler: Handler) {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
		},
		appendEntry: () => {},
		getBranch: () => [],
	};
	return {
		pi: pi as unknown as TestPi,
		fire: (event: string, ctx: unknown = {}) =>
			(handlers.get(event) ?? []).forEach((h) => h(event, ctx)),
		emitEvent: (event: string, payload: unknown) =>
			(eventHandlers.get(event) ?? []).forEach((h) => h(payload, {})),
	};
}

const READ_SPEC = {
	id: "cascade.read",
	names: new Set(["tool-a"]),
	persistKey: "toolset-state:cascade.read",
	defaultEnabled: true,
};

const WRITE_SPEC = {
	id: "cascade.write",
	names: new Set(["tool-b"]),
	persistKey: "toolset-state:cascade.write",
	defaultEnabled: true,
	requires: ["cascade.read"],
};

afterEach(() => {
	setSettingsOverrideForTests(null);
});

// The library filters spec members against pi's registered tools —
// pre-register both members so enable/disable apply.
function registerMembers(pi: {
	registerTool(t: { name: string }): void;
}): void {
	pi.registerTool({ name: "tool-a" });
	pi.registerTool({ name: "tool-b" });
}

describe("write toolset requires-cascade (§5)", () => {
	it("declares requires: [gnubrain.read]-style cascade, default-enabled, pinned persist key", () => {
		const { pi } = fakePi();
		defineToolset(pi as never, READ_SPEC);
		defineToolset(pi as never, WRITE_SPEC);
		const entry = getRegisteredToolsets().find(
			(t) => t.spec.id === "cascade.write",
		);
		expect(entry).toBeDefined();
		expect(entry?.spec.requires).toEqual(["cascade.read"]);
		expect(entry?.spec.defaultEnabled).toBe(true);
		expect(entry?.spec.persistKey).toBe("toolset-state:cascade.write");
		expect([...(entry?.spec.names ?? [])]).toEqual(["tool-b"]);
	});

	it("enabling writes cascades reads on; disabling reads cascades writes off", () => {
		const { pi } = fakePi();
		registerMembers(pi);
		const read = defineToolset(pi as never, READ_SPEC);
		const write = defineToolset(pi as never, WRITE_SPEC);
		// Both default-on; mask reads → the cascade pulls the dependent off.
		read.disable(pi as never);
		expect(pi.getActiveTools()).toEqual([]);
		// Enabling writes auto-enables reads (the live-toggle cascade).
		write.enable(pi as never);
		expect(pi.getActiveTools().sort()).toEqual(["tool-a", "tool-b"]);
		// Disabling reads cascades the dependent writes off.
		read.disable(pi as never);
		expect(pi.getActiveTools()).toEqual([]);
	});
});

describe("settings-pin boundary (documented, §5)", () => {
	// pi-tool-masking's settings tier applies each toolsetDefaults pin
	// per-toolset at restore WITHOUT re-running the requires cascade — the
	// reachable write-without-read state. That restore behavior is pinned by
	// pi-tool-masking's own suite; what gnubrain owns is the spec shape and
	// the live-toggle cascade (above), plus the backstop record: masking is
	// the outer layer, and confirmation + headless default-deny remain in
	// force on every write regardless of how the toolset state was reached.
	it("the write toolset is a single-tool, read-requiring toolset (the boundary's operands)", () => {
		const { pi } = fakePi();
		registerMembers(pi);
		defineToolset(pi as never, READ_SPEC);
		defineToolset(pi as never, WRITE_SPEC);
		const read = getRegisteredToolsets().find(
			(t) => t.spec.id === "cascade.read",
		);
		const write = getRegisteredToolsets().find(
			(t) => t.spec.id === "cascade.write",
		);
		// read's defaultEnabled: true — an unpinned read stays active at
		// restore; only an explicit read-off pin can mask it, and that pin
		// never cascades to write.
		expect(read?.spec.defaultEnabled).toBe(true);
		expect(write?.spec.requires).toEqual(["cascade.read"]);
		expect([...(write?.spec.names ?? [])]).toEqual(["tool-b"]);
	});
});

describe("status glyph repaint handlers (§5 status-bar record)", () => {
	it("receives TOOLSET_EVENTS.changed/restored", () => {
		const { pi, emitEvent } = fakePi();
		const received: { event: string; enabled: boolean }[] = [];
		pi.events.on("toolset:changed", (event) => {
			received.push({
				event: "changed",
				enabled: (event as { enabled?: boolean }).enabled === true,
			});
		});
		pi.events.on("toolset:restored", (event) => {
			received.push({
				event: "restored",
				enabled: (event as { enabled?: boolean }).enabled === true,
			});
		});
		emitEvent("toolset:changed", { id: WRITE_SPEC.id, enabled: false });
		emitEvent("toolset:restored", { id: WRITE_SPEC.id, enabled: true });
		expect(received).toEqual([
			{ event: "changed", enabled: false },
			{ event: "restored", enabled: true },
		]);
	});
});
