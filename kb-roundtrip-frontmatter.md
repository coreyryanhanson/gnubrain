# kb_read → kb_write round-trip friction: frontmatter and title heading are not reconciled on the write side

Observed hands-on while restoring a deleted doc in the `scratch` KB (Kim Simons artist
doc), 2026-10-13. Reproduced twice, verified against the live kernel and the source.

## The problem

`kb_read` returns a doc as markdown that carries **the kernel's YAML frontmatter block
and the doc-title H1** (pinned by `__tests__/integration/readPins.live.test.ts`:
"The export carries the kernel's YAML frontmatter + title heading"). That output is the
natural source an agent reaches for when re-creating or moving a doc. But `kb_write`
accepts the body **verbatim** — `prepareWrite` (writePrepare.ts) resolves
`markdown`/`markdownFile` and passes it straight through to `createDocVerified`, which
mints the title separately (`createDocWithMarkdown({ title, body })`). Nothing strips
or reconciles the export artifacts.

Feeding a `kb_read` export back to `create` therefore produces, silently:

1. The frontmatter block embedded as body content — two thematic-break blocks (`---`)
   plus a paragraph block containing the raw `title: … / date: … / lastmod: …` lines.
2. A duplicate title H1 — one from the export's title heading, one minted by the
   kernel. Both become real content blocks.

Failure looks like success: the echo reports `created` with a clean outline, and the
junk sits at the top of the doc until someone reads it. Recovery costs a delete +
recreate (and, if unnoticed, pollutes the doc permanently). The same hazard applies to
`edit`, `replace-section`, and `append` when the agent pastes `kb_read` output.

## Why this is plugin-side

The kernel's export shape is fixed and already pinned as expected behavior; the plugin
owns the tool surface and is the one place that knows both sides of the round trip
(`docMarkdown`'s output shape and `createDocWithMarkdown`'s title/body split). Today
the asymmetry is documented nowhere on the write side — the `kb_write` description
never warns that read output must be hand-stripped before reuse.

## Proposed fix

Normalize the body at the single choke point in `prepareWrite` (writePrepare.ts),
immediately after the `markdown` XOR `markdownFile` resolution, so every content-bearing
mode benefits and the guard-stop staging path (`spillFile(input.body)`) stages the
normalized form:

1. **Strip a leading YAML frontmatter block.** If line 1 is exactly `---`, scan for a
   closing `---` or `...` line; if found, drop the block. If no closing marker exists,
   leave the body untouched (it's a legitimate leading thematic break, not
   frontmatter).
2. **On `create` only: drop a single leading `# …` line whose text exactly equals the
   minted title** (after normalization, compared trimmed). This kills the duplicate
   title heading. A leading H1 that does *not* match the title is content — keep it.

Both steps are strict-match and no-op when the pattern doesn't fit, so hand-written
bodies are untouched.

**Echo the normalization** when anything was stripped, e.g. a `normalized` field /
message suffix: `stripped YAML frontmatter (4 lines) and title heading from body —
kernel manages doc metadata`. Silent transformation is the failure mode we're fixing;
the echo keeps it observable.

**Document the round trip** in the `kb_write` tool description: read output carries
kernel-managed frontmatter + title heading; these are stripped automatically on write.

## Test plan

- Unit (writePrepare ladder): body starting with frontmatter → stripped; unterminated
  `---` → untouched; leading H1 matching title on create → dropped, non-matching H1 →
  kept; edit/append/replace-section get frontmatter stripping but no H1 drop.
- Integration: `kb_read` a doc → feed its spilled `fullResultPath` back as
  `markdownFile: create` (fresh topic) → `kb_read` the new doc → assert exactly one
  title H1 and zero `title:`/`date:`/`lastmod:` paragraphs in the body.

## Alternative considered

Warn-instead-of-strip (detect the patterns, refuse with "strip the frontmatter and
retry"). Smaller blast radius, but it turns every doc-restore/move/copies into a
two-step dance for a transformation the plugin can do correctly by strict match. Strip
+ echo is the smallest change that makes the round trip safe by default.
