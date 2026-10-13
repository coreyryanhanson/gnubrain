// Title mint policy — agent-facing wording over the primitives'
// `mintTitleProblem` (the kernel facts — the `/` path separator and the
// `normalizeDocTitle` truncation bound — live beside the mint's path
// composition in siyuan-kb-primitives/write). The guard SQL itself
// (pattern builders, leg statements, `findTitleMatches`) also lives
// there, beside the pinned storage behavior it encodes (doc titles
// verbatim, unescaped, in `blocks.content` — pinned live by the
// primitives' writePins suite: `A & B`, `say "hi"`, `a < b > c` all store
// unescaped; the HTML-escaped form lives only in the title IAL,
// `blocks.ial`, which the guard does not query).

import {
	MINT_TITLE_MAX_RUNES,
	mintTitleProblem,
	type MintTitleProblem,
} from "siyuan-kb-primitives/write";

/**
 * mint policy — the rejection set covers every transform the kernel's
 * `normalizeDocTitle` applies (superset claim, pinned live by the title
 * round-trip): any title that survives stores verbatim. The kernel facts
 * are judged down in the primitives; every word below is tool-surface.
 */
export function validateMintTitle(
	raw: string,
): { ok: true; title: string } | { ok: false; message: string } {
	const problem = mintTitleProblem(raw);
	if (problem === undefined) return { ok: true, title: raw.trim() };
	return { ok: false, message: mintTitleMessage(problem) };
}

/** Agent-facing wording over the primitives' `MintTitleProblem` — worded
 * once so the tool-surface pre-flight (validateMintTitle) and the
 * flow-side `mint-title` verdict arm (the primitives run the same
 * judgment internally, defense-in-depth behind the pre-flight) stay
 * identical by construction. */
export function mintTitleMessage(problem: MintTitleProblem): string {
	switch (problem.kind) {
		case "empty":
			return "title is empty after trim — supply a non-empty title";
		case "slash":
			return `title '${problem.title}' contains '/' — the tool builds the doc path itself; rephrase the title without '/'`;
		case "dot-segment":
			return `title '${problem.title}' is a bare dot segment — the kernel cleans it out of the doc path and substitutes its own fallback title; rephrase the title`;
		case "too-long":
			return `title exceeds ${MINT_TITLE_MAX_RUNES} runes — the kernel silently truncates longer titles; shorten it`;
		case "control-chars":
			return `title '${problem.title}' contains tab/newline/control characters — their stored form is unpredictable; rephrase the title`;
	}
	problem satisfies never;
	return `unsupported mint-title problem: ${JSON.stringify(problem)}`;
}
