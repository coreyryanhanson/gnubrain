// Shared harness for the kb_write test files: a SessionValidation with
// defaults, a SQL-routed kernel stub covering the create flow (guard legs,
// parent lookup, verified-create read) AND the mode flow (ownership, echo,
// block-in-doc, refs, baselines), a fake-pi setup() bound to the registered
// kb_write tool, and the base create params. Consumed by
// writeConfirm/writeGuard/writeCreate tests and the per-mode suites
// (writeEdit/writeAppend/writeReplaceSection/writeDelete/writeMove) plus
// the shared writeModes/writeSchema/writeFresh suites.

import {
	GUARD_NEAR_CAP,
	PINNED_SIYUAN_VERSION,
	SiYuanApiError,
	type WalkedBlock,
} from "siyuan-kernel-primitives";
import { statementKind } from "siyuan-kernel-primitives/testing";
import { type WriteKernelClient } from "siyuan-kernel-primitives/write";
import { CircuitBreaker } from "../../breaker.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { modeVerdict, type WriteParams } from "../../writeSchema.js";
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
	 * an op. Any id without a seed (including "d-doc") falls back to
	 * `fallbackChildren`. */
	childrenFor?: Record<string, unknown[]>;
	/** Children served for every doc/block id without a `childrenFor` seed
	 * (the create flow's candidate and minted-doc walks). Default [] —
	 * childless; create tests that assert outline/block content seed this
	 * deliberately. */
	fallbackChildren?: Record<string, unknown>[];
	// Mutation hooks + error arming.
	onCreate?: () => void;
	onInsert?: () => void;
	onDelete?: () => void;
	onMove?: () => void;
	onUpdate?: () => void;
	onRemoveDoc?: () => void;
	/** The batched route's hook — invoked after the call is recorded and
	 * the `transactError` arm checked, before the ops apply (a test arms
	 * the post-write walk error here: the walk runs after the ack). */
	onTransact?: (
		transactions: Parameters<WriteKernelClient["transact"]>[0],
	) => void;
	/** Per-op predicate over the batch's delete ops: returning false
	 * simulates the kernel's sub-cliff silent no-op — the op acks behind
	 * HTTP success but the block stays (the survivor arm's input). An
	 * absent id silently no-ops in either case (the kernel's sub-cliff
	 * arm). Default: every op applies, cascade included — the batch lands
	 * whole, exactly like the kernel. */
	transactPrune?: (id: string) => boolean;
	/** Per-op predicate over the batch's move ops: returning true simulates
	 * the kernel's silent whole-batch rollback — every op acks behind HTTP
	 * success but nothing moves (the `nothing-moved` arm's input). */
	transactMoveSkips?: (id: string) => boolean;
	/** Throw to fail the batched transaction call — the whole batch is
	 * unissued (nothing has landed either way; the batch is one call). */
	transactError?: Error;
	/** Captures a setter the test calls from a mutation callback: all
	 * subsequent query() calls throw — the network drop between a landed
	 * write and the post-write verification reads. */
	armQueryError?: (arm: (err: Error) => void) => void;
	/** Same arm pattern for getChildBlocks — the post-write verification
	 * walk drop (a query-arm doesn't reach it: the walk rides the child
	 * route, not SQL). */
	armWalkError?: (arm: (err: Error) => void) => void;
	/** Arm for deleteBlock — the per-block delete flow's transport failure
	 * (network drop on the delete call), distinct from the SQL-arm
	 * (verification reads). The batched section-delete route arms through
	 * `transactError` instead — it issues one call, not one per member. */
	armDeleteError?: (arm: (err: Error) => void) => void;
	/** Arm for the duplicate-stop's excerpt read — the vanished-candidate
	 * race mid-guard-stop over the child-block route: the candidate walk
	 * and the excerpt read (docBody) share the getChildBlocks route, so the
	 * arm keys on the call ordinal — calls 1..from-1 succeed, the
	 * `from`-th and later throw. */
	armChildErrorFrom?: (arm: (from: number, err: Error) => void) => void;
	/** Arm for getHPathByID — the doc-move landed judgment's live-tree
	 * evidence read failing after the move acked (the post-write network
	 * drop). */
	armHPathError?: (arm: (err: Error) => void) => void;
	/** Arm for getVersion — the retry-probe transport failure (a network
	 * drop on the probe itself refuses the write with zero further calls). */
	armVersionError?: (arm: (err: Error) => void) => void;
	/** Model the kernel's cascading delete: an indexed id is removed together
	 * with its tree descendants, and a delete of an id no longer in the index
	 * throws the kernel's synchronous tree-not-found error. Off (default):
	 * deletes apply nothing — the success no-op generation the stale-target
	 * tests and the per-block delete's still-present pin rely on (the
	 * landed judgment must see the survivors it refuses on). */
	cascadeDelete?: boolean;
}

