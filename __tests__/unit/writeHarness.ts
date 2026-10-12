// Shared harness for the kb_write test files: a SessionValidation with
// defaults, a SQL-routed kernel stub covering the create flow (guard legs,
// parent lookup, verified-create read) AND the mode flow (ownership, echo,
// block-in-doc, refs, baselines), a fake-pi setup() bound to the registered
// kb_write tool, and the base create params. Consumed by
// writeConfirm/writeGuard/writeCreate tests and the per-mode suites
// (writeEdit/writeAppend/writeReplaceSection/writeDelete/writeMove) plus the
// shared writeModes suite.

import {
	GUARD_NEAR_CAP,
	PINNED_SIYUAN_VERSION,
	SiYuanApiError,
	type BlockTransaction,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import { statementKind } from "siyuan-kb-primitives/testing";
import { type WriteKernelClient } from "siyuan-kb-primitives/write";
import { CircuitBreaker } from "../../breaker.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import type { WriteParams } from "../../writeSchema.js";
import { ContentBaselines } from "../../baselines.js";
import type { SessionValidation } from "../../validation.js";
import { expect } from "vitest";
import {
	createWriteGrantState,
	GRANT_YES,
	type GrantSelectFn,
	type GrantSelectOptions,
} from "../../writeConfirm.js";
import { registerWriteToolAndToolset } from "../../write.js";
import { type WriteToolHooks } from "../../writePrepare.js";
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
	/** BLOCK_CONTENTS route rows ({id, content}) — the raw current-
	 * content read the fresh-content re-check and the write-result
	 * refresh ride; [] (the default) means vanished targets, re-check
	 * skipped. */
	baselineRows?: Record<string, unknown>[];
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
	onRemoveDoc?: () => void;
	/** Override the updateBlock response tx — e.g. an ops array without the
	 * target's id pins the edit flow's "no update operation" verified failure. */
	updateTx?: BlockTransaction[];
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
	 * tests and the replace-section members-survived pin rely on (the
	 * sweep's post-write judgment must see the survivors it refuses on). */
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
			return PINNED_SIYUAN_VERSION;
		},
		listNotebooks: async () => ({ notebooks: [] }),
		async query(stmt) {
			calls.push({ method: "query", args: stmt });
			if (queryError) throw queryError;
			// Route on the classifier — a SQL rewording updates the head
			// constant in the package's single home and the classification is
			// unchanged; routing never keys on statement text.
			const kind = statementKind(stmt);
			// Mode-flow routes:
			if (kind === "refs-backlink") {
				return config.refRows ?? [];
			}
			if (kind === "referring-hpaths") {
				return config.hpathRows ?? [];
			}
			if (kind === "block-contents") return config.baselineRows ?? [];
			if (kind === "block-in-doc") {
				// blockRows fixtures are rows of the default doc ("d-doc") —
				// the stub fills root_id; a foreign-block test pins root_id
				// explicitly (the spread lets the fixture win).
				return (config.blockRows ?? []).map((r) => ({
					root_id: "d-doc",
					...r,
				}));
			}
			if (kind === "ownership" || kind === "root-echo") {
				const docId = stmtDocId(stmt);
				const root = docId === undefined ? undefined : docRoots[docId];
				return root === undefined
					? []
					: [{ root_id: docId, content: root.content, hpath: root.hpath }];
			}
			// Create-flow routes:
			if (kind === "guard") {
				// The exact leg ends `LIMIT GUARD_EXACT_CAP + 1`; the near scan ends
				// `LIMIT GUARD_NEAR_CAP + 1`. The two distinct terminating LIMITs are
				// the routing discriminator: no embeddable title text can imitate
				// either ending.
				return stmt.endsWith(`LIMIT ${GUARD_NEAR_CAP + 1}`)
					? (config.nearRows ?? [])
					: (config.exactRows ?? []);
			}
			if (kind === "parent-lookup") {
				return config.parentRows ?? [];
			}
			if (kind === "verified-root") {
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
			// Doc roots echo their own hpath (the live-tree ground truth the
			// verified doc move's judgment rides); anything else is "/doc".
			return {
				hPath: docRoots[id]?.hpath ?? "/doc",
				content: `# markdown of ${id}\nbody`,
			};
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
			// The kernel applies the update and the blocks index converges to
			// the submitted form (live-pinned) — mirror that in the SQL
			// fixtures so the edit flow's round-trip verification sees it.
			for (const row of config.blockRows ?? []) {
				if ((row as { id?: string }).id === params.id) {
					(row as { content: string }).content = params.data;
				}
			}
			// The live tree converges too — the fresh-content precondition and
			// the write-result outline read it as the source of truth.
			for (const rows of Object.values(childrenFor)) {
				const row = (rows as { id?: string; content?: string }[]).find(
					(r) => r.id === params.id,
				);
				if (row !== undefined) row.content = params.data;
			}
			return config.updateTx ?? [{ doOperations: [{ id: String(params.id) }] }];
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
			config.onRemoveDoc?.();
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

interface GrantCall {
	title: string;
	options: string[];
	opts?: GrantSelectOptions;
}

/** Register kb_write on a fake pi and return the registered tool plus an
 * execute() bound to an interactive ctx (the default select grants the
 * turn — tests inject overrides via ctx). `signal` rides the tool's third
 * argument, exactly where pi forwards the run's signal. */
export function registerKbWrite(
	hooks: WriteToolHooks,
	opts: {
		hasUI?: boolean | undefined;
		signal?: AbortSignal | undefined;
		select?: GrantSelectFn;
	} = {},
) {
	const { pi, toolDefs } = createFakePi();
	registerWriteToolAndToolset(pi, hooks);
	// The default dialog grants the turn; tests inject overrides via ctx.
	const { ctx } = createFakeCtx({
		hasUI: opts.hasUI ?? true,
		select: opts.select ?? (async () => GRANT_YES),
	});
	const tool = toolDefs.get("kb_write") as unknown as {
		execute: (
			id: string,
			params: WriteParams,
			s: AbortSignal | undefined,
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
			opts.signal,
			undefined,
			ctx,
		)) as Exec;
	return { execute, tool };
}

type WriteExec = (
	params: Record<string, unknown>,
) => Promise<Record<string, unknown> & { status: string; message: string }>;

interface WriteSetupResult {
	/** Details-level result (status/message + echo fields) — the assertion
	 * surface every write test uses. */
	execute: WriteExec;
	tool: { parameters: unknown; description?: string };
	client: WriteKernelClient;
	/** The circuit breaker the tool runs under (a held instance when passed
	 * via opts.breaker). */
	breaker: CircuitBreaker;
	calls: { method: string; args: unknown }[];
	/** The grant dialogs the write entry opened (title + options + the
	 * opts the production code passed — signal, native timeout). */
	grantCalls: GrantCall[];
	grantState: ReturnType<typeof createWriteGrantState>;
	childrenFor: Record<string, unknown[]>;
	baselines: ContentBaselines;
}

/** A BLOCK_CONTENTS override serving `stored`'s rows for exactly the
 * requested ids — the real kernel's IN (...) shape, for tests that need
 * post-write stored content distinct from the fixtures. */
export function storedContentStub(
	harness: Pick<WriteSetupResult, "client">,
	stored: Record<string, string>,
): void {
	const baseQuery = harness.client.query.bind(harness.client);
	harness.client.query = async (stmt: string) => {
		if (statementKind(stmt) === "block-contents") {
			const ids = [...stmt.matchAll(/'([^']*)'/g)].map((m) => m[1]);
			return ids.flatMap((id) =>
				id !== undefined && stored[id] !== undefined
					? [{ id, content: stored[id] }]
					: [],
			);
		}
		return baseQuery(stmt);
	};
}

/** The one kb_write harness: a fresh kernel stub, fresh baselines map, and
 * a select seam that records its calls (the default grants the turn — the
 * headless default-deny and the turn-denial fast path are local decisions
 * that precede the dialog). `abortController`'s signal rides the tool's signal argument,
 * the way pi forwards the run's signal. */
export function setup(
	opts: {
		config?: StubConfig;
		validation?: SessionValidation;
		/** Test seam: pass a held breaker to observe reset behavior. */
		breaker?: CircuitBreaker;
		hasUI?: boolean;
		select?: GrantSelectFn;
		abortController?: AbortController;
		readBodyFile?: (path: string) => Promise<string>;
	} = {},
): WriteSetupResult {
	const kernel = writeKernelStub(opts.config ?? {});
	const grantCalls: GrantCall[] = [];
	const grantState = createWriteGrantState();
	const baselines = ContentBaselines.create();
	const breaker = opts.breaker ?? new CircuitBreaker();
	const recordedSelect: GrantSelectFn = async (title, options, selectOpts) => {
		grantCalls.push({
			title,
			options,
			...(selectOpts !== undefined ? { opts: selectOpts } : {}),
		});
		return opts.select ? opts.select(title, options, selectOpts) : GRANT_YES;
	};
	const { execute: run, tool } = registerKbWrite(
		{
			getValidation: () => opts.validation ?? validation(),
			getKernel: () => kernel.client,
			breaker,
			grantState,
			baselines,
			...(opts.readBodyFile !== undefined && {
				readBodyFile: opts.readBodyFile,
			}),
		},
		{
			hasUI: opts.hasUI,
			signal: opts.abortController?.signal,
			select: recordedSelect,
		},
	);
	const execute: WriteExec = async (params) => (await run(params)).details;
	return {
		execute,
		tool,
		breaker,
		client: kernel.client,
		calls: kernel.calls,
		grantCalls,
		grantState,
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

export const editBase = {
	kb: "recipes",
	mode: "edit",
	docId: "d-doc",
	blockId: "b-1",
	markdown: "corrected body",
};

export const SECTION_DOC = {
	// Heading sections are seeded as the kernel returns them (a heading's
	// getChildBlocks answer is its section: following siblings up to the next
	// heading of same-or-higher level). The walk never recurses into `h` — it
	// reaches these blocks through the `d-doc` loop — so these entries are here
	// to fail the suite if heading recursion is ever reintroduced.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
	h1: [
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
	h2: [walkBlock("p2", "p", "", "body two")],
};

export const REPLACE_DOC = {
	// The boundary heading is same-level (h1): the section is [p1, p2] — the
	// same-or-shallower pin (deeper headings would belong to the section).
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "old one"),
		walkBlock("p2", "p", "", "old two"),
		walkBlock("h2", "h", "h1", "Details"),
		walkBlock("p3", "p", "", "tail"),
	],
	// Kernel-shaped heading sections (see SECTION_DOC): the delete set must
	// stay the enumerated section, never the heading's answer re-emitted.
	h1: [
		walkBlock("p1", "p", "", "old one"),
		walkBlock("p2", "p", "", "old two"),
	],
	h2: [walkBlock("p3", "p", "", "tail")],
};

export const replaceParams = {
	kb: "recipes",
	mode: "replace-section",
	docId: "d-doc",
	headingId: "h1",
	markdown: "rewritten section",
};

/** Shared assertions for the outcome-unverified contract: a transport-class
 * failure on the mutation call itself (the kernel's response never arrived)
 * must read as verificationFailed — never runKbCall's "SiYuan unreachable",
 * whose retry invitation would duplicate an applied write. The transport
 * classification itself (timeout vs fetch reject) is falsified down-repo in
 * the primitives' failure suite; one wording case per site here. */
export function expectUnverified(r: Record<string, unknown>): void {
	expect(r.status).toBe("error");
	expect(r.verificationFailed).toBe(true);
	expect(r.message).toContain("outcome is unverified");
	expect(r.message).toContain("do NOT retry blindly");
	expect(r.message).not.toContain("SiYuan unreachable");
}
