// result budgets — inline-cap + spill-file. Oversized results are written
// to disk in full, never truncated away; the inline result carries a
// newline-boundary preview plus a pointer. No cleanup machinery: spill
// files are hash-named in a per-session temp dir, wiped by the OS on
// reboot, and identical payloads dedupe by hash.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "./envelope.js";

/** Serialize rows as JSONL (the spill format for query/search/outline rows). */
export function jsonl(rows: unknown[]): string {
	return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** Inline preview budget, chars. */
export const PREVIEW_CHARS = 8000;
/** Outline lines that ride inline before the outline spills. */
export const OUTLINE_HEADINGS = 200;

/** `os.tmpdir()/gnubrain/<session-id>/` — per-session, so concurrent sessions
 * querying the same KB never collide. */
function sessionSpillDir(sessionId: string): string {
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
	// mode applies only at creation (content-hash names dedupe onto existing
	// files) and is umask-masked — 0o700/0o600 survive the default umask.
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, spillFileName(tool, content, ext));
	writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
	return path;
}

/** Cut at the last newline within budget; hard cut if none in range. */
function previewAtNewline(content: string, budget: number): string {
	let cut = content.lastIndexOf("\n", budget);
	if (cut <= 0) cut = budget;
	return content.slice(0, cut);
}

/** The pointer sentence for a spilled result — rides the envelope's
 * `message` tail beside `fullResultPath`, never inside the payload
 * preview: the payload bytes stay pure content (the paste-back stream). */
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
	return { inline: previewAtNewline(content, PREVIEW_CHARS), spillPath: path };
}

/**
 * Shared tail of every row-carrying envelope: within the inline budget the
 * rows ride the envelope under `key`; overflow spills the full JSONL and the
 * envelope keeps a newline-boundary preview plus the pointer instead.
 */
export function withRowPayload(
	envelope: Envelope,
	sessionId: string,
	tool: string,
	key: "rows" | "blockIds",
	kept: Record<string, unknown>[],
): Envelope {
	const text = jsonl(kept);
	const { inline, spillPath } = inlineOrSpill(sessionId, tool, text, "jsonl");
	if (spillPath === undefined) {
		envelope[key] = kept;
	} else {
		envelope.preview = inline;
		envelope.fullResultPath = spillPath;
	}
	return envelope;
}
