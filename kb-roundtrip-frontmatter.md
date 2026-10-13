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

## Where the fix lives

The export shape is a **pinned kernel fact**: the frontmatter block is exactly the
kernel's `yfm()` output (`kernel/model/export.go`, keys `title`/`date`/`lastmod`/
optional `tags`, values unescaped) followed by the raw-title H1. Verified live against
the pinned kernel (2026-10): the export of a doc is
`---\ntitle: …\ndate: …\nlastmod: …\n---\n\n# <title>\n`.

Per the AGENTS.md rule — *executable dependence on a pinned behavior moves down into
the primitives* — the recognizer lives in the **`siyuan-kb-primitives` read barrel** as
a pure, kernel-free helper:

```ts
stripExportArtifacts(body, { dropTitleHeading: boolean })
  → { body, stripped: { frontmatterLines, titleHeading } }
```

falsified by a live case in the primitives' suite that exports a known doc and asserts
the exact export block (include a title with `&`, `<`, `>` in the falsifier). The
plugin keeps only policy and wording: which modes invoke the strip, and the echo.
This means the fix ships as a primitives release first (bottom-up), then gnubrain
consumes it.

Note the asymmetry stays plugin/tool-side in one sense: `docMarkdown`'s read shape is
pinned expected behavior and must **not** change — we normalize on the write side
only. And the `kb_write` description today never warns about the round trip at all;
that wording is added below.

## Proposed fix

Normalize the body at the single choke point in `prepareWrite` (writePrepare.ts),
immediately after the `markdown` XOR `markdownFile` resolution, so every content-bearing
mode benefits and the guard-stop staging path (`spillFile(input.body)`) stages the
normalized form. The recognizer itself is the primitives' `stripExportArtifacts`
(see above); the plugin only chooses when to call it and how to word the echo:

1. **Strip a leading YAML frontmatter block — matched tightly against the kernel's
   actual key set.** Line 1 exactly `---`, closing marker exactly `---` (the kernel
   never writes `...`; allowing it only widens the false-positive surface), and every
   line inside a top-level `title:`/`date:`/`lastmod:`/`tags:` key (plus indented
   `- '…'` items under `tags`). Otherwise the body is untouched: a body that opens
   with a thematic break and contains another `---` is legitimate prose, and the
   loose "any `---` … `---`" rule would silently strip it — the very failure mode
   this fix exists to prevent. No closing marker, or a line outside the key set,
   → leave the body untouched.
2. **On `create` only: after a *recognized* frontmatter block, drop the next
   non-blank line if it is an H1.** Gate the drop on "frontmatter was stripped", NOT
   on title-equality. After a recognized kernel frontmatter block the next non-blank
   line *is* the export's title H1 by construction, so this catches the rename case
   (agent restores a doc under a new title — title-equality would leave the old-title
   H1 behind as junk) and sidesteps the title-vs-H1 escaping question entirely.
   Without a recognized frontmatter block, no H1 is ever dropped: a body that
   legitimately opens with its own H1 is content.
3. `edit` / `replace-section` / `append` get frontmatter stripping only, never the
   H1 drop (their bodies don't carry the export's title heading as a duplicate).

All matching is strict and no-op when the pattern doesn't fit, so hand-written bodies
are untouched.

**Echo the normalization** when anything was stripped — a `normalized` field plus a
message suffix that names *what* was stripped, so a kept H1 is inferable:
`stripped YAML frontmatter (4 lines) and title heading from body — kernel manages doc
metadata` / `stripped YAML frontmatter (4 lines); body's own H1 kept`. Silent
transformation is the failure mode we're fixing; the echo keeps it observable.

**Document the round trip** in the `kb_write` tool description: read output carries
kernel-managed frontmatter + title heading; these are stripped automatically on write.

## Test plan

- Unit (primitives, `stripExportArtifacts`): kernel-shaped frontmatter → stripped with
  exact line count; unterminated `---` → untouched; block containing a non-key line →
  untouched; closing `...` → untouched (not recognized); create (dropTitleHeading) →
  H1 after frontmatter dropped, H1 without frontmatter kept, non-H1 after frontmatter
  kept; edit-shape (no drop) → frontmatter stripped, H1 kept.
- Unit (writePrepare ladder): create with export-shaped body → normalized before
  `createDocVerified`; guard-stop staging path stages the normalized form; echo
  `normalized` field + message suffix present when anything was stripped, absent when
  nothing was.
- Live (primitives suite): export a known doc (title containing `&`, `<`, `>`), assert
  the exact export block shape — the falsifier for the recognizer's pinned-fact claim.
- Integration: `kb_read` a doc → feed its spilled `fullResultPath` back as
  `markdownFile: create` (fresh topic) → `kb_read` the new doc → assert exactly one
  title H1 and zero `title:`/`date:`/`lastmod:` paragraphs in the body.

## Alternative considered

Warn-instead-of-strip (detect the patterns, refuse with "strip the frontmatter and
retry"). Smaller blast radius, but it turns every doc-restore/move/copy into a
two-step dance for a transformation the plugin can do correctly by strict match. Strip
+ echo is the smallest change that makes the round trip safe by default.

Also considered and rejected: matching the H1 by title equality (misses the
rename case; drags in escaping questions), and keeping the recognizer tool-side
(the `yfm()` shape is a pinned kernel fact — its live falsifier lives in the
primitives, and an executable copy up-repo is what the layering rule forbids).

## Timing

Fix **before v1**, not after. The change is additive under the tool contract either
way (pure input transform + new `normalized` field + message suffix), but it is
*preventive, not corrective*: every `kb_read → kb_write` round-trip between v1 and
the fix silently writes frontmatter blocks + duplicate title H1s into the store, and
those docs need manual cleanup. Churn is free pre-squash; deferred data hygiene is
not.

Release order (bottom-up): primitives release with `stripExportArtifacts` + live
falsifier first, then the gnubrain change that consumes it.
