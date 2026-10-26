// Shared tool-path helpers for the write-pin live files — the kb_write /
// kb_read harnesses over the live fixture client and the walk/query
// projections the pins assert against. The write tools register with a
// fresh breaker, grant state, and baselines per call; the grant dialog is
// skipped via an auto-Yes ctx — the live suite drives the flows, not the
// dialog.
import { ContentBaselines } from "../../baselines.js";
import { CircuitBreaker } from "../../breaker.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import { registerWriteToolAndToolset } from "../../write.js";
import { createWriteGrantState } from "../../writeConfirm.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import {
	isHeadingBlock,
	sqlString,
	walkBlockTree,
} from "siyuan-kernel-primitives";
import { pollUntil, type IntegrationFixtures } from "./harness.js";

/** Binds the shared helpers to one file's fixtures. Call from `beforeAll`. */
export function makeWriteHelpers(fixtures: IntegrationFixtures) {
	const client = fixtures.client;
	const boxId = fixtures.notebookIds.fixtureA;

	/** kb_write over the live client. `baselines` lets a case share one map
	 * between the read and write tools (the fresh-content case's served
	 * baselines). */
	function writeSetup(
		opts: {
			baselines?: ContentBaselines;
		} = {},
	) {
		const { pi, runToolDetails } = createFakePi();
		registerWriteToolAndToolset(pi, {
			getValidation: () => fixtures.validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			grantState: createWriteGrantState(),
			baselines: opts.baselines ?? ContentBaselines.create(),
		});
		const { ctx } = createFakeCtx({ select: async () => "Yes" });
		return {
			run: async (
				params: Record<string, unknown>,
			): Promise<Record<string, unknown> & { status: string }> =>
				runToolDetails("kb_write", params, ctx),
		};
	}

	/** kb_read through the tool (the outline path that seeds served
	 * baselines). */
	function readSetup(baselines?: ContentBaselines) {
		const { pi, runToolDetails } = createFakePi();
		registerReadToolsAndToolset(pi, {
			getValidation: () => fixtures.validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			baselines: baselines ?? ContentBaselines.create(),
		});
		const { ctx } = createFakeCtx();
		return async (
			params: Record<string, unknown>,
		): Promise<Record<string, unknown> & { status: string }> =>
			runToolDetails("kb_read", params, ctx);
	}

	const paraId = async (docId: string, content: string): Promise<string> => {
		// The paragraph row lags the doc's ownership row — poll for it.
		await pollUntil(
			`paragraph '${content}' reaching the blocks index`,
			async () =>
				(
					await client.query(
						"SELECT id, content FROM blocks WHERE root_id = " +
							sqlString(docId) +
							" AND type = 'p' AND content = " +
							sqlString(content),
					)
				).length === 1,
		);
		const rows = await client.query(
			"SELECT id, content FROM blocks WHERE root_id = " +
				sqlString(docId) +
				" AND type = 'p' AND content = " +
				sqlString(content),
		);
		return String(rows[0]!.id);
	};

	const outlineIds = (outline: unknown): string[] =>
		[...String(outline).matchAll(/→ (\S+)/g)].map((m) => m[1]!);

	const walkHeadingIds = async (docId: string): Promise<string[]> =>
		(await walkBlockTree(client, docId)).blocks
			.filter((b) => isHeadingBlock(b))
			.map((b) => b.id);

	return {
		client,
		boxId,
		writeSetup,
		readSetup,
		paraId,
		outlineIds,
		walkHeadingIds,
	};
}
