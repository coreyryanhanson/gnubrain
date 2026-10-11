// finishWrite's post-mutation contract: any builder failure after the
// kernel mutation acked must read as `verificationFailed`, never as the
// bare error envelope runKbCall would render from a rethrow.
import { describe, expect, it } from "vitest";

import { SiYuanRateLimitError } from "siyuan-kb-primitives";

import { markPartialReplace } from "../../envelope.js";
import { finishWrite } from "../../writeResult.js";

describe("finishWrite", () => {
	it("non-kernel builder failure → verificationFailed, never a bare rethrow", async () => {
		const result = await finishWrite("kb1", { docId: "d1" }, async () => {
			throw new Error("ENOSPC: no space left on device, write");
		});
		expect(result.status).toBe("error");
		expect(result.verificationFailed).toBe(true);
		expect(result.kb).toBe("kb1");
		expect(result.docId).toBe("d1");
		expect(result.message).toContain("ENOSPC: no space left on device");
		expect(result.message).toContain("do NOT retry blindly");
	});

	it("non-kernel builder failure carrying partial-apply state keeps the partial payload", async () => {
		const err = new Error("spill failed mid-sweep");
		markPartialReplace(err, {
			partialReplace: true,
			newBlockId: "n1",
			deletedBlockIds: ["a", "b"],
			remainingBlockIds: ["c"],
		});
		const result = await finishWrite("kb1", {}, async () => {
			throw err;
		});
		expect(result.verificationFailed).toBe(true);
		expect(result.partialReplace).toBe(true);
		expect(result.newBlockId).toBe("n1");
		expect(result.deletedBlockIds).toEqual(["a", "b"]);
		expect(result.remainingBlockIds).toEqual(["c"]);
		expect(result.message).toContain("partially applied");
	});

	it("auth/rate-limit errors rethrow for runKbCall's classification", async () => {
		await expect(
			finishWrite("kb1", {}, async () => {
				throw new SiYuanRateLimitError(429, 30);
			}),
		).rejects.toBeInstanceOf(SiYuanRateLimitError);
	});

	it("a successful builder returns its envelope untouched", async () => {
		const result = await finishWrite("kb1", {}, async () => ({
			status: "ok",
			message: "edited block b1",
		}));
		expect(result.status).toBe("ok");
		expect(result.verificationFailed).toBeUndefined();
	});
});