/** Kernel stub with a SQL router over every write-flow route. Verified rows
 * default to a well-formed minted row unless the test pins the read (empty
 * array = missing row → fail-loud). The returned `childrenFor` map is live.
 * Unseeded ids read `fallbackChildren` (default [] — childless; create
 * tests seed it deliberately). */
function writeKernelStub(config: StubConfig = {}) {
	const calls: { method: string; args: unknown }[] = [];
	const tx = [{ doOperations: [{ id: "b-new" }] }];
	// Defensive copy: the mint registers the created doc into this table
	// (the live tree), so a test-supplied fixture object (e.g. a shared
	// DOC_ROOTS constant) must not be mutated across tests.
	const docRoots: NonNullable<StubConfig["docRoots"]> = structuredClone(
		config.docRoots ?? {
			"d-doc": {
				content: "Docker Networking",
				hpath: "/Docker Networking",
			},
		},
	);
	const childrenFor: Record<string, unknown[]> = JSON.parse(
		JSON.stringify(config.childrenFor ?? {}),
	);
	// Defensive copy: fallback rows are never live — a test mutating a walked
	// row must not reach other tests sharing the same constant (e.g.
	// DEFAULT_CHILDREN). Per-doc live seeds go through `childrenFor`.
	const fallbackChildren: Record<string, unknown>[] = JSON.parse(
		JSON.stringify(config.fallbackChildren ?? []),
	);
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
	let childErrorFrom: number | undefined;
	let childError: Error | undefined;
	let childCalls = 0;
	config.armChildErrorFrom?.((from, err) => {
		childErrorFrom = from;
		childError = err;
	});
	let hPathError: Error | undefined;
	config.armHPathError?.((err) => {
		hPathError = err;
	});
	let versionError: Error | undefined;
	config.armVersionError?.((err) => {
		versionError = err;
	});
	const transactError = config.transactError;
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
	/** Apply a move op with the kernel's own addressing semantics over the
	 * live children map: the op's row leaves its current sibling list and
	 * lands immediately before `nextID` / after `previousID` / prepended to
	 * `parentID`'s children. An absent id silently no-ops (the kernel's
	 * absent-id arm); `transactMoveSkips` no-ops an id for the
	 * silent-rollback shape. */
	// Rehearses the kernel's raw-op move addressing (nextID/previousID/
	// parentID semantics and order) so unit tests can exercise the batch
	// sequences without a kernel. Its authority is the primitives' live
	// suite — a divergence from the real kernel reads green here.
	const applyMoveOp = (
		op: Parameters<
			WriteKernelClient["transact"]
		>[0][number]["doOperations"][number],
	): void => {
		const id = String(op.id);
		if (config.transactMoveSkips?.(id)) return;
		const findList = (
			aId: string,
		): { id?: string; content?: string }[] | undefined => {
			for (const rows of Object.values(childrenFor)) {
				if (rows.some((row) => (row as { id?: string }).id === aId)) {
					return rows as { id?: string }[];
				}
			}
			return undefined;
		};
		const from = findList(id);
		if (from === undefined) return;
		const at = from.findIndex((row) => (row as { id?: string }).id === id);
		const row = from.splice(at, 1)[0];
		if (row === undefined) return;
		const nextID = op.nextID == null ? "" : String(op.nextID);
		const previousID = op.previousID == null ? "" : String(op.previousID);
		const parentID = op.parentID == null ? "" : String(op.parentID);
		if (nextID !== "") {
			// Fail loud on an unresolvable/self anchor — silently re-homing
			// the op would let a mis-anchored write read green.
			if (nextID === id) throw new Error("stub: self-anchoring move op");
			const to = findList(nextID);
			if (to === undefined)
				throw new Error(`stub: anchor '${nextID}' not found`);
			const target = to.findIndex((r) => (r as { id?: string }).id === nextID);
			if (target < 0) throw new Error(`stub: anchor '${nextID}' not found`);
			to.splice(target, 0, row);
		} else if (previousID !== "") {
			if (previousID === id) throw new Error("stub: self-anchoring move op");
			const to = findList(previousID);
			if (to === undefined) {
				throw new Error(`stub: anchor '${previousID}' not found`);
			}
			const target = to.findIndex(
				(r) => (r as { id?: string }).id === previousID,
			);
			if (target < 0) {
				throw new Error(`stub: anchor '${previousID}' not found`);
			}
			to.splice(target + 1, 0, row);
		} else if (parentID !== "") {
			const rows = (childrenFor[parentID] ??= []) as { id?: string }[];
			rows.unshift(row);
		}
	};
	const client: WriteKernelClient = {
		baseUrl: "http://127.0.0.1:6806",
		getVersion: async () => {
			calls.push({ method: "getVersion", args: undefined });
			if (versionError) throw versionError;
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
				if (config.createdRows !== undefined) return config.createdRows;
				// The unpinned default derives from the live docRoots table —
				// the by-ID read sees the minted doc, whatever title it minted
				// under. No row for the id = missing row (fail-loud).
				const docId = stmtDocId(stmt);
				const root = docId === undefined ? undefined : docRoots[docId];
				if (docId === undefined || root === undefined) return [];
				return [
					{
						id: docId,
						root_id: docId,
						content: root.content,
						hpath: root.hpath,
						updated: "20260101120000",
					},
				];
			}
			throw new Error(`stub has no route for: ${stmt}`);
		},
		async fullTextSearch() {
			throw new Error("write flow never searches");
		},
		async getHPathByID(id) {
			calls.push({ method: "getHPathByID", args: id });
			if (hPathError) throw hPathError;
			// The live-tree hpath the doc-move landed judgment and the create
			// flow's ground-truth asserts compare against — derived from the
			// same docRoots table the ownership and echo routes serve. An id
			// absent from the live tree is a vanished doc: the kernel's
			// tree-not-found error, never a fabricated value (an invented hpath
			// turns a missing fixture into a plausible-looking kernel mismatch).
			const root = docRoots[id];
			if (root === undefined) {
				throw new SiYuanApiError(-1, -1, "tree not found");
			}
			return root.hpath;
		},
		async getChildBlocks(id) {
			calls.push({ method: "getChildBlocks", args: id });
			if (walkError) throw walkError;
			childCalls += 1;
			if (childErrorFrom !== undefined && childCalls >= childErrorFrom) {
				throw childError;
			}
			return (childrenFor[id] ?? fallbackChildren) as Record<string, unknown>[];
		},
		async createDocWithMarkdown(params) {
			calls.push({ method: "createDocWithMarkdown", args: params });
			config.onCreate?.();
			// The kernel mints the doc into the live tree synchronously: the
			// post-mint hpath read-back sees the mint address over the stored
			// title. A test may pre-seed the returned id (a live-tree divergence
			// the title-normalization assert must catch); the seed wins.
			const path = String(params.path);
			docRoots["d-new"] ??= {
				content: path.split("/").pop() ?? "",
				hpath: path,
			};
			return "d-new";
		},
		async updateBlock(params) {
			calls.push({ method: "updateBlock", args: params });
			config.onUpdate?.();
			// The kernel applies the update synchronously to the tree and the
			// blocks index converges behind its periodic flush — the stub
			// mirrors the `content` column only, so a markdown/subType-only
			// edit would still read as pre-write and needs a case-supplied
			// hook (the primitives' editStub has one for that reason).
			for (const row of config.blockRows ?? []) {
				if ((row as { id?: string }).id === params.id) {
					(row as { content: string }).content = params.data;
				}
			}
			// The live tree converges too (content only) — the
			// fresh-content precondition and the write-result outline read
			// it as the source of truth.
			for (const rows of Object.values(childrenFor)) {
				const row = (rows as { id?: string; content?: string }[]).find(
					(r) => r.id === params.id,
				);
				if (row !== undefined) row.content = params.data;
			}
			// The edit's judgment reads the tree — the ack/echo is not
			// evidence, so nothing is returned here.
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
		async transact(transactions) {
			calls.push({ method: "transact", args: transactions });
			if (transactError) throw transactError;
			config.onTransact?.(transactions);
			// The batch lands whole (the commit-wait fact): every delete op
			// prunes its id, `transactPrune` returning false simulating the
			// sub-cliff silent no-op, and an id no longer indexed no-ops too —
			// the kernel's absent-id arm, never an error below the cliff. Move
			// ops apply in issue order with the kernel's own addressing
			// semantics (insert-before `nextID`, after `previousID`, prepend
			// `parentID`) over the live children map; `transactMoveSkips`
			// no-ops them for the silent-rollback shape.
			for (const tx of transactions) {
				for (const op of tx.doOperations) {
					if (op.action === "move") {
						applyMoveOp(op);
						continue;
					}
					if (op.action !== "delete") {
						throw new Error(
							`write stub applies only delete and move ops, got: ${op.action}`,
						);
					}
					const id = String(op.id);
					if (config.transactPrune?.(id) === false) continue;
					removeIndexed(id);
				}
			}
			// The kernel's echo is a hint, never evidence — the stub serves an
			// empty one (nothing consumes it).
			return [];
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
	markdown: string = content,
): WalkedBlock {
	return { id, type, subType, content, markdown, parentId, parentType };
}

/** The default create-flow tree (one heading) — tests that assert outline
 * or block content off an unseeded id seed it via `fallbackChildren`. */
export const DEFAULT_CHILDREN: Record<string, unknown>[] = [
	{ id: "h1", type: "h", subType: "h1", content: "Heading" },
];

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

/** The served baseline's hash for `blockId`, or undefined when the
 * baseline is absent or never-served — the compact assertion form for
 * suites pinning seeding; assert the full verdict shape only where the
 * kind itself is the claim. */
export function servedHash(
	baselines: ContentBaselines,
	blockId: string,
): string | undefined {
	const verdict = baselines.servedBaseline(blockId);
	return verdict.kind === "served" ? verdict.hash : undefined;
}

// The mode list derives from the authority's own unsupported-mode
// message, so neither side of an invariant can go stale independently.
export function modeList(): string[] {
	const unsupported = modeVerdict({
		kb: "k",
		mode: "bogus",
	} as unknown as WriteParams);
	const modes =
		(unsupported.ok ? "" : unsupported.message).split(": ")[1]?.split(", ") ??
		[];
	expect(modes.length).toBeGreaterThan(0);
	return modes;
}

export const base = {
	kb: "recipes",
	mode: "create",
	topic: "Docker Networking",
	markdown: "some body",
};

/** The edit suites' one-block doc: a single paragraph `b-1` under `d-doc`,
 * holding `content` in the index and `walkContent` (default: `content`) in
 * the tree — fresh arrays per call, since the harness mutates in place. */
export function editDoc(content: string, walkContent: string = content) {
	return {
		blockRows: [{ id: "b-1", content }],
		childrenFor: { "d-doc": [walkBlock("b-1", "p", "", walkContent)] },
	};
}

export const editBase = {
	kb: "recipes",
	mode: "edit",
	docId: "d-doc",
	blockId: "b-1",
	markdown: "corrected body",
};

/** The delete suites' section-bearing doc: a heading (h1) whose members
 * include a deeper heading and its body (h2/p2 — tree siblings under the
 * doc; the section rule is document-order, outline ownership), bounded by
 * a same-level heading (h3). Delete set: members [p1, h2, p2] in document
 * order, then h1. */
export const DELETE_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "nested body"),
		walkBlock("h3", "h", "h1", "Next"),
	],
};

