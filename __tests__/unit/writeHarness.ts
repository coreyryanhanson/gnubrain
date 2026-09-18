// Shared harness for the kb_write test files: a SessionValidation with
// defaults, a SQL-routed kernel stub covering the create flow (guard legs,
// parent lookup, verified-create read) AND the mode flow (ownership, echo,
// block-in-doc, refs, baselines), a fake-pi setup() bound to the registered
// kb_write tool, and the base create params. Consumed by
// writeConfirm/writeGuard/writeCreate/writeAnchors tests and the full
// writeModes suite.

import { SiYuanApiError } from "siyuan-kernel-api";
import { CircuitBreaker } from "../../breaker.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import {
	PARENT_LOOKUP_STMT_HEAD,
	VERIFIED_ROOT_STMT_HEAD,
} from "../../writeCreate.js";
import { GUARD_STMT_HEAD } from "../../writeGuard.js";
import {
	BLOCK_IN_DOC_STMT_HEAD,
	PARENT_DOC_STMT_HEAD,
} from "../../writeFlow.js";
import type { WriteParams } from "../../writeSchema.js";
import { OWNERSHIP_STMT_HEAD } from "../../kernel.js";
import type { WalkedBlock } from "../../walk.js";
import {
	BASELINE_CONTENTS_STMT_HEAD,
	ROOT_ECHO_STMT_HEAD,
	REFS_BACKLINK_STMT_HEAD,
	REFERRING_HPATHS_STMT_HEAD,
} from "../../writeResult.js";
import type { WriteKernelClient } from "../../kernel.js";
import { ContentBaselines } from "../../baselines.js";
import type { SessionValidation } from "../../validation.js";
import {
	createWriteConfirmState,
	type WriteConfirmFn,
} from "../../writeConfirm.js";
import { registerWriteTool, type WriteToolHooks } from "../../write.js";
import { validation } from "./fixtures.js";

export { validation };

export interface StubConfig {
	// Create-flow routes (guard legs, parent lookup, verified-create read).
	exactRows?: Record<string, unknown>[];
	nearRows?: Record<string, unknown>[];
	parentRows?: Record<string, unknown>[];
	createdRows?: Record<string, unknown>[];
	// Mode-flow routes (ownership, echo, block-in-doc, refs, baselines).
	blockRows?: Record<string, unknown>[];
	refRows?: Record<string, unknown>[];
	hpathRows?: Record<string, unknown>[];
	parentDocRows?: Record<string, unknown>[];
	/** docId → root row (ownership + echo routes discriminate by id). */
	docRoots?: Record<string, { content: string; hpath: string } | undefined>;
	/** docId → child-block rows; the map is live — tests mutate it inside
	 * the write callbacks to simulate the kernel applying (or rolling back)
	 * an op. */
	childrenFor?: Record<string, unknown[]>;
	/** Create-flow alias for childrenFor["d-doc"] (the pre-create doc walk).
	 * Named childRows, not children: two identically-shaped optional array
	 * properties in one interface trip a tsgo 7.0.x excess-property bug. */
	childRows?: Record<string, unknown>[];
	// Mutation hooks + error arming.
	onCreate?: () => void;
	onInsert?: () => void;
	onDelete?: () => void;
	onMove?: () => void;
	onUpdate?: () => void;
	/** Captures a setter the test calls from a mutation callback: all
	 * subsequent query() calls throw — the network drop between a landed
	 * write and the post-write verification reads. */
	armQueryError?: (arm: (err: Error) => void) => void;
	/** Same arm pattern for getChildBlocks — the post-write verification
	 * walk drop (a query-arm doesn't reach it: the walk rides the child
	 * route, not SQL). */
	armWalkError?: (arm: (err: Error) => void) => void;
	/** Arm for deleteBlock — a mid-sweep transport failure (network drop
	 * on the Nth delete), distinct from the SQL-arm (verification reads). */
	armDeleteError?: (arm: (err: Error) => void) => void;
	/** Arm for exportMarkdown — the vanished-candidate race mid-guard-stop
	 * (the spill read fails after the guard query matched). */
	armExportError?: (arm: (err: Error) => void) => void;
	/** Model the kernel's cascading delete: an indexed id is removed together
	 * with its tree descendants, and a delete of an id no longer in the index
	 * throws the kernel's synchronous tree-not-found error. Off (default):
	 * deletes apply nothing — the success no-op generation the stale-target
	 * tests pin. */
	cascadeDelete?: boolean;
}

