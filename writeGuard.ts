// Title mint policy + the guard SQL that stops a create on an existing doc.
// Patterns are built from the kernel's stored content form — `blocks.content`
// carries the title verbatim (live-verified against the pinned 3.8.4 kernel:
// `A & B`, `say "hi"`, `a < b > c` all store unescaped; the HTML-escaped form
// lives only in the title IAL, `blocks.ial`, which the guard does not query).
// The near-match leg scans separator-variant prefixes, capped at
// GUARD_NEAR_CAP.

import { sqlString } from "./kernel.js";

/** LIKE-wildcard escaping for the guard patterns (ESCAPE '\\'): a literal
 * `%`/`_` in a title must not widen the match. */
function likeEscape(fragment: string): string {
	return fragment
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

/** Exact-leg pattern: the submitted title verbatim, LIKE-escaped. */
export function guardExactPattern(title: string): string {
	return likeEscape(title);
}

/** Near-match prefix variants: the title's separator runs canonicalized
 * to space / hyphen / underscore. The intentional `_` is LIKE-escaped like
 * any other wildcard (`docker\_networking%`). A separator-only title (no
 * words) has no variant to build, so it falls back to its own prefix —
 * never an empty leg list, which would emit malformed SQL (`AND ()`). */
export function guardNearPatterns(title: string): string[] {
	const words = title.split(/[ \-_]+/).filter((w) => w !== "");
	if (words.length === 0) {
		return [`${likeEscape(title)}%`];
	}
	// One-word titles produce three identical legs — dedupe.
	return [
		...new Set([" ", "-", "_"].map((sep) => `${likeEscape(words.join(sep))}%`)),
	];
}

/**
 * mint policy — the rejection set covers every transform the kernel's
 * `normalizeDocTitle` applies (superset claim, pinned live by the title
 * round-trip): any title that survives stores verbatim.
 */
export function validateMintTitle(
	raw: string,
): { ok: true; title: string } | { ok: false; message: string } {
	const title = raw.trim();
	if (title === "") {
		return {
			ok: false,
			message: "title is empty after trim — supply a non-empty title",
		};
	}
	if (title.includes("/")) {
		return {
			ok: false,
			message: `title '${title}' contains '/' — the tool builds the doc path itself; rephrase the title without '/'`,
		};
	}
	if ([...title].length > 512) {
		return {
			ok: false,
			message:
				"title exceeds 512 runes — the kernel silently truncates longer titles; shorten it",
		};
	}
	// eslint-disable-next-line no-control-regex
	if (/[\t\n\r\x00-\x1f\x7f]/.test(title)) {
		return {
			ok: false,
			message: `title '${title}' contains tab/newline/control characters — their stored form is unpredictable; rephrase the title`,
		};
	}
	return { ok: true, title };
}

/** Rows at a guard stop are few; the near-match scan is capped at 20. */
export const GUARD_NEAR_CAP = 20;

export interface GuardRow {
	id: string;
	root_id: string;
	content: string;
	updated: string;
}

export function toGuardRows(rows: Record<string, unknown>[]): GuardRow[] {
	return rows.map((r) => ({
		id: String(r.id),
		root_id: String(r.root_id),
		content: String(r.content),
		updated: String(r.updated ?? ""),
	}));
}

/** Shared guard-leg SELECT head — kernel stubs route on this prefix. */
export const GUARD_STMT_HEAD =
	"SELECT id, root_id, content, updated FROM blocks";

export function guardExactStmt(boxId: string, title: string): string {
	return (
		`${GUARD_STMT_HEAD} ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' ` +
		`AND content LIKE ${sqlString(guardExactPattern(title))} ESCAPE ${sqlString("\\")}`
	);
}

export function guardNearStmt(boxId: string, title: string): string {
	const legs = guardNearPatterns(title)
		.map((p) => `content LIKE ${sqlString(p)} ESCAPE ${sqlString("\\")}`)
		.join(" OR ");
	// LIMIT caps returned rows, not scan work (content has no index);
	// +1 so the caller can distinguish "exactly 20" from "20+".
	return (
		`${GUARD_STMT_HEAD} ` +
		`WHERE box = ${sqlString(boxId)} AND type = 'd' AND (${legs}) ` +
		`LIMIT ${GUARD_NEAR_CAP + 1}`
	);
}
