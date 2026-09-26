// Shared fake-pi/fake-ctx harness for the unit suites: the pi surface the
// extension uses (event handlers, commands, tool registration + masking
// state, appendEntry) and a ctx with ui/sessionManager. The returned
// accessors (fire/emitEvent/runCommand/runTool) drive registered handlers
// and tools directly.

import type register from "../../index.js";

type Pi = Parameters<typeof register>[0];

interface EnvelopeShape {
	status: string;
	message: string;
	reason?: string;
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

export function createFakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> | void }
	>();
	const entries: { type: string; customType?: string; data?: unknown }[] = [];
	const tools: { name: string }[] = [];
	const toolDefs = new Map<string, { name: string; [k: string]: unknown }>();
	// pi semantics: registered tools are active by default; masking rewrites
	// this set via setActiveTools.
	let active: string[] = [];
	const eventHandlers = new Map<string, Handler[]>();
	const runToolImpl = async (
		name: string,
		params: unknown,
		ctx: unknown,
	): Promise<{ details: EnvelopeShape }> => {
		const tool = toolDefs.get(name);
		const execute = tool?.execute as
			| ((...args: unknown[]) => Promise<{ details: EnvelopeShape }>)
			| undefined;
		if (tool === undefined || execute === undefined) {
			throw new Error(`no tool registered: ${name}`);
		}
		return await execute("test-id", params, undefined, undefined, ctx);
	};
	const runToolDetails = async (
		name: string,
		params: unknown,
		ctx: unknown,
	): Promise<Record<string, unknown> & { status: string }> =>
		(await runToolImpl(name, params, ctx)).details as unknown as Record<
			string,
			unknown
		> & {
			status: string;
		};
	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(
			name: string,
			options: {
				handler: (args: string, ctx: unknown) => Promise<void> | void;
			},
		) {
			commands.set(name, options);
		},
		registerTool(tool: { name: string; [k: string]: unknown }) {
			tools.push({ name: tool.name });
			toolDefs.set(tool.name, tool);
			active = [...active, tool.name];
		},
		getAllTools: () => tools as never,
		getActiveTools: () => [...active],
		setActiveTools(names: string[]) {
			active = [...names];
		},
		events: {
			emit: () => {},
			on: (event: string, handler: Handler) => {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			},
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
	};
	return {
		pi: pi as unknown as Pi,
		toolDefs,
		emitEvent: async (event: string) =>
			Promise.all(
				(eventHandlers.get(event) ?? []).map((h) => h(event, undefined)),
			),
		fire: (event: string, ctx: unknown) =>
			Promise.all((handlers.get(event) ?? []).map((h) => h(event, ctx))),
		runCommand: async (args: string, ctx: unknown) =>
			await commands.get("kb")?.handler(args, ctx),
		runTool: runToolImpl,
		runToolDetails,
		entries,
		tools,
	};
}

export function createFakeCtx(options?: {
	cwd?: string;
	entries?: { type: string; customType?: string; data?: unknown }[];
	/** Active-branch entries; defaults to `entries` (no branching). */
	branch?: { type: string; customType?: string; data?: unknown }[];
	hasUI?: boolean;
	/** The grant-dialog seam (pi's ctx.ui.select): title, exact option
	 * labels, and the opts the production code passes (signal, timeout). */
	select?: (
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal; timeout?: number },
	) => Promise<string | undefined>;
}) {
	const statuses: [string, string | undefined][] = [];
	const notifications: [string, string | undefined][] = [];
	return {
		ctx: {
			ui: {
				setStatus: (key: string, text: string | undefined) => {
					statuses.push([key, text]);
				},
				notify: (message: string, severity?: string) => {
					notifications.push([message, severity]);
				},
				theme: { fg: (_c: string, t: string) => t },
				...(options?.select !== undefined && { select: options.select }),
			},
			hasUI: options?.hasUI,
			cwd: options?.cwd ?? "/project",
			sessionManager: {
				getEntries: () => options?.entries ?? [],
				getBranch: () => options?.branch ?? options?.entries ?? [],
				getSessionId: () => "test-session",
			},
		},
		statuses,
		notifications,
	};
}