/** Kernel stub with a SQL router over every write-flow route. Verified rows
 * default to a well-formed minted row unless the test pins the read (empty
 * array = missing row → fail-loud). The returned `childrenFor` map is live.
 * The default minted doc ("d-new", returned by createDocWithMarkdown and the
 * verified-create read) carries one heading child — the create flow's
 * post-create outline read walks it. */
export function writeKernelStub(config: StubConfig = {}) {
	const calls: { method: string; args: unknown }[] = [];
	const tx = [{ doOperations: [{ id: "b-new" }] }];
	const docRoots = config.docRoots ?? {
		"d-doc": { content: "Docker Networking", hpath: "/Docker Networking" },
	};
	const defaultChildren = [
		{ id: "h1", type: "h", subType: "h1", content: "Heading" },
	];
	const childrenFor: Record<string, unknown[]> = {
		"d-doc": [],
		...(config.childRows ? { "d-doc": config.childRows } : {}),
		...JSON.parse(JSON.stringify(config.childrenFor ?? {})),
	};
	// Unseeded ids: per-doc seeds exist → mode-flow semantics, unseeded ids
	// (block ids reached by the walk's recursion) are childless; otherwise
	// create-flow semantics — one tree for every doc (candidates, the minted
	// doc) riding childRows or the default heading walk.
	const unseededDefault = config.childrenFor
		? []
		: (config.childRows ?? defaultChildren);
	const stmtDocId = (stmt: string): string | undefined =>
		/id = '([^']+)'/.exec(stmt)?.[1];
	let queryError: Error | undefined;
	config.armQueryError?.((err) => {
		queryError = err;
	});
	let walkError: Error | undefined;
	config.armWalkError?.((err) => {
		walkError = err;
	});
	let deleteError: Error | undefined;
	config.armDeleteError?.((err) => {
		deleteError = err;
	});
	let exportError: Error | undefined;
	config.armExportError?.((err) => {
		exportError = err;
	});
	/** Remove an indexed block and its tree descendants from the live
	 * children map — the kernel's delete cascade (an indexed container's
	 * descendants leave the index with it). Returns false when the id is no
	 * longer indexed. */
	const removeIndexed = (id: string): boolean => {
		let removed = false;
		for (const rows of Object.values(childrenFor)) {
			const idx = rows.findIndex((row) => (row as { id?: string }).id === id);
			if (idx >= 0) {
				rows.splice(idx, 1);
				removed = true;
				break;
			}
		}
		if (!removed) return false;
		for (const child of (childrenFor[id] ?? []) as { id: string }[]) {
			removeIndexed(child.id);
		}
		delete childrenFor[id];
		return true;
	};
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => {
			calls.push({ method: "getVersion", args: undefined });
			return "3.8.4";
		},
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (queryError) throw queryError;
			// Route on the production SELECT heads — a SQL rewording updates
			// the head constant in the same diff, never a silent re-route.
			// Mode-flow routes:
			if (stmt.startsWith(REFS_BACKLINK_STMT_HEAD)) {
				return config.refRows ?? [];
			}
			if (stmt.startsWith(REFERRING_HPATHS_STMT_HEAD)) {
				return config.hpathRows ?? [];
			}
			// BASELINE_CONTENTS' head is a prefix-superset of BLOCK_IN_DOC's
			// ("... WHERE id IN" vs "... WHERE id"), so it must route first.
			if (stmt.startsWith(BASELINE_CONTENTS_STMT_HEAD)) return [];
			if (stmt.startsWith(BLOCK_IN_DOC_STMT_HEAD)) {
				// blockRows fixtures are rows of the default doc ("d-doc") —
				// the stub fills root_id; a foreign-block test pins root_id
				// explicitly (the spread lets the fixture win).
				return (config.blockRows ?? []).map((r) => ({
					root_id: "d-doc",
					...r,
				}));
			}
			if (stmt.startsWith(PARENT_DOC_STMT_HEAD)) {
				return config.parentDocRows ?? [];
			}
			if (
				stmt.startsWith(OWNERSHIP_STMT_HEAD) ||
				stmt.startsWith(ROOT_ECHO_STMT_HEAD)
			) {
				const docId = stmtDocId(stmt);
				const root = docId === undefined ? undefined : docRoots[docId];
				return root === undefined
					? []
					: [{ root_id: docId, content: root.content, hpath: root.hpath }];
			}
			// Create-flow routes:
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
			if (exportError) throw exportError;
			return { hPath: "/doc", content: `# markdown of ${id}\nbody` };
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			if (walkError) throw walkError;
			return (childrenFor[id] ?? unseededDefault) as Record<string, unknown>[];
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			config.onCreate?.();
			return "d-new";
		},
		async updateBlock(params) {
			calls.push({ method: "updateBlock", args: params });
			config.onUpdate?.();
			return tx;
		},
		async insertBlock(params) {
			calls.push({ method: "insertBlock", args: params });
			config.onInsert?.();
			return tx;
		},
		async appendBlock(params) {
			calls.push({ method: "appendBlock", args: params });
			config.onInsert?.();
			return tx;
		},
		async deleteBlock(id) {
			calls.push({ method: "deleteBlock", args: id });
			config.onDelete?.();
			if (deleteError) throw deleteError;
			if (config.cascadeDelete === true && !removeIndexed(String(id))) {
				throw new SiYuanApiError(-1, -1, "tree not found");
			}
			return tx;
		},
		async moveBlock(params) {
			calls.push({ method: "moveBlock", args: params });
			config.onMove?.();
			return null;
		},
		async removeDocByID(id) {
			calls.push({ method: "removeDocByID", args: id });
			return null;
		},
		async moveDocsByID(params) {
			calls.push({ method: "moveDocsByID", args: params });
			config.onMove?.();
			return null;
		},
	};
	return { calls, client, childrenFor };
}