/** A chain of `n` nested unnamed containers under `root` — past the walk
 * depth bound (MAX_WALK_DEPTH = 32) when `n` is deep enough, so a walk
 * that reaches the chain comes back truncated. */
export function nestChain(
	childrenFor: Record<string, unknown[]>,
	root: string,
	n: number,
): void {
	let parent = root;
	for (let i = 0; i < n; i++) {
		const id = `n${i}`;
		childrenFor[parent] = [{ id, type: "", subType: "", content: "" }];
		parent = id;
	}
	childrenFor[parent] = [];
}

export const SECTION_DOC = {
	// A heading's getChildBlocks answer is its section: following siblings
	// up to the next heading of same-or-higher level. The walk reads the
	// whole doc through the `d-doc` loop — it never recurses into `h`.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "body one"),
		walkBlock("h2", "h", "h2", "Details"),
		walkBlock("p2", "p", "", "body two"),
	],
};

export const REPLACE_DOC = {
	// The boundary heading is same-level (h1): the section is [p1, p2] — the
	// same-or-shallower pin (deeper headings would belong to the section).
	// Kernel-shaped heading sections (see SECTION_DOC): the delete set must
	// stay the enumerated section, never the heading's answer re-emitted.
	"d-doc": [
		walkBlock("h1", "h", "h1", "Goals"),
		walkBlock("p1", "p", "", "old one"),
		walkBlock("p2", "p", "", "old two"),
		walkBlock("h2", "h", "h1", "Details"),
		walkBlock("p3", "p", "", "tail"),
	],
};

