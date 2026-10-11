// spill.ts unit coverage — file naming, and the inline-cut preview shape.

import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	inlineOrSpill,
	PREVIEW_CHARS,
	spillFile,
	spillFileName,
} from "../../spill.js";

// ---------------------------------------------------------------------------
// Spill + budgets
// ---------------------------------------------------------------------------

describe("spill budgets", () => {
	it("names spill files {tool}-{sha256-16hex} in the per-session dir", () => {
		const path = spillFile("sess-1", "kb_query", '[{"id":1}]', "jsonl");
		expect(path.startsWith(join(tmpdir(), "gnubrain", "sess-1"))).toBe(true);
		expect(spillFileName("kb_query", '[{"id":1}]', "jsonl")).toMatch(
			/^kb_query-[0-9a-f]{16}\.jsonl$/,
		);
		// Identical payloads dedupe to the same hash-named file.
		const again = spillFile("sess-1", "kb_query", '[{"id":1}]', "jsonl");
		expect(again).toBe(path);
	});
});

describe("inline-cut preview", () => {
	it("returns short content directly with no spill", () => {
		const result = inlineOrSpill("s", "kb_read", "short", "md");
		expect(result.inline).toBe("short");
		expect(result.spillPath).toBeUndefined();
	});

	it("falls back to a hard cut when the overflow has no newline within PREVIEW_CHARS", () => {
		const content = "x".repeat(PREVIEW_CHARS + 10);
		const { inline, spillPath } = inlineOrSpill("s", "kb_read", content, "md");
		expect(inline).toBe(content.slice(0, PREVIEW_CHARS));
		expect(inline).not.toContain("\n");
		expect(spillPath).toMatch(/kb_read-[0-9a-f]{16}\.md$/);
	});

	it("cuts long content at a newline boundary within PREVIEW_CHARS and spills the full text", () => {
		const line = "x".repeat(1000);
		const content = Array.from({ length: 12 }, () => line).join("\n");
		const sessionId = "perm-" + randomUUID();
		const { inline, spillPath } = inlineOrSpill(
			sessionId,
			"kb_read",
			content,
			"md",
		);
		expect(inline.length).toBeLessThanOrEqual(PREVIEW_CHARS + 1);
		// The cut lands on the newline boundary, not mid-line.
		expect(content.startsWith(inline)).toBe(true);
		expect(content.slice(inline.length, inline.length + 1)).toBe("\n");
		expect(spillPath).toMatch(/kb_read-[0-9a-f]{16}\.md$/);
		if (spillPath === undefined) throw new Error("expected a spill path");
		// The spill holds the full text, not the preview slice.
		expect(readFileSync(spillPath, "utf8")).toBe(content);
		// Spills carry full KB content — private at creation (0700 dir / 0600
		// file), not umask-default. POSIX stat fields only. A fresh session id
		// is required: mode applies only when the dir is created.
		const dir = join(tmpdir(), "gnubrain", sessionId);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(spillPath).mode & 0o777).toBe(0o600);
		rmSync(dir, { recursive: true, force: true });
	});
});