export function walkBlock(
	id: string,
	type: string,
	subType: string,
	content: string,
	parentId: string | null = null,
	parentType: string | null = "d",
): WalkedBlock {
	return { id, type, subType, content, parentId, parentType };
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
	const { pi, toolDefs } = createFakePi();
	registerWriteTool(pi, hooks);
	// The default dialog confirms; tests inject overrides via hooks.
	const { ctx } = createFakeCtx({
		hasUI: opts.hasUI ?? true,
		confirm: async () => true,
	});
	const tool = toolDefs.get("kb_write") as unknown as {
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

export type WriteExec = (
	params: Record<string, unknown>,
) => Promise<Record<string, unknown> & { status: string; message: string }>;

export interface WriteSetupResult {
	/** Details-level result (status/message + echo fields) — the assertion
	 * surface every write test uses. */
	execute: WriteExec;
	tool: { parameters: unknown; description?: string };
	client: WriteKernelClient;
	calls: { method: string; args: unknown }[];
	confirmCalls: { title: string; message: string }[];
	childrenFor: Record<string, unknown[]>;
	baselines: ContentBaselines;
}

/** The one kb_write harness: a fresh kernel stub, fresh baselines map, and
 * a confirm hook that records its calls (the default approves — the
 * headless default-deny runs in preflight, before the dialog). */
export function setup(
	opts: {
		config?: StubConfig;
		validation?: SessionValidation;
		hasUI?: boolean;
		confirm?: WriteConfirmFn;
		readBodyFile?: (path: string) => Promise<string>;
	} = {},
): WriteSetupResult {
	const kernel = writeKernelStub(opts.config ?? {});
	const confirmCalls: { title: string; message: string }[] = [];
	const baselines = ContentBaselines.create();
	const { execute: run, tool } = registerKbWrite(
		{
			getValidation: () => opts.validation ?? validation(),
			getKernel: () => kernel.client,
			breaker: new CircuitBreaker(),
			confirmState: createWriteConfirmState(),
			baselines,
			confirm: async (
				title: string,
				message: string,
				confirmOpts: { signal?: AbortSignal },
			) => {
				confirmCalls.push({ title, message });
				return opts.confirm ? opts.confirm(title, message, confirmOpts) : true;
			},
			...(opts.readBodyFile !== undefined && {
				readBodyFile: opts.readBodyFile,
			}),
		} as WriteToolHooks,
		{ hasUI: opts.hasUI },
	);
	const execute: WriteExec = async (params) => (await run(params)).details;
	return {
		execute,
		tool,
		client: kernel.client,
		calls: kernel.calls,
		confirmCalls,
		childrenFor: kernel.childrenFor,
		baselines,
	};
}

export const base = {
	kb: "recipes",
	mode: "create",
	topic: "Docker Networking",
	markdown: "some body",
};
