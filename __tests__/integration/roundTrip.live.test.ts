// The kb_read → kb_write round-trip at the tool layer: the served body is
// body-only (no frontmatter bytes, no doc-title H1), so feeding it back to a
// write mode reproduces the doc instead of corrupting it. Seeded with
// frontmatter-derived attrs (doc-root IAL tags/custom-*) so the absence
// asserts are non-vacuous — an export-form read renders exactly that state
// as frontmatter bytes. The ref case names the refs index: the
// write-back must gain a genuine edge, not merely carry pointer bytes.
// Runs against the live pinned kernel over the shared fixtures; opt-in with
// SIYUAN_INTEGRATION=1, never in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sqlString, SiYuanKernelClient } from "siyuan-kernel-primitives";
import { CircuitBreaker } from "../../breaker.js";
import { ContentBaselines } from "../../baselines.js";
import { createFakeCtx, createFakePi } from "../helpers/fakePi.js";
import { registerReadToolsAndToolset } from "../../tools.js";
import { registerWriteToolAndToolset } from "../../write.js";
import { createWriteGrantState } from "../../writeConfirm.js";
import { type SessionValidation } from "../../validation.js";
import {
	BASE_URL,
	INTEGRATION,
	LIVE_TIMEOUT,
	TOKEN,
	mintDoc,
	pollUntil,
	setupFixtures,
	type IntegrationFixtures,
} from "./harness.js";

