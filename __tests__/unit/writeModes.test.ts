// writeModes tests — the tool schema + mode-target shape, the
// fresh-content precondition, the description doctrine lines, and the
// transport-failure envelopes — executed through the registered kb_write
// definition on a fake-pi harness with a SQL-routed kernel stub.

import { describe, expect, it } from "vitest";
import {
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
	contentHash,
} from "siyuan-kb-primitives";
import {
	modeShapeProblem,
	writeSchema,
	WriteParams,
} from "../../writeSchema.js";
import {
	REPLACE_DOC,
	StubConfig,
	base,
	editBase,
	expectUnverified,
	registerKbWrite,
	replaceParams,
	setup,
	walkBlock,
	writeKernelStub,
} from "./writeHarness.js";
import { ContentBaselines } from "../../baselines.js";
import { freshContentRefusal } from "../../writeFresh.js";

// The mode list derives from the authority's own unsupported-mode
// message, so neither side of an invariant can go stale independently.
function modeList(): string[] {
	const unsupported = modeShapeProblem({
		kb: "k",
		mode: "bogus",
	} as unknown as WriteParams);
	const modes = (unsupported ?? "").split(": ")[1]?.split(", ") ?? [];
	expect(modes.length).toBeGreaterThan(0);
	return modes;
}

