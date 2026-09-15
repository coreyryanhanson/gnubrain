// writeConfirm tests — file-path input (markdown XOR markdownFile,
// read-once capture), the write confirmation dialog branches (allow/decline/
// cancel/timeout/terminal), and the headless default-deny — executed
// through the registered kb_write tool via the shared harness.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionValidation } from "../../validation.js";
import { readBodyFile } from "../../writeConfirm.js";
import { base, setup, validation } from "./writeHarness.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("markdownFile input", () => {
	it("errors on a missing file with zero kernel calls", async () => {
		const { execute, kernel } = setup();
		const r = await execute({
			...base,
			markdown: undefined,
			markdownFile: "/nope/missing.md",
		});
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("/nope/missing.md");
		expect(kernel.calls).toHaveLength(0);
	});

	it("reads the file before the probe gate — a bad path still fires zero kernel calls on an unreachable kernel", async () => {
		const v: SessionValidation = validation();
		v.probe = "unreachable";
		const { execute, kernel } = setup({}, v);
		const r = await execute({
			...base,
			markdown: undefined,
			markdownFile: "/nope/missing.md",
		});
		expect(r.details.status).toBe("error");
		expect(r.details.message).toContain("/nope/missing.md");
		expect(kernel.calls).toHaveLength(0);
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
			expect(r.details.status).toBe("error");
			expect(r.details.message).toContain("not a regular file");
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("errors when both markdown and markdownFile are passed", async () => {
		const { execute, kernel } = setup();
		const r = await execute({ ...base, markdownFile: "/tmp/x.md" });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("exactly one");
		expect(kernel.calls).toHaveLength(0);
	});

	it("errors when neither is passed", async () => {
		const { execute, kernel } = setup();
		const r = await execute({ ...base, markdown: undefined });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("exactly one");
		expect(kernel.calls).toHaveLength(0);
	});

	it("captures the file once at call start — mid-flow mutation never applies", async () => {
		const dir = mkdtempSync(join(tmpdir(), "gnubrain-w-"));
		const path = join(dir, "body.md");
		writeFileSync(path, "v1", "utf8");
		let reads = 0;
		try {
			const { execute, kernel } = setup({
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
			expect(r.details.status).toBe("ok");
			const create = kernel.calls.find(
				(c) => c.method === "createDocWithMarkdown",
			);
			expect((create?.args as { markdown: string } | undefined)?.markdown).toBe(
				"v1",
			);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	it("readBodyFile — missing file throws a structured error naming the path", async () => {
		await expect(readBodyFile("/nope/missing.md")).rejects.toThrow(
			"/nope/missing.md",
		);
	});
});

describe("write confirmation", () => {
	it("proceeds when confirmed; explicit decline is recoverable", async () => {
		const confirm = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		const { execute } = setup({ confirm, hasUI: true });
		const declined = await execute({ ...base });
		expect(declined.details.status).toBe("refused");
		expect(confirm).toHaveBeenCalledTimes(1);
		// The decline answered nothing about the write itself — a re-ask is
		// legitimate, so the second call runs a fresh dialog.
		const allowed = await execute({ ...base });
		expect(allowed.details.status).toBe("ok");
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it("cancelled and timed-out confirms both refuse; timeout is terminal", async () => {
		vi.useFakeTimers();
		// A dialog the user never answers: resolves false on abort.
		const confirm = vi.fn(
			(_t: string, _m: string, opts: { signal?: AbortSignal }) =>
				new Promise<boolean>((resolve) => {
					opts.signal?.addEventListener("abort", () => resolve(false));
				}),
		);
		const { execute } = setup(
			{ confirm, hasUI: true, __config: {} },
			validation({ writeConfirmTimeout: 1 }),
		);
		const promise = execute({ ...base });
		await vi.advanceTimersByTimeAsync(1500);
		const timedOut = await promise;
		expect(timedOut.details.status).toBe("refused");
		expect(timedOut.details.reason).toBe("confirm_timeout");
		expect(confirm).toHaveBeenCalledTimes(1);

		// Re-request of the same write: immediate terminal refusal, no new dialog.
		const again = await execute({ ...base });
		expect(again.details.status).toBe("refused");
		expect(again.details.reason).toBe("confirm_timeout");
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("an explicit decline does not mark the write terminal", async () => {
		const confirm = vi.fn().mockResolvedValue(false);
		const { execute } = setup({ confirm, hasUI: true });
		await execute({ ...base });
		await execute({ ...base });
		// Both calls asked — a decline never arms the terminal refusal.
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it("timeout 0 issues an untimed confirm", async () => {
		vi.useFakeTimers();
		let seenOpts: { signal?: AbortSignal } | undefined;
		const confirm = vi.fn(
			(_t: string, _m: string, opts: { signal?: AbortSignal }) => {
				seenOpts = opts;
				return Promise.resolve(true);
			},
		);
		const { execute } = setup(
			{ confirm, hasUI: true },
			validation({ writeConfirmTimeout: 0 }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("ok");
		// No signal — the dialog is untimed and can never fire confirm_timeout.
		expect(seenOpts?.signal).toBeUndefined();
		// No timer was armed that could abort anything later.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(r.details.status).toBe("ok");
	});
});

describe("headless default-deny", () => {
	it("refuses with no UI and allowUnattendedWrites absent — zero confirm/kernel calls", async () => {
		const confirm = vi.fn();
		const { execute, kernel } = setup({ confirm, hasUI: false });
		const r = await execute({ ...base });
		expect(r.details.status).toBe("refused");
		expect(r.details.message).toContain("allowUnattendedWrites");
		expect(confirm).not.toHaveBeenCalled();
		expect(kernel.calls).toHaveLength(0);
	});

	it("refuses with no UI and allowUnattendedWrites: false", async () => {
		const { execute } = setup(
			{ hasUI: false },
			validation({ allowUnattendedWrites: false }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("refused");
	});

	it("allowUnattendedWrites: true proceeds unattended — dialog skipped", async () => {
		const confirm = vi.fn();
		const { execute, kernel } = setup(
			{ confirm, hasUI: false },
			validation({ allowUnattendedWrites: true }),
		);
		const r = await execute({ ...base });
		expect(r.details.status).toBe("ok");
		expect(confirm).not.toHaveBeenCalled();
		expect(kernel.calls.some((c) => c.method === "createDocWithMarkdown")).toBe(
			true,
		);
	});
});