describe.skipIf(!INTEGRATION || TOKEN === "")("body round-trip", () => {
	let fixtures: IntegrationFixtures;
	let client: SiYuanKernelClient;
	const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
	let seq = 0;
	const unique = (stem: string): string => `${stem} ${stamp} ${++seq}`;

	beforeAll(async () => {
		fixtures = await setupFixtures();
		client = fixtures.client;
	}, LIVE_TIMEOUT);

	afterAll(async () => {
		if (fixtures === undefined) return;
		await fixtures.teardown();
	}, LIVE_TIMEOUT);

	function readSetup(validation: SessionValidation = fixtures.validation) {
		const { pi, runToolDetails } = createFakePi();
		registerReadToolsAndToolset(pi, {
			getValidation: () => validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			baselines: ContentBaselines.create(),
		});
		const { ctx } = createFakeCtx();
		return async (
			name: string,
			params: Record<string, unknown>,
		): Promise<Record<string, unknown> & { status: string }> =>
			runToolDetails(name, params, ctx);
	}

	function writeSetup(validation: SessionValidation = fixtures.validation) {
		const { pi, runToolDetails } = createFakePi();
		registerWriteToolAndToolset(pi, {
			getValidation: () => validation,
			getKernel: () => client,
			breaker: new CircuitBreaker(),
			grantState: createWriteGrantState(),
			baselines: ContentBaselines.create(),
		});
		const { ctx } = createFakeCtx({ select: async () => "Yes" });
		return async (
			params: Record<string, unknown>,
		): Promise<Record<string, unknown> & { status: string }> =>
			runToolDetails("kb_write", params, ctx);
	}

	/** Set doc-root IAL attrs — the state the UI's YAML frontmatter editing
	 * lands at (doc-level tags/custom-* ride IAL into the index). Raw fetch:
	 * the typed client deliberately keeps the attr surface out. */
	async function setDocAttrs(
		id: string,
		attrs: Record<string, string>,
	): Promise<void> {
		const res = await fetch(`${BASE_URL}/api/attr/setBlockAttrs`, {
			method: "POST",
			headers: {
				Authorization: `Token ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ id, attrs }),
		});
		expect(res.ok).toBe(true);
		// HTTP 200 can still carry a kernel-level failure (code != 0) — a
		// silently failed seed would make the absence asserts vacuous.
		const body = (await res.json()) as { code?: number };
		expect(body.code).toBe(0);
	}

	it(
		"read → create → re-read: the served body round-trips with no frontmatter bytes and no duplicate title",
		async () => {
			const titleA = unique("Roundtrip Source");
			const sourceBody = [
				"para one",
				"",
				"- item one",
				"  - nested under one",
				"- item two",
				"",
				"> quote line",
				"",
			].join("\n");
			const docA = await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/${titleA}`,
				sourceBody,
			);
			// Frontmatter-derived attrs, seeded so the absence asserts are
			// non-vacuous: an export-form read renders this state as YAML
			// frontmatter + title H1.
			await setDocAttrs(docA, {
				tags: "rttag1,rttag2",
				"custom-roundtrip": "rtvalue",
			});

			const read = readSetup();
			const first = await read("kb_read", {
				kb: "fixture-a",
				docId: docA,
			});
			expect(first.status).toBe("ok");
			const bodyA = String(first.content);
			// Body-only: no frontmatter bytes, none of the seeded
			// frontmatter-derived attr values, no doc-title H1 (the title is
			// the hpath echo's last segment).
			expect(bodyA.startsWith("---")).toBe(false);
			expect(bodyA).not.toContain("rttag");
			expect(bodyA).not.toContain("rtvalue");
			expect(bodyA).not.toContain(titleA);
			expect(String(first.hpath).split("/").pop()).toBe(titleA);
			// No empty leaf blocks seeded → no omission count.
			expect(first.omittedEmpty).toBeUndefined();

			const w = writeSetup();
			const titleB = unique("Roundtrip Paste");
			const created = await w({
				kb: "fixture-a",
				mode: "create",
				topic: titleB,
				markdown: bodyA,
			});
			expect(created.status).toBe("ok");
			const docB = String(created.docId);

			const second = await read("kb_read", {
				kb: "fixture-a",
				docId: docB,
			});
			expect(second.status).toBe("ok");
			const bodyB = String(second.content);
			// Stable round-trip: the re-read serves the same body the write
			// consumed (both sides render canonically-parsed trees).
			expect(bodyB).toBe(bodyA);
			// The two absences the bodyA asserts don't imply: no H1 line
			// (a pasted title would render as one), and not the new doc's
			// own title as a heading.
			expect(bodyB).not.toMatch(/^# /m);
			expect(bodyB).not.toContain(titleB);
			expect(String(second.hpath).split("/").pop()).toBe(titleB);
			expect(second.omittedEmpty).toBeUndefined();
		},
		LIVE_TIMEOUT,
	);

	it(
		"ref re-import: a read body's block ref write-back lands a genuine edge in the refs index",
		async () => {
			const targetTitle = unique("Ref Target");
			const targetDoc = await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/${targetTitle}`,
				"ref target para\n",
			);
			const targetRows = await client.query(
				`SELECT id FROM blocks WHERE root_id = ${sqlString(targetDoc)} AND type = 'p' LIMIT 1`,
			);
			const targetId = String(targetRows[0]!.id);

			const refTitle = unique("Ref Source");
			const refDoc = await mintDoc(
				client,
				fixtures.notebookIds.fixtureA,
				`/${refTitle}`,
				`para citing ((${targetId} "the target"))\n`,
			);

			const read = readSetup();
			const served = await read("kb_read", {
				kb: "fixture-a",
				docId: refDoc,
			});
			expect(served.status).toBe("ok");
			const body = String(served.content);
			// The ref renders in its stored pointer form — the id inside is
			// what the write-back feeds the kernel.
			expect(body).toContain(`((${targetId} "the target"))`);

			const w = writeSetup();
			const created = await w({
				kb: "fixture-a",
				mode: "create",
				topic: unique("Ref Paste"),
				markdown: body,
			});
			expect(created.status).toBe("ok");
			const pastedDoc = String(created.docId);

			// The refs index gains a genuine edge for the pasted ref — not
			// merely pointer bytes in the served body.
			let defs: string[] = [];
			await pollUntil(
				"the pasted ref reaching the refs index",
				async () => {
					const rows = await client.query(
						`SELECT def_block_id FROM refs WHERE root_id = ${sqlString(pastedDoc)}`,
					);
					defs = rows.map((r) => String(r.def_block_id));
					return defs.includes(targetId);
				},
				15_000,
			);
			expect(defs).toEqual([targetId]);

			// And the pointer survives a further read unchanged.
			const reRead = await read("kb_read", {
				kb: "fixture-a",
				docId: pastedDoc,
			});
			expect(reRead.status).toBe("ok");
			expect(String(reRead.content)).toContain(`((${targetId} "the target"))`);
		},
		LIVE_TIMEOUT,
	);
});
