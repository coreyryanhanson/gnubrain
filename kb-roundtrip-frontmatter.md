# kb_read → kb_write round-trip: stop emitting export artifacts at the source

`kb_read` serves a doc as markdown carrying the kernel's YAML frontmatter block
(`title`/`date`/`lastmod`/`tags`) and the doc-title H1. `kb_write` accepts bodies
verbatim, and the write route does not consume YFM (`SetYamlFrontMatter(false)`,
`kernel/util/lute.go:89`), so feeding a `kb_read` export back to `create` silently
lands the frontmatter as two thematic breaks + a key-lines paragraph, plus a
duplicate title H1 — while the echo reports `created` with a clean outline. The
same paste hazard applies to `edit`/`append`/`replace-section`; the read-side fix
below covers every content mode at once.

## Root cause

`siyuan-kernel-api`'s `exportMarkdown(id)` sends only `{id}` (`client.ts:329-335`).
The endpoint reads both knobs **from the request**, falling back to workspace
config (`kernel/api/export.go:388-404`; `addTitle` defaults from
`Conf.Export.AddTitle`, default `true`, user-toggleable). Live-verified on the
pinned kernel:

```text
{id}                            → frontmatter + title H1 + body
{id, yfm:false}                 → title H1 + body
{id, addTitle:false}            → frontmatter + body
{id, yfm:false, addTitle:false} → exactly the doc body
```

The artifacts are therefore **our client's omission defaults, not kernel facts the
write side must undo**. Fixing them on the write side would mean a recognizer over
the `yfm()` byte shape — a shape it can never match soundly (a hand-authored YAML
header using exactly those keys is byte-indistinguishable), gated on a workspace
setting gnubrain cannot observe (`AddTitle` off ⇒ an H1-drop rule silently deletes
the doc's own first heading). The write side keeps its invariant instead: *a body
is content, taken verbatim*.

## Proposed fix

One change per repo; defaults everywhere stay unchanged, so no other consumer
moves. Development lands in one pass over the `file:` co-development link;
publish order stays bottom-up.

1. **`siyuan-kernel-api`** — `exportMarkdown(id, opts?: { yfm?: boolean;
   addTitle?: boolean })`, each field sent only when defined (`compact` already
   drops `undefined`). Update the census args pin (`census.test.ts`) and the
   `client.test.ts` pins asserting the bare `{ id }` body (the no-opts call must
   stay byte-identical to today).
2. **`siyuan-kb-primitives`** — `docMarkdown(client, docId, opts?)` threads the
   option through (`byId.ts`); widen the `ExportClient` capability
   (`client.ts:52`). Doc comment: body-only posture on the tool path, faithful
   pass-through of whatever the caller requests.
3. **`gnubrain`** — `runRead` (`tools.ts`) requests `{ yfm: false, addTitle:
   false }`. `kb_write` and `prepareWrite` untouched.

Plus one wording line in `READ_DESCRIPTION` (pinned in `tools.test.ts`): kb_read
output is a **rendering, not a serialization** — block IAL is not exported
(`SetKramdownIAL(false)`) and tab titles can materialize as content
(`MaterializeTabTitles`), so treat it as a body source, not a byte-exact backup.
No option achieves byte fidelity through the export; the wording covers the
residual class honestly.

## Metadata disposition

Body-only read output drops the frontmatter's derived metadata from the markdown
rendering. It is not lost from the KB:

- Doc-level tags ride the doc's IAL `tags` attribute, which the SQL index renders
  into `blocks.tag` on the root row (`kernel/sql/database.go:1059-1075`) —
  reachable via `kb_query`:

  ```sql
  SELECT id, content, tag FROM blocks WHERE type='d' AND tag != ''
  ```

- Inline tags (`#tag#` spans) are body content — untouched.
- `date`/`lastmod` are queryable (`blocks.updated`, etc.).
- The planned tags-on-create feature rides the `tags` param `createDocWithMd`
  already models (plain string; an array would panic into a silent `code: 0`,
  hence its doc comment) — a structured field, not markdown scraping. Body-only
  is what keeps that future clean.
- If the agent ever needs metadata alongside the body in one read, add an
  explicit opt-in read form (e.g. a `meta` flag returning `{title, tags,
  updated}` as fields) — never re-fatten the markdown.

## Test plan

- **Layer 1 unit**: no-opts call posts `{ id }` exactly as today; opts included
  only when defined; census args pin updated.
- **Primitives unit**: `docMarkdown` forwards opts (stub client asserting call
  args).
- **Primitives live (the falsifier for the new posture)**: export a doc whose
  title contains `&`, `<`, `>` and whose body opens with its own H1 and a `---`
  thematic break; assert the body-only export carries no frontmatter, no title
  H1, no IAL, and the body byte-identical. Nothing is timestamped in body-only
  output, so no wildcarding. Place it next to the existing `docMarkdown` live
  case.
- **Gnubrain unit**: `runRead` passes `{ yfm: false, addTitle: false }` (client
  stub via the `deps` seam); `READ_DESCRIPTION` wording pin updated.
- **Gnubrain integration**: `kb_read` a doc → `kb_write create` (fresh topic,
  inline paste) → `kb_read` the new doc → exactly one title H1, zero frontmatter
  lines, body verbatim.
- **`readPins.live.test.ts`**: the "export carries the kernel's YAML frontmatter
  + title heading" line is currently an unasserted comment — delete it. The real
  body-only pin is owned by the primitives' live suite (above); this repo pins
  the tool-side behavior through the integration round-trip case.

## AGENTS.md updates

- `gnubrain` version-coupling list gains one line: **body-only read posture** —
  kb_read serves `exportMdContent` with `yfm:false`/`addTitle:false` →
  `docMarkdown` opts (primitives `byId.ts`) → this repo keeps the request args and
  the description wording → falsifier: the primitives' body-only live case.
- `siyuan-kb-primitives` AGENTS.md: update the `byId.ts`/`docMarkdown` entry for
  the opts threading and the body-only posture its live case falsifies.

## Timing

Fix before v1 — preventive, not corrective: the sweep
`SELECT COUNT(*) FROM blocks WHERE type='p' AND content LIKE '%lastmod:%'` returns
0 in the live workspace. Re-run it in any other workspace before declaring the
class closed.
