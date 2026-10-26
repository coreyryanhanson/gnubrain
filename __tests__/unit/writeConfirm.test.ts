// writeConfirm tests — file-path input (markdown XOR markdownFile,
// read-once capture) and the per-KB per-interaction write grant: the
// tri-state dialog mapping, terminal non-answers, the dialog lock under
// concurrency, the native-timeout/abort dial, and the headless default-deny
// — executed through the registered kb_write tool via the shared harness.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionValidation } from "../../validation.js";
import {
	clearInteractionGrants,
	GRANT_OPTIONS,
	GRANT_SESSION,
	GRANT_YES,
} from "../../writeConfirm.js";
import { base, setup, validation } from "./writeHarness.js";

describe("markdownFile input", () => {
	it("errors on a missing file with zero kernel calls", async () => {
		const { execute, calls } = setup();
		const r = await execute({
			...base,
			markdown: undefined,
			markdownFile: "/nope/missing.md",
		});
		expect(r.status).toBe("error");
		expect(r.message).toContain("/nope/missing.md");
		expect(calls).toHaveLength(0);
	});

	it("reads the file before the probe gate — a bad path still fires zero kernel calls on an unreachable kernel", async () => {
		const v: SessionValidation = validation();
		v.probe = { verdict: "unreachable" };
		const { execute, calls } = setup({ validation: v });
		const r = await execute({
			...base,
			markdown: undefined,
			markdownFile: "/nope/missing.md",
		});
		expect(r.status).toBe("error");
		expect(r.message).toContain("/nope/missing.md");
		expect(calls).toHaveLength(0);
	});

	it("errors on a non-regular file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		try {
			const { execute } = setup();
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: dir,
			});
			expect(r.status).toBe("error");
			expect(r.message).toContain("not a regular file");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("errors when both markdown and markdownFile are passed", async () => {
		const { execute, calls } = setup();
		const r = await execute({ ...base, markdownFile: "/tmp/x.md" });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("exactly one");
		expect(calls).toHaveLength(0);
	});

	it("errors when neither is passed", async () => {
		const { execute, calls } = setup();
		const r = await execute({ ...base, markdown: undefined });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("exactly one");
		expect(calls).toHaveLength(0);
	});

	it("captures the file once at call start — mid-flow mutation never applies", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		const path = join(dir, "body.md");
		writeFileSync(path, "v1", "utf8");
		let reads = 0;
		try {
			const { execute, calls } = setup({
				readBodyFile: async (p) => {
					reads++;
					expect(reads).toBe(1);
					const content = readFileSync(p, "utf8");
					// Mid-flow mutation after the capture.
					writeFileSync(p, "v2-mutated", "utf8");
					return content;
				},
			});
			const r = await execute({
				...base,
				markdown: undefined,
				markdownFile: path,
			});
			expect(r.status).toBe("ok");
			const create = calls.find((c) => c.method === "createDocWithMarkdown");
			expect((create?.args as { markdown: string } | undefined)?.markdown).toBe(
				"v1",
			);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe("grant lifecycle", () => {
	it("Yes grants the turn — one dialog; later writes to the KB in the same interaction flow silently", async () => {
		const { execute, grantCalls } = setup();
		const first = await execute({ ...base });
		expect(first.status).toBe("ok");
		const second = await execute({ ...base });
		expect(second.status).toBe("ok");
		expect(grantCalls).toHaveLength(1);
		expect(grantCalls[0]?.options).toEqual(GRANT_OPTIONS);
		expect(grantCalls[0]?.title).toContain("'recipes'");
		expect(grantCalls[0]?.title).toContain("not a backup");
	});

	it("Always this session survives the interaction boundary — the settled clear leaves session grants", async () => {
		const { execute, grantCalls, grantState } = setup({
			select: async () => GRANT_SESSION,
		});
		const first = await execute({ ...base });
		expect(first.status).toBe("ok");
		clearInteractionGrants(grantState);
		const second = await execute({ ...base });
		expect(second.status).toBe("ok");
		expect(grantCalls).toHaveLength(1);
	});

	it("the turn grant clears at the interaction boundary — the next interaction prompts again", async () => {
		const { execute, grantCalls, grantState } = setup();
		await execute({ ...base });
		clearInteractionGrants(grantState);
		const next = await execute({ ...base });
		expect(next.status).toBe("ok");
		expect(grantCalls).toHaveLength(2);
	});

	it.each(["No", undefined, "Sure thing"])(
		"a non-answer (%p) denies the KB terminally — one dialog, reason write_denied, zero kernel calls, no second dialog in the interaction",
		async (answer) => {
			const { execute, grantCalls, calls } = setup({
				select: async () => answer,
			});
			const refused = await execute({ ...base });
			expect(refused.status).toBe("refused");
			expect(refused.reason).toBe("write_denied");
			expect(calls).toHaveLength(0);
			const again = await execute({ ...base });
			expect(again.status).toBe("refused");
			expect(again.reason).toBe("write_denied");
			expect(grantCalls).toHaveLength(1);
		},
	);

	it("the terminal denial message is the pinned string — no asserted cause, do-not-retry, next-message recovery", async () => {
		const { execute } = setup({ select: async () => "No" });
		const r = await execute({ ...base });
		expect(r.message).toContain(
			"no write grant for KB 'recipes' this interaction",
		);
		expect(r.message).toContain("declined, dismissed, or timed out");
		expect(r.message).toContain("Do not retry or rephrase a write to this KB");
		expect(r.message).toContain("next attempt the write after their reply");
		expect(r.message).not.toContain("declined by the user");
	});

	it("a denial is remembered in the turn-denial set — it never outlives the interaction", async () => {
		const { execute, grantState } = setup({ select: async () => "No" });
		const refused = await execute({ ...base });
		expect(refused.reason).toBe("write_denied");
		expect(grantState.turnDenials.has("recipes")).toBe(true);
		expect(grantState.sessionGrants.has("recipes")).toBe(false);
	});

	it("a thrown select fails closed — refused with the (dialog failed: …) suffix, zero kernel calls", async () => {
		const { execute, calls } = setup({
			select: () => {
				throw new Error("rpc dropped");
			},
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("refused");
		expect(r.reason).toBe("write_denied");
		expect(r.message).toContain("(dialog failed: rpc dropped)");
		expect(
			calls.filter((c) =>
				[
					"createDocWithMarkdown",
					"updateBlock",
					"insertBlock",
					"appendBlock",
					"deleteBlock",
				].includes(c.method),
			),
		).toHaveLength(0);
	});

	it("a thrown select releases the dialog lock — the denied KB stays terminal, a different ungranted KB opens its dialog", async () => {
		let calls = 0;
		const { execute, grantCalls } = setup({
			select: () => {
				calls++;
				if (calls === 1) throw new Error("rpc dropped");
				return Promise.resolve(GRANT_YES);
			},
			validation: validation({ scope: ["recipes", "projects"] }),
		});
		const refused = await execute({ ...base });
		expect(refused.reason).toBe("write_denied");
		const other = await execute({ ...base, kb: "projects" });
		expect(other.status).toBe("ok");
		expect(grantCalls).toHaveLength(2);
		// The denied KB stays terminal for the interaction.
		const still = await execute({ ...base });
		expect(still.reason).toBe("write_denied");
		expect(grantCalls).toHaveLength(2);
	});

	it("the tool's abort signal rides to select as opts.signal — an abort resolves undefined → terminal denial, lock released", async () => {
		const controller = new AbortController();
		const { execute, grantCalls } = setup({
			validation: validation({ scope: ["recipes", "projects"] }),
			abortController: controller,
			select: (title, _o, opts) =>
				new Promise<string | undefined>((resolve) => {
					if (title.includes("projects")) {
						resolve(GRANT_YES);
						return;
					}
					opts?.signal?.addEventListener("abort", () => resolve(undefined));
				}),
		});
		const pending = execute({ ...base });
		// Let the dialog open, then abort exactly as pi would on run abort:
		// pi force-resolves the dialog to undefined, which lands in the
		// single terminal denial.
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		const refused = await pending;
		expect(refused.reason).toBe("write_denied");
		// The next write to a different KB prompts normally — no wedged lock.
		const other = await execute({ ...base, kb: "projects" });
		expect(other.status).toBe("ok");
		expect(grantCalls).toHaveLength(2);
	});

	it("writeConfirmTimeout feeds pi's native timeout in ms — seconds × 1000; 0 passes no option", async () => {
		const timed = setup({
			validation: validation({ settings: { writeConfirmTimeout: 2 } }),
		});
		await timed.execute({ ...base });
		expect(timed.grantCalls[0]?.opts?.timeout).toBe(2000);

		const untimed = setup({
			validation: validation({ settings: { writeConfirmTimeout: 0 } }),
		});
		await untimed.execute({ ...base });
		expect(untimed.grantCalls[0]?.opts?.timeout).toBeUndefined();
		expect(untimed.grantCalls[0]?.opts?.signal).toBeUndefined();

		const defaulted = setup();
		await defaulted.execute({ ...base });
		expect(defaulted.grantCalls[0]?.opts?.timeout).toBe(60_000);
	});

	it("two concurrent writes to the same ungranted KB open exactly one dialog and share the verdict", async () => {
		let release: ((v: string) => void) | undefined;
		const gated = new Promise<string>((resolve) => {
			release = resolve;
		});
		const { execute, grantCalls } = setup({ select: () => gated });
		const a = execute({ ...base });
		const b = execute({ ...base });
		// Both writes settle into the lock (one in the dialog, one queued
		// behind it) before the verdict releases.
		await new Promise((r) => setTimeout(r, 5));
		release?.(GRANT_YES);
		expect((await a).status).toBe("ok");
		expect((await b).status).toBe("ok");
		expect(grantCalls).toHaveLength(1);
	});

	it("two concurrent writes to different ungranted KBs produce two sequential dialogs, never overlapping", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const { execute, grantCalls } = setup({
			validation: validation({ scope: ["recipes", "projects"] }),
			select: async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				return GRANT_YES;
			},
		});
		const [a, b] = await Promise.all([
			execute({ ...base, kb: "recipes" }),
			execute({ ...base, kb: "projects" }),
		]);
		expect(a.status).toBe("ok");
		expect(b.status).toBe("ok");
		expect(grantCalls).toHaveLength(2);
		expect(maxInFlight).toBe(1);
	});
});

describe("headless default-deny", () => {
	it("refuses with no UI and allowUnattendedWrites absent — zero select/kernel calls", async () => {
		const { execute, grantCalls, calls } = setup({ hasUI: false });
		const r = await execute({ ...base });
		expect(r.status).toBe("refused");
		expect(r.message).toContain(
			"no UI is available to grant the write (headless session)",
		);
		expect(r.message).toContain("allowUnattendedWrites");
		expect(grantCalls).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});

	it("a denied write pays no probe retry on an unreachable kernel", async () => {
		const v: SessionValidation = validation();
		v.probe = { verdict: "unreachable" };
		const { execute, calls } = setup({ hasUI: false, validation: v });
		const r = await execute({ ...base });
		expect(r.status).toBe("refused");
		expect(r.message).toContain("allowUnattendedWrites");
		expect(calls).toHaveLength(0);
	});

	it("refuses with no UI and allowUnattendedWrites: false", async () => {
		const { execute } = setup({
			hasUI: false,
			validation: validation({ settings: { allowUnattendedWrites: false } }),
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("refused");
	});

	it("allowUnattendedWrites: true proceeds unattended — dialog skipped in a headless session", async () => {
		const { execute, grantCalls, calls } = setup({
			hasUI: false,
			validation: validation({ settings: { allowUnattendedWrites: true } }),
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("ok");
		expect(grantCalls).toHaveLength(0);
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});

	it("allowUnattendedWrites: true skips the dialog in an interactive session too", async () => {
		const { execute, grantCalls, calls } = setup({
			hasUI: true,
			validation: validation({ settings: { allowUnattendedWrites: true } }),
		});
		const r = await execute({ ...base });
		expect(r.status).toBe("ok");
		expect(grantCalls).toHaveLength(0);
		expect(calls.some((c) => c.method === "createDocWithMarkdown")).toBe(true);
	});
});

describe("one answered dialog per interaction, even while the kernel is down", () => {
	it("a turn grant survives a probe-refused write — an in-turn retry opens no second dialog", async () => {
		const v = validation({ probe: { verdict: "unreachable" } });
		const harness = setup({ validation: v });
		harness.client.getVersion = async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:6806");
		};
		const first = await harness.execute({ ...base });
		expect(first.status).toBe("refused");
		expect(first.message).toContain("SiYuan unreachable");
		expect(harness.grantCalls).toHaveLength(1);
		// The turn grant is already spent on the refused attempt: the retry
		// rides it — one answered dialog per interaction is the worst case.
		const retry = await harness.execute({ ...base });
		expect(retry.status).toBe("refused");
		expect(retry.message).toContain("SiYuan unreachable");
		expect(harness.grantCalls).toHaveLength(1);
	});
});
