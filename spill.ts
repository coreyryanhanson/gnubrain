// result budgets — inline-cap + spill-file. Oversized results are written
// to disk in full, never truncated away; the inline result carries a
// newline-boundary preview plus a pointer. No cleanup machinery (decision
// record): spill files are hash-named in a per-session temp dir, wiped by the
// OS on reboot, and identical payloads dedupe by hash.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Shared limit constant: the injected query LIMIT default and the per-KB
 * search `pageSize`. */
export const RESULT_LIMIT = 64;
/** Inline preview budget, chars. */
export const PREVIEW_CHARS = 8000;
/** Outline lines that ride inline before the outline spills. */
export const OUTLINE_HEADINGS = 200;

/** `os.tmpdir()/gnubrain/<session-id>/` — per-session, so concurrent sessions
 * querying the same KB never collide. */
export function sessionSpillDir(sessionId: string): string {
	return join(tmpdir(), "gnubrain", sessionId);
}

/** `{tool}-{sha256-16hex}.{jsonl|md}` — hash of the full spilled content, so
 * identical payloads dedupe and names never collide. */
export function spillFileName(
	tool: string,
	content: string,
	ext: "jsonl" | "md",
): string {
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
	return `${tool}-${hash}.${ext}`;
}

/** Write a spill file and return its path. Creates the session dir on demand. */
export function spillFile(
	sessionId: string,
	tool: string,
	content: string,
	ext: "jsonl" | "md",
): string {
	const dir = sessionSpillDir(sessionId);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, spillFileName(tool, content, ext));
	writeFileSync(path, content, "utf8");
	return path;
}

/** The pointer line appended to inline previews. */
export function spillPointer(moreChars: number, path: string): string {
	return `… ${moreChars} more — full result in ${path}`;
}

/**
 * Inline-cut + spill: content within PREVIEW_CHARS returns directly;
 * overflow spills in full and the caller renders a newline-boundary preview
 * of PREVIEW_CHARS plus the pointer.
 */
export function inlineOrSpill(
	sessionId: string,
	tool: string,
	content: string,
	ext: "jsonl" | "md",
): { inline: string; spillPath?: string } {
	if (content.length <= PREVIEW_CHARS) return { inline: content };
	const path = spillFile(sessionId, tool, content, ext);
	let cut = content.lastIndexOf("\n", PREVIEW_CHARS);
	if (cut <= 0) cut = PREVIEW_CHARS;
	return { inline: content.slice(0, cut), spillPath: path };
}