export const replaceParams = {
	kb: "recipes",
	mode: "replace-section",
	docId: "d-doc",
	headingId: "h1",
	markdown: "rewritten section",
};

/** Shared assertions for the outcome-unverified contract, both classes:
 * a transport-class failure on the mutation call itself (the kernel's
 * response never arrived) and a drop after the write landed (the
 * post-write verification reads failed). Both must read as
 * verificationFailed — never runKbCall's "SiYuan unreachable", whose
 * retry invitation would duplicate an applied write. The transport
 * classification itself (timeout vs fetch reject) is falsified down-repo in
 * the primitives' failure suite; one wording case per site here. */
export function expectUnverified(r: Record<string, unknown>): void {
	expect(r.status).toBe("error");
	expect(r.verificationFailed).toBe(true);
	expect(r.message).toContain("outcome is unverified");
	expect(r.message).toContain("do NOT retry blindly");
	expect(r.message).not.toContain("SiYuan unreachable");
}

/** The standard two-doc roots table — shared by the move suites (the
 * docs' titles/hpaths never vary; only the block trees do). */
export const MOVE_DOC_ROOTS = {
	"d-doc": {
		content: "Docker Networking",
		hpath: "/Docker Networking",
	},
	"d-other": { content: "Other doc", hpath: "/Other doc" },
};

