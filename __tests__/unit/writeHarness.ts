// Shared harness for the kb_write test files: a SessionValidation with
// defaults, a SQL-routed kernel stub, a fake-pi setup() bound to the
// registered kb_write tool, and the base create params. Consumed by
// writeConfirm/writeGuard/writeCreate tests and the writeModes schema leg.

import { CircuitBreaker } from "../../breaker.js";
import {
	PARENT_LOOKUP_STMT_HEAD,
	VERIFIED_ROOT_STMT_HEAD,
} from "../../writeCreate.js";
import type { WalkedBlock } from "../../tools.js";
import { GUARD_STMT_HEAD } from "../../writeGuard.js";
import type { SessionValidation } from "../../validation.js";
import { createWriteConfirmState } from "../../writeConfirm.js";
import { type WriteParams } from "../../writeModes.js";
import { registerWriteTool, type WriteToolHooks } from "../../write.js";
import { type WriteKernelClient } from "../../writeResult.js";

export function validation(
	overrides: Partial<SessionValidation["settings"]> = {},
) {
	return {
		settings: {
			baseUrl: "http://127.0.0.1:6806",
			apiToken: "token",
			kbs: [{ name: "recipes", notebook: "nb-r" }],
			...overrides,
		},
		shapeErrors: [],
		probe: "ok",
		kernelVersion: "3.8.3",
		validKBs: new Map([["recipes", "nb-r"]]),
		scope: ["recipes"],
		warnings: [],
		authFailed: false,
		lsNotebooksOk: true,
	} satisfies SessionValidation;
}

export interface StubConfig {
	exactRows?: Record<string, unknown>[];
	nearRows?: Record<string, unknown>[];
	parentRows?: Record<string, unknown>[];
	createdRows?: Record<string, unknown>[];
	children?: Record<string, unknown>[];
	onCreate?: () => void;
}

/** Kernel stub with a SQL router covering the create flow: guard legs vs
 * parent lookup vs the verified-create read, plus a create-call log.
 * Verified rows default to a well-formed minted row unless the test pins
 * the read (empty array = missing row → fail-loud). Block-write methods
 * exist to satisfy the client interface; mode-flow routing (ownership,
 * echo, block-in-doc, refs) lives in writeModes.test.ts's own stub. */
export function writeKernelStub(config: StubConfig = {}) {
	const calls: { method: string; args: unknown }[] = [];
	const tx = [{ doOperations: [{ id: "b-new" }] }];
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => {
			calls.push({ method: "getVersion", args: undefined });
			return "3.8.3";
		},
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			// Route on the production SELECT heads — a SQL rewording updates
			// the head constant in the same diff, never a silent re-route.
			if (stmt.startsWith(GUARD_STMT_HEAD)) {
				// The exact leg has no LIMIT; the near scan always ends LIMIT
				// 21. (A " OR " check would misroute a fixture title that
				// embeds " OR " — the exact pattern carries the title verbatim.)
				return stmt.includes("LIMIT")
					? (config.nearRows ?? [])
					: (config.exactRows ?? []);
			}
			if (stmt.startsWith(PARENT_LOOKUP_STMT_HEAD)) {
				return config.parentRows ?? [];
			}
			if (stmt.startsWith(VERIFIED_ROOT_STMT_HEAD)) {
				return (
					config.createdRows ?? [
						{
							id: "d-new",
							root_id: "d-new",
							content: "Docker Networking",
							hpath: "/Docker Networking",
							updated: "20260101120000",
						},
					]
				);
			}
			throw new Error(`stub has no route for: ${stmt}`);
		},
		async search() {
			throw new Error("write flow never searches");
		},
		async exportMarkdown(id) {
			calls.push({ method: "exportMarkdown", args: id });
			return { hPath: "/doc", content: `# markdown of ${id}\nbody` };
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			return (
				config.children ?? [
					{ id: "h1", type: "h", subType: "h1", content: "Heading" },
				]
			);
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			config.onCreate?.();
			return "d-new";
		},
		async updateBlock(params) {
			calls.push({ method: "updateBlock", args: params });
			return tx;
		},
		async insertBlock(params) {
			calls.push({ method: "insertBlock", args: params });
			return tx;
		},
		async appendBlock(params) {
			calls.push({ method: "appendBlock", args: params });
			return tx;
		},
		async deleteBlock(id) {
			calls.push({ method: "deleteBlock", args: id });
			return tx;
		},
		async moveBlock(params) {
			calls.push({ method: "moveBlock", args: params });
			return null;
		},
		async removeDocByID(id) {
			calls.push({ method: "removeDocByID", args: id });
			return null;
		},
		async moveDocsByID(params) {
			calls.push({ method: "moveDocsByID", args: params });
			return null;
		},
	};
	return { calls, client };
}

export function walkBlock(
	id: string,
	type: string,
	subType: string,
	content: string,
	depth = 1,
): WalkedBlock {
	return { id, type, subType, content, depth };
}

type Exec = (params: Record<string, unknown>) => Promise<{
	content: { type: "text"; text: string }[];
	details: Record<string, unknown> & { status: string; message: string };
}>;

/** Register kb_write on a fake pi and return the registered tool plus an
 * execute() bound to an interactive ctx (the default dialog confirms —
 * tests inject overrides via hooks). */
export function registerKbWrite(
	hooks: WriteToolHooks,
	opts: { hasUI?: boolean | undefined } = {},
) {
	let registered:
		| { name: string; description?: string; execute: unknown }
		| undefined;
	const pi = {
		registerTool(tool: {
			name: string;
			description?: string;
			execute: unknown;
		}) {
			registered = tool;
		},
	};
	registerWriteTool(
		pi as unknown as Parameters<typeof registerWriteTool>[0],
		hooks,
	);
	const ctx = {
		sessionManager: { getSessionId: () => "sess-w" },
		hasUI: opts.hasUI ?? true,
		ui: { confirm: async () => true },
	};
	const tool = registered as unknown as {
		execute: (
			id: string,
			params: WriteParams,
			s: undefined,
			o: undefined,
			c: unknown,
		) => Promise<{
			content: { type: "text"; text: string }[];
			details: Record<string, unknown> & { status: string; message: string };
		}>;
		parameters: unknown;
		description?: string;
	};
	const execute = ((params: Record<string, unknown>) =>
		tool.execute(
			"id",
			params as WriteParams,
			undefined,
			undefined,
			ctx,
		)) as Exec;
	return { execute, tool };
}

/** Test hooks + stub-config pass-through (a local intersection, not a
 * module augmentation — the production interface stays clean). */
type TestHooks = Partial<WriteToolHooks> & { __config?: StubConfig };

export function setup(
	hooks: TestHooks = {},
	v: SessionValidation = validation(),
) {
	const { __config, ...hookRest } = hooks;
	const kernel = writeKernelStub(__config ?? {});
	const { execute, tool } = registerKbWrite(
		{
			getValidation: () => v,
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			...hookRest,
		} as WriteToolHooks,
		{ hasUI: hooks.hasUI },
	);
	return { execute, kernel, tool };
}

export const base = {
	kb: "recipes",
	mode: "create",
	topic: "Docker Networking",
	markdown: "some body",
};
