// writeModes tests — the cross-mode transport-failure envelopes, executed
// through the registered kb_write definition on a fake-pi harness with a
// SQL-routed kernel stub. (Schema/mode-target shape live in
// writeSchema.test.ts; the fresh-content wrapper in writeFresh.test.ts.)

import { describe, expect, it } from "vitest";
import {
	SiYuanAuthError,
	SiYuanNetworkError,
	SiYuanTimeoutError,
} from "siyuan-kernel-primitives";
import {
	REPLACE_DOC,
	StubConfig,
	editBase,
	editDoc,
	expectUnverified,
	replaceParams,
	setup,
	walkBlock,
} from "./writeHarness.js";

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
				...editDoc("stale paragraph"),
				armQueryError: (set) => {
					arm = set;
				},
				onUpdate: () => arm?.(new SiYuanNetworkError()),
			},
		});
		const r = await execute(editBase);
		expectUnverified(r);
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
		expectUnverified(r);
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
		expectUnverified(r);
		// The dangerous message: the write LANDED — a silent-rollback reading
		// invites the blind retry that duplicates it.
		expect(r.message).not.toContain("rolled back silently");
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
				...editDoc("stale paragraph"),
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
	// section's timeout fires on the insert, before the delete batch, so no
	// partial-replace payload may exist and no delete ran.
	type TimeoutCase = {
		name: string;
		config: StubConfig;
		params: Record<string, unknown>;
		methods: string[];
		noDeleteLeg?: boolean;
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
			name: "replace-section: timeout on the insert — the delete batch never ran",
			config: {
				childrenFor: REPLACE_DOC,
				onInsert: () => {
					throw new SiYuanTimeoutError(30_000);
				},
			},
			params: replaceParams,
			methods: ["insertBlock", "appendBlock"],
			noDeleteLeg: true,
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
		async ({ config, params, methods, noDeleteLeg }) => {
			const { execute, calls } = setup({ config });
			const r = await execute(params);
			expectUnverified(r);
			expect(calls.filter((c) => methods.includes(c.method))).toHaveLength(1);
			if (noDeleteLeg) {
				expect(calls.filter((c) => c.method === "transact")).toHaveLength(0);
			}
		},
	);

	it("auth failures on a mutation still propagate for breaker counting", async () => {
		const { execute } = setup({
			config: {
				...editDoc("stale paragraph"),
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