/** The move suites' standard two-doc block tree (also the default tree
 * `moveHarness` hands the stub). h1's kernel-shaped
 * heading section (see SECTION_DOC). */
export const MOVE_DOC = {
	"d-doc": [
		walkBlock("h1", "h", "h1", "A"),
		walkBlock("p1", "l", "u", "mover"),
		walkBlock("p2", "p", "", "stay"),
	],
	h1: [walkBlock("p1", "l", "u", "mover"), walkBlock("p2", "p", "", "stay")],
	"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
};

/** The section-move suites' base two-doc tree: a source section hH(H)+p1
 * and a destination section oh1(Dest)+o1 closed by a trailing oh2(Tail).
 * Fresh arrays per call — the harness and its stub hooks mutate the tree
 * in place, so every case needs its own copy. */
export function sectionMoveTrees() {
	return {
		"d-doc": [walkBlock("hH", "h", "h1", "H"), walkBlock("p1", "p", "", "m1")],
		"d-other": [
			walkBlock("oh1", "h", "h1", "Dest"),
			walkBlock("o1", "p", "", "o1"),
			walkBlock("oh2", "h", "h1", "Tail"),
		],
	};
}

/** move harness where `apply` mutates the children map kernel-side. */
export function moveHarness(apply?: () => void, stub?: Partial<StubConfig>) {
	return setup({
		config: {
			blockRows: [{ id: "p1", content: "mover" }],
			childrenFor: JSON.parse(JSON.stringify(MOVE_DOC)),
			docRoots: MOVE_DOC_ROOTS,
			...(apply ? { onMove: apply } : {}),
			...stub,
		},
	});
}