describe("kb_write schema", () => {
	it("does not declare confirmNew (learned only from rejections)", () => {
		const { tool } = setup();
		const props = Object.keys(
			(tool.parameters as { properties: Record<string, unknown> }).properties,
		);
		expect(props).toContain("kb");
		expect(props).toContain("mode");
		expect(props).not.toContain("confirmNew");
	});

	it("declares every schema key as accepted by at least one mode", () => {
		// Invariant: a key declared in the tool schema but absent from every
		// mode's allowed set would be rejected by modeShapeProblem for every
		// mode — the surface fails silently until someone exercises it by
		// hand.
		const modes = modeList();
		const base = new Set(["kb", "mode", "markdown", "markdownFile"]);
		for (const key of Object.keys(writeSchema.properties)) {
			if (base.has(key)) continue;
			const accepted = modes.some((mode) => {
				const problem = modeShapeProblem({
					kb: "k",
					mode,
					[key]: key === "doc" ? true : "x",
				} as unknown as WriteParams);
				return problem === undefined || !problem.includes("does not take");
			});
			expect(accepted, `key '${key}' rejected by every mode`).toBe(true);
		}
	});

	it("rejects kb: 'kbs' via the existing unknown-KB rejection — zero kernel calls", async () => {
		const { execute, calls } = setup();
		const r = await execute({ ...base, kb: "kbs" });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("unknown KB 'kbs'");
		expect(calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// freshContentRefusal — the per-arm session doctrine over the primitives'
// checkFreshContent judgment, driven directly on the stubbed kernel
// ---------------------------------------------------------------------------

describe("freshContentRefusal", () => {
	const ctx = { sessionId: "s1", docId: "d-doc" };

	it("unseen → adopt the live form and proceed (null)", async () => {
		// No baseline, no SQL row: the session never served the block, so
		// there is no stored value to launder — the live form becomes the
		// baseline and the caller proceeds.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "live body")] },
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("live body"));
	});

	it("seed-and-check fresh → remember (the baseline is seeded even when every arm is fresh)", async () => {
		// No baseline, but the SQL row matches the walk — the establish
		// side effect survives the promotion: the residual paths' later
		// checks compare like-for-like.
		const stub = writeKernelStub({
			childrenFor: { "d-doc": [walkBlock("p1", "p", "", "index form")] },
			baselineRows: [{ id: "p1", content: "index form" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBe(contentHash("index form"));
	});

	it("vanished → skipped (delete no-op class), no baseline remembered", async () => {
		// The classification (walk-absence before any SQL read, even with a
		// lingering blocks.content row inside the convergence window) is
		// falsified down-repo in the primitives' fresh.test.ts; this asserts
		// the wrapper's half — a `vanished` arm must not remember, so a
		// misclassification as `unseen` would fail the servedHash assertion.
		const stub = writeKernelStub({
			baselineRows: [{ id: "p1", content: "lingering index row" }],
		});
		const baselines = ContentBaselines.create();
		const verdict = await freshContentRefusal(
			stub.client,
			baselines,
			[{ blockId: "p1", baselineHash: undefined }],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(baselines.servedHash("p1")).toBeUndefined();
	});

	it("empty target list → null with zero kernel calls", async () => {
		const stub = writeKernelStub({});
		const verdict = await freshContentRefusal(
			stub.client,
			ContentBaselines.create(),
			[],
			ctx,
		);
		expect(verdict).toBeNull();
		expect(stub.calls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Mode-target shape (schema table) — zero kernel calls
// ---------------------------------------------------------------------------

describe("mode-target shape (schema table)", () => {
	const cases: [WriteParams, string][] = [
		[{ kb: "r", mode: "junk" } as WriteParams, "mode 'junk' is not supported"],
		// An inherited Object.prototype name: `in` would pass it, crashing the
		// validator on the fetched function instead of refusing the mode.
		[
			{ kb: "r", mode: "toString" } as WriteParams,
			"mode 'toString' is not supported",
		],
		[
			{ kb: "r", mode: "edit", docId: "d" } as WriteParams,
			"mode 'edit' requires blockId",
		],
		[
			{ kb: "r", mode: "replace-section", docId: "d" } as WriteParams,
			"mode 'replace-section' requires headingId",
		],
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", doc: true },
			"exactly one of blockId or doc: true",
		],
		[
			{ kb: "r", mode: "move", docId: "d", doc: true, toHeadingId: "h" },
			"toHeadingId is block-level only",
		],
		[
			{ kb: "r", mode: "move", docId: "d", blockId: "b" },
			"block-level move requires toDocId",
		],
		[
			{ kb: "r", mode: "edit", docId: "d", blockId: "b", topic: "x" },
			"mode 'edit' does not take: topic",
		],
		[
			{ kb: "r", mode: "move", docId: "d", blockId: "b", markdown: "x" },
			"mode 'move' does not take: markdown",
		],
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", markdownFile: "/x" },
			"mode 'delete' does not take: markdownFile",
		],
		[
			{ kb: "r", mode: "delete", docId: "d", blockId: "b", confirmNew: true },
			"mode 'delete' does not take: confirmNew",
		],
		[
			{
				kb: "r",
				mode: "move",
				docId: "d",
				blockId: "b",
				toDocId: "t",
				placement: "section-start",
			},
			"mode 'move' does not take: placement",
		],
		[
			{ kb: "r", mode: "append", docId: "d", placement: "sideways" },
			'placement must be "section-end" or "section-start"',
		],
	];
	it.each(cases)("rejects %# with the reason named", (params, expected) => {
		expect(modeShapeProblem(params as WriteParams)).toContain(expected);
	});

	it("accepts every declared shape", () => {
		expect(modeShapeProblem(editBase as WriteParams)).toBeUndefined();
		expect(
			modeShapeProblem({ kb: "r", mode: "append", docId: "d" } as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "append",
				docId: "d",
				placement: "section-end",
			} as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "append",
				docId: "d",
				placement: "section-start",
			} as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "move",
				docId: "d",
				blockId: "b",
				toDocId: "t",
			} as WriteParams),
		).toBeUndefined();
		expect(
			modeShapeProblem({
				kb: "r",
				mode: "create",
				topic: "t",
				confirmNew: true,
			} as WriteParams),
		).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Write-tool descriptions carry the pinned doctrine lines
// ---------------------------------------------------------------------------

describe("write-tool doctrine lines", () => {
	function registeredDescription(): string {
		const { tool } = registerKbWrite({
			getValidation: () => undefined,
			getKernel: () => undefined,
		} as never);
		return tool.description ?? "";
	}

	it("pins mint-by-title / consume-by-ID, echoed targets, tool-derived anchors, replace-first, and the kbs mirror", () => {
		const description = registeredDescription();
		expect(description).toContain("mint by title");
		expect(description).toContain("consume by ID");
		expect(description).toContain("never invented");
		expect(description).toContain("always tool-derived");
		expect(description).toContain("prefer edit/replace-section over append");
		expect(description).toContain("'kbs' is read-only");
	});

	it("names every mode in the description (each as a '<mode> —' entry, so a prose mention can't pass vacuously)", () => {
		const description = registeredDescription();
		for (const mode of modeList()) {
			expect(description).toContain(`${mode} —`);
		}
	});
});

// Network drop between a landed write and its post-write verification
// reads: the result must never read as "SiYuan unreachable" — that
// invites the blind retry that duplicates or re-applies the write.
// (The classification-is-falsified-down-repo note lives once, in the
// transport-failure describe below.)
describe("network drop after a landed write", () => {
	it("edit: post-write echo-read drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				armQueryError: (set) => {
					arm = set;
				},
				onUpdate: () => arm?.(new SiYuanNetworkError()),
			},
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).toContain("post-write verification reads failed");
		expect(r.message).toContain("do NOT retry blindly");
		expect(r.message).not.toContain("SiYuan unreachable");
		// The mutation itself landed — the failure is in the reads.
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	it("append: post-write verification drop → verificationFailed, not 'unreachable'", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				armQueryError: (set) => {
					arm = set;
				},
				onInsert: () => arm?.(new SiYuanNetworkError()),
			},
		});
		const r = await execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new section",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		expect(r.message).not.toContain("SiYuan unreachable");
		expect(
			calls.filter(
				(c) => c.method === "insertBlock" || c.method === "appendBlock",
			),
		).toHaveLength(1);
	});

	it("append: post-write WALK drop (getChildBlocks) → verificationFailed, not the 'rolled back silently' retry invitation", async () => {
		let arm: ((err: Error) => void) | undefined;
		const { execute, calls } = setup({
			config: {
				armWalkError: (set) => {
					arm = set;
				},
				onInsert: () => arm?.(new SiYuanNetworkError()),
			},
		});
		const r = await execute({
			kb: "recipes",
			mode: "append",
			docId: "d-doc",
			markdown: "new section",
		});
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBe(true);
		// The dangerous message: the write LANDED — a silent-rollback reading
		// invites the blind retry that duplicates it.
		expect(r.message).not.toContain("rolled back silently");
		expect(r.message).toContain("post-write verification reads failed");
		expect(
			calls.filter(
				(c) => c.method === "insertBlock" || c.method === "appendBlock",
			),
		).toHaveLength(1);
	});
});

// Transport-class failure ON the mutation call itself — the kernel's
// response never arrived, so the write may or may not have landed. The
// result must carry the outcome-unverified contract (never runKbCall's
// "SiYuan unreachable", whose retry invitation would duplicate an applied
// write), and auth-class failures must still propagate for the breaker.
describe("transport failure on the mutation call itself", () => {
	// One transport case per wording site: the classification (timeout vs
	// fetch reject) is falsified down-repo in the primitives' failure suite;
	// the tool-side contract is the wording, identical for both classes.
	it("edit: transport failure on updateBlock → outcome unverified, never 'unreachable'", async () => {
		const { execute, calls } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				onUpdate: () => {
					throw new SiYuanNetworkError();
				},
			},
		});
		const r = await execute(editBase);
		expectUnverified(r);
		expect(r.message).toContain("may already be applied");
		expect(calls.filter((c) => c.method === "updateBlock")).toHaveLength(1);
	});

	// One unverified contract per mutation method: the kernel's response
	// never arrived, so the write may or may not have landed. replace-
	// section's timeout fires on the insert, before the sweep, so no
	// partial-replace payload may exist and no delete ran.
	type TimeoutCase = {
		name: string;
		config: StubConfig;
		params: Record<string, unknown>;
		methods: string[];
		noSweep?: boolean;
	};
	const timeoutCases: TimeoutCase[] = [
		{
			name: "append: timeout on insertBlock",
			config: {
				onInsert: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: {
				kb: "recipes",
				mode: "append",
				docId: "d-doc",
				markdown: "new section",
			},
			methods: ["insertBlock", "appendBlock"],
		},
		{
			name: "replace-section: timeout on the insert — the sweep never ran",
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: replaceParams,
			methods: ["insertBlock", "appendBlock"],
			noSweep: true,
		},
		{
			name: "doc delete: timeout on removeDocByID",
			config: {
				onRemoveDoc: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: { kb: "recipes", mode: "delete", docId: "d-doc", doc: true },
			methods: ["removeDocByID"],
		},
		{
			name: "move: timeout on moveBlock",
			config: {
				blockRows: [{ id: "p1", content: "mover" }],
				childrenFor: {
					"d-doc": [
						walkBlock("h1", "h", "h1", "A"),
						walkBlock("p1", "l", "u", "mover"),
						walkBlock("p2", "p", "", "stay"),
					],
					h1: [walkBlock("p1", "l", "u", "mover")],
					"d-other": [walkBlock("oh1", "h", "h1", "Dest")],
				},
				docRoots: {
					"d-doc": {
						content: "Docker Networking",
						hpath: "/Docker Networking",
					},
					"d-other": { content: "Other doc", hpath: "/Other doc" },
				},
				onMove: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: {
				kb: "recipes",
				mode: "move",
				docId: "d-doc",
				blockId: "p1",
				toDocId: "d-other",
			},
			methods: ["moveBlock"],
		},
		{
			name: "doc move: timeout on moveDocsByID",
			config: {
				childrenFor: { "d-doc": [walkBlock("h1", "h", "h1", "A")] },
				docRoots: {
					"d-doc": {
						content: "Docker Networking",
						hpath: "/Docker Networking",
					},
				},
				onMove: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: { kb: "recipes", mode: "move", docId: "d-doc", doc: true },
			methods: ["moveDocsByID"],
		},
	];
	it.each(timeoutCases)(
		"$name → outcome unverified, never 'unreachable'",
		async ({ config, params, methods, noSweep }) => {
			const { execute, calls } = setup({ config });
			const r = await execute(params);
			expectUnverified(r);
			expect(calls.filter((c) => methods.includes(c.method))).toHaveLength(1);
			if (noSweep) {
				expect(r.partialReplace).toBeUndefined();
				expect(calls.filter((c) => c.method === "deleteBlock")).toHaveLength(0);
			}
		},
	);

	it("auth failures on a mutation still propagate for breaker counting", async () => {
		const { execute } = setup({
			config: {
				blockRows: [{ id: "b-1", content: "stale paragraph" }],
				onUpdate: () => {
					throw new SiYuanAuthError(401);
				},
			},
		});
		const r = await execute(editBase);
		expect(r.status).toBe("error");
		expect(r.verificationFailed).toBeUndefined();
		expect(r.message).toContain("auth rejected");
		expect(r.message).not.toContain("outcome is unverified");
	});
});
