// writeSchema tests — the kb_write tool schema, the mode-target shape
// table, and the description doctrine lines that enumerate the modes.

import { describe, expect, it } from "vitest";
import { modeVerdict, writeSchema, WriteParams } from "../../writeSchema.js";
import {
	base,
	editBase,
	modeList,
	registerKbWrite,
	setup,
} from "./writeHarness.js";

// The verdict's message half — the rejection table asserts the refusal
// strings themselves.
const refusalOf = (p: WriteParams): string | undefined => {
	const v = modeVerdict(p);
	return v.ok ? undefined : v.message;
};

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
		// mode's allowed set would be rejected by modeVerdict for every
		// mode — the surface fails silently until someone exercises it by
		// hand.
		const modes = modeList();
		const commonKeys = new Set(["kb", "mode", "markdown", "markdownFile"]);
		for (const key of Object.keys(writeSchema.properties)) {
			if (commonKeys.has(key)) continue;
			const accepted = modes.some((mode) => {
				const problem = refusalOf({
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
			{ kb: "r", mode: "delete-section", docId: "d" } as WriteParams,
			"mode 'delete-section' requires headingId",
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
			{
				kb: "r",
				mode: "delete-section",
				docId: "d",
				headingId: "h",
				markdown: "x",
			},
			"mode 'delete-section' does not take: markdown",
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
			{
				kb: "r",
				mode: "append",
				docId: "d",
				// Invalid on purpose: the schema narrows placement, so the
				// runtime refusal's input rides a double cast.
				placement: "sideways" as unknown as "section-end",
			},
			'placement must be "section-end" or "section-start"',
		],
		[
			{ kb: "r", mode: "append", docId: "d", placement: "section-end" },
			"placement requires headingId — without a heading the append lands at doc end",
		],
	];
	it.each(cases)("rejects %# with the reason named", (params, expected) => {
		expect(refusalOf(params as WriteParams)).toContain(expected);
	});

	it("accepts every declared shape", () => {
		expect(modeVerdict(editBase as WriteParams)).toEqual({
			ok: true,
			mode: "edit",
			params: { docId: editBase.docId, blockId: editBase.blockId },
		});
		expect(refusalOf(editBase as WriteParams)).toBeUndefined();
		expect(
			refusalOf({ kb: "r", mode: "append", docId: "d" } as WriteParams),
		).toBeUndefined();
		expect(
			refusalOf({
				kb: "r",
				mode: "append",
				docId: "d",
				placement: "section-end",
				headingId: "h",
			} as WriteParams),
		).toBeUndefined();
		expect(
			refusalOf({
				kb: "r",
				mode: "append",
				docId: "d",
				placement: "section-start",
				headingId: "h",
			} as WriteParams),
		).toBeUndefined();
		expect(
			refusalOf({
				kb: "r",
				mode: "delete-section",
				docId: "d",
				headingId: "h",
			} as WriteParams),
		).toBeUndefined();
		expect(
			refusalOf({
				kb: "r",
				mode: "move",
				docId: "d",
				blockId: "b",
				toDocId: "t",
			} as WriteParams),
		).toBeUndefined();
		expect(
			refusalOf({
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

	// The widened section arm's capability statement: the description must
	// say what a heading blockId does — the whole section, plus the landing
	// semantics the mode rides: container-locality, the shallower refusal,
	// the batch's weight, the same-KB scope, and the same-level landing
	// (sibling-after, not nested).
	it("pins the widened section-move capability statement", () => {
		const description = registeredDescription();
		expect(description).toContain("WHOLE section");
		expect(description).toContain(
			"memberless heading moves as its single block",
		);
		expect(description).toContain(
			"re-nests the moved members into that container",
		);
		expect(description).toContain("strictly shallower");
		expect(description).toContain("heavy operation");
		expect(description).toContain("noSuchDoc");
		expect(description).toContain(
			"sibling section after it, not nested under it",
		);
	});

	// The widened semantics must be stated where the agent reads them: the
	// field descriptions of the params the agent fills, not only the tool
	// description prose — a heading blockId on move is section-scoped, and
	// a per-block reading of the field text would delete or move one
	// heading where the agent asked for the whole section.
	it("pins the widened move semantics on the blockId and toHeadingId field descriptions", () => {
		// TypeBox's static type omits `description`; it is present at runtime.
		const fieldDesc = (field: unknown): string =>
			(field as { description?: string }).description ?? "";
		expect(fieldDesc(writeSchema.properties.blockId)).toContain(
			"moves its WHOLE section",
		);
		expect(fieldDesc(writeSchema.properties.blockId)).toContain(
			"a non-heading block moves alone",
		);
		expect(fieldDesc(writeSchema.properties.toHeadingId)).toContain(
			"the section's end is the landing",
		);
	});
});
