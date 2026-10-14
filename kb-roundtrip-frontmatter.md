# kb_read → kb_write round-trip: stop emitting export artifacts at the source

`kb_read` serves a doc as markdown carrying the kernel's YAML frontmatter block
(`title`/`date`/`lastmod`/`tags`) and the doc-title H1. `kb_write` accepts bodies
verbatim, and the write route does not consume YFM (`SetYamlFrontMatter(false)`,
`kernel/util/lute.go:89`), so feeding a `kb_read` export back to `create` silently
lands the frontmatter as two thematic breaks + a key-lines paragraph, plus a
duplicate title H1 — while the echo reports `created` with a clean outline. The
same paste hazard applies to `edit`/`append`/`replace-section`; the read-side fix
below covers every content mode at once. And the client's omission defaults reach
further than the frontmatter: the same export endpoint selects how block refs and
query embeds translate into markdown from workspace config when the request omits
them — the fix below pins the whole knob set explicitly, not just the frontmatter.

## Root cause

`siyuan-kernel-api`'s `exportMarkdown(id)` sends only `{id}` (`client.ts:329-334`).
The endpoint takes four knobs **from the request** when the client sends them
(`kernel/api/export.go:388-404`): `yfm` (hardcoded `true` when absent — no
workspace toggle can suppress it, so an explicit `yfm:false` is the only fix),
and `addTitle`/`refMode`/`embedMode`, each falling back to workspace config
(`addTitle` ← `Conf.Export.AddTitle`, default `true`; `refMode` ←
`Conf.Export.BlockRefMode`, default `4`; `embedMode` ←
`Conf.Export.BlockEmbedMode`, default `1` — all user-toggleable). Live-verified
on the pinned kernel:

```text
{id}                            → frontmatter + title H1 + body
{id, yfm:false}                 → title H1 + body
{id, addTitle:false}            → frontmatter + body
{id, yfm:false, addTitle:false} → exactly the doc body
```

The same omission silently selects how kernel-native constructs translate into
markdown (`model/export.go:3370-3408`, `model/render.go:455-466`):

- **Block refs** (`((id "text"))`): refMode 3 renders the anchor text alone —
  the pointer vanishes without a trace; refMode 4 (workspace default) fabricates
  `text[^1]` footnote markers plus an appended footnotes section carrying the
  referenced block's content — generated body that round-trips as real content;
  refMode 2 renders `[text](siyuan://blocks/defID)`, preserving the pointer as
  an address; refMode 0 (and identically 1 and 5) falls through the kernel's
  mode switch — `model/export.go:3370-3408` has cases only for 2/3/4, no
  default — and emits the ref node verbatim, `((id "text"))`, the lossless
  source form, live-verified on the pinned kernel to round-trip as a real
  block ref on re-import. (Workspace config cannot select 0/1/5 —
  `model/conf.go` force-normalizes them to 4 at config load — but the request
  path honors raw values with no range validation, which is why the client's
  opts type below still narrows the union instead of taking `number`.) Modes
  1 and 5 stay unnamed despite behaving like 0: their documented semantics
  ("raw text", "Blockquote") no longer describe anything the kernel does, so
  0 is the single exposed verbatim mode.
- **Query embeds** (`{{SELECT ...}}`): no mode preserves the script — every mode
  resolves and inlines the result; mode 1 (workspace default) inlines as quote
  blocks (`> ` per line), mode 0 inlines raw, indistinguishable from authored
  text.

Config-dependent output means the same doc reads differently across deployments,
on a dial gnubrain cannot observe — the same never-silently-wrong violation as
the frontmatter omission, and footnote fabrication is the same export-artifact
class.

The artifacts are therefore **our client's omission defaults, not kernel facts the
write side must undo**. Fixing them on the write side would mean a recognizer over
the `yfm()` byte shape — a shape it can never match soundly (a hand-authored YAML
header using exactly those keys is byte-indistinguishable), gated on a workspace
setting gnubrain cannot observe (`AddTitle` off ⇒ an H1-drop rule silently deletes
the doc's own first heading). The write side keeps its invariant instead: *a body
is content, taken verbatim*.

## Proposed fix

One posture per repo; the shared defaults stay unchanged, so no consumer beyond
the two agent-serving sites named below moves. The only other `docMarkdown`
callers are the primitives' own move-hpath judgment (`move.ts:371,375`), which
reads only `hPath`/`title` and deliberately keeps the bare `{id}` call —
opts-neutral by design, not a missed site. Development lands in one pass
over the `file:` co-development link; publish order stays bottom-up.

1. **`siyuan-kernel-api`** — `exportMarkdown(id, opts?: ExportMarkdownOpts)`, with the
   exported `ExportMarkdownOpts = { yfm?: boolean; addTitle?: boolean;
   refMode?: 0 | 2 | 3 | 4; embedMode?: 0 | 1 }` — each field sent only when
   defined (`compact` already drops `undefined`). The ref/embed values are
   literal unions, not `number`: the request path honors raw values with no
   range validation (`apicontract/export.go:90` — `Validate` returns
   `OptionsError`, which the typed decode fills on a type mismatch, so a
   non-numeric `refMode` still fails; only the numeric range is unchecked).
   Mode 0 is exposed deliberately — the lossless verbatim form established in
   the root cause above — symmetric with `embedMode: 0` (raw inline), which
   was already a real mode; 1 and 5 stay out, per the root-cause reasoning.
   Because 0's behavior is an upstream fall-through rather than a documented
   case, its semantics are pinned by a live falsifier in the primitives
   (below) and re-checked on every kernel upgrade; a future kernel that gives
   the switch a case for 0 fires that pin. The type, not policy, keeps the
   unnamed modes out of layer 1. Layer 1 chooses no
   posture — it only guarantees the knobs are *settable* (the explicit-knob rule
   codified in its AGENTS.md, see below); the values are the caller's. Test
   edits, both shaped by what each pin actually verifies: `client.test.ts`
   gains *additive* cases (full opts; partial opts — `{ id, yfm: false }` with
   no `addTitle` key), keeping the bare `{ id }` body pin unchanged — that pin
   *is* the byte-identity proof of the no-opts call, not a stale assertion to
   update. And the census `ARGS` entry (`census.test.ts`) is *replaced* with
   the full opts tuple, not left as the bare `"x"`: the census drives its args
   against a stubbed fetch and asserts token attachment on every outgoing call
   (`census.test.ts:130-140`), so the bare tuple does still reach the drive and
   assert auth — the full opts tuple is preferred so the representative call
   exercises the `compact`-spread opts branch, matching the shape the method
   actually sends. Body shape stays `client.test.ts`'s
   job; the census verifies reachability and auth posture.
2. **`siyuan-kb-primitives`** — `docMarkdown(client, docId, opts?)` threads the
   option through (`byId.ts`); widen the `ExportClient` capability
   (`client.ts:52`). Beside it, export the frozen posture constant
   `READ_EXPORT_POSTURE: ExportMarkdownOpts` (`Object.freeze({ yfm: false,
   addTitle: false, refMode: 2, embedMode: 1 } as const)` — the primitives'
   house freeze pattern (`outline.ts:25`) with the literal type added) as the
   single home of the four values:
   the kernel magic numbers live where their semantics are pinned and
   falsified, not in the tool layer. The posture's refMode 2 over the
   now-exposed 0 is a deliberate dialect choice made at the constant —
   readable, id-addressable links on the read surface, with 0 left to the
   parked source-form read. Doc comment: body-only posture on the tool
   path, faithful pass-through of whatever the caller requests — the constant
   names the tool-path dialect without changing the pass-through behavior.
3. **`gnubrain`** — `runRead` (`tools.ts`) passes the primitives'
   `READ_EXPORT_POSTURE`: body-only; refs render as
   `siyuan://blocks/<id>` links (the id is directly `kb_read`-able — pointers,
   not stale copies, matching the stack's id-addressed notation); embeds
   materialize with the quote-block seam distinguishing embedded from authored
   text. The duplicate-stop excerpt (`writeCreate.ts:108`) passes the same
   constant, so every agent-served markdown speaks one dialect — the only
   write-side change; the write modes' verdict paths and schemas are untouched.
   No kernel numbers appear in this repo: the posture is a named fact consumed
   from the read barrel, so the values and their falsifiers share one home
   down-repo. Baselines and the fresh-content judgment are untouched by the
   posture change: `runRead` seeds no baseline from the exported rendering
   (seeds ride `serveOutline`'s walk and `kb_query`'s served rows), and the
   fresh judgment hashes walk-form/SQL content, never the export.

Plus wording lines in `READ_DESCRIPTION` (pinned in `tools.test.ts`): kb_read
output is a **rendering, not a serialization** — it is the body alone (no
frontmatter, no title H1; the title rides the `hpath` echo), block IAL is not
exported (`SetKramdownIAL(false)`), tab titles can materialize as content
(`MaterializeTabTitles`), block refs render as `siyuan://blocks/<id>` links,
and query embeds materialize as quoted content (the embed script itself is not
preserved in any mode). **Ref/embed round-trip is out of scope for v1**, and
the wording says so plainly — without overstating what the kernel can do:

- The tool posture (refMode 2) renders a ref as a `siyuan://blocks/<id>`
  link. Pasting that into a write degrades acceptably: the link imports as a
  real block link (`treenode/node.go:148`) and keeps the pointer, but it is
  a link, not the stored `((id "text"))` ref form.
- The lossless ref form exists at the knob level: `refMode: 0` emits the
  verbatim `((id "text"))` source — live-verified to round-trip as a real
  ref. It is deliberately not the read rendering's dialect — and it is not
  the future source-form read either: no export mode preserves embeds, so a
  doc-level lossless export is impossible at any refMode. The source form
  rides the walk/`getBlockKramdown` path (see *Parked* below), not this
  endpoint.
- A pasted embed freezes the query's resolved result as authored quote text —
  a stale snapshot indistinguishable from real content, in every mode. This
  warning is unconditional.
- The same degradation reaches `edit`/`replace-section`, whose body is taken
  verbatim: rewriting a ref-bearing block from the rendering lands the link
  form over the stored `((id "text"))` source, and nothing refuses it — the
  flows seed the fresh precondition from the live row when the session has
  no baseline (`writeEdit.ts`; `unseen` → adopt), so the corruption is
  silent, visible only in the echo.
- There is no "source from the walk instead" escape hatch, deliberately: the
  walk and the outline carry the kernel's ref-stripped `content` —
  `WalkedBlock` keeps `content` and discards the per-child `markdown` field
  the kernel already returns (`walk.ts`), and the outline serves headings
  only — so routing ref-bearing bodies through them would silently drop the
  pointer. No current tool surface carries the stored ref/embed source; the
  root-cause fix is a read-side source form, specified in *Parked: the
  source-form read* below — not a write-side rehydrator. Until it exists
  the wording says plainly that `kb_read` output is a body source for plain
  content only, not a byte-exact backup.

## Parked: the source-form read (the walk path's root-cause fix)

The wording above stops the bleeding for v1; it does not close the walk
path's gap. The root cause there: the kernel already returns a per-child
`markdown` field on every `getChildBlocks` call — the stored source, refs
(`((id "text"))`) and embeds (`{{SELECT ...}}`) verbatim — and the
primitives' `WalkedBlock` (`walk.ts`) keeps only the ref-stripped `content`
and discards it. The stack's lossless surface is one discarded field away.
The parked fix is read-side, two moves:

1. **Primitives**: thread `markdown` through `WalkedBlock` — one field,
   zero new kernel calls. The fresh-content judgment and baselines are
   untouched by design: they hash the ref-stripped `content`, both sides of
   every comparison read that same stripped form, and `markdown` rides
   along as evidence only. Pin the field's shape in the primitives' live
   suite when it lands (refs and embeds verbatim) — it is version-coupled
   kernel surface like everything else in the walk.
2. **gnubrain, when a surface exists**: an agent-facing read form that
   serves the source field. Threading the field alone closes nothing the
   agent can touch — the walk is internal (outlines serve headings;
   judgments consume `content`), so the tool-side form is where the
   notation decision lives. After it ships, replace the `READ_DESCRIPTION`
   sentence "no current tool surface carries the stored ref/embed source"
   with a pointer to that form — "source ref-bearing bodies from the
   source read" becomes a true sentence then, and only then.

The per-block alternative — a `getBlockKramdown`-backed read primitive —
stays named but secondary: it returns stored kramdown verbatim, but also
block IAL, which the read posture deliberately omits
(`SetKramdownIAL(false)`), so it needs an IAL strip or an accepted caveat,
and it is per-block rather than per-walk. Prefer the walk field unless a
per-block need appears.

Deliberately not in this pass: threading the field alone touches no
agent-facing surface, and inventing the read form here would out-design
the need before the posture fix has landed. Record both moves when this
plan ships so the next session finds them instead of re-deriving them.

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
  only when defined (additive cases, bare body pin untouched); the census `ARGS`
  entry becomes the full opts tuple so the opts path joins the token-attachment
  drive.
- **Primitives unit**: `docMarkdown` forwards opts (stub client asserting call
  args); `READ_EXPORT_POSTURE` is frozen and carries the four documented
  values.
- **Primitives live (the falsifier for the knob semantics)**: export a doc whose
  title contains `&`, `<`, `>` and whose body opens with its own H1 and a `---`
  thematic break; assert the body-only export carries no frontmatter, no title
  H1, no IAL, and the body present via `toContain(originalBody)` rather than
  byte equality — the export re-renders through lute (`SetSanitize(true)` and
  friends), so byte identity is stronger than the fix needs and would flake on
  fixtures; the repo's existing live style is `toContain`
  (`readPins.live.test.ts:452`). Nothing is timestamped in body-only output,
  so no wildcarding. Place it next to the existing `docMarkdown` live
  case. The two posture live cases call `docMarkdown` with
  `READ_EXPORT_POSTURE` — never hand-rolled literals (the refMode-0 case
  below is the deliberate exception) — so the constant itself joins the
  falsified surface and cannot drift from its evidence.
- **Primitives live, second case (the ref/embed falsifier)**: export a
  ref-bearing doc — a block ref to another doc's block plus a query embed;
  assert structure, not byte identity (refs are translated, not serialized):
  refs render as `[text](siyuan://blocks/…)`, there are no `[^1]` markers and
  no footnotes section, and the embed's content appears as a quote block. Like
  the ref-free fixture above, this case asserts containment and absence,
  never byte identity. Both primitives live cases falsify what the knobs do;
  the shipped dialect is pinned tool-side by the gnubrain unit and
  integration cases below — layer 2 only passes through, so it cannot be the
  dialect's falsifier.
- **Primitives live, third case (the refMode-0 fall-through falsifier)**: the
  exposed `0` is the plan's one bet on undocumented upstream behavior, so pin
  it directly: export a ref-bearing doc at `refMode: 0` — a hand-rolled
  literal, deliberately not `READ_EXPORT_POSTURE`, since the posture does not
  use this mode — and assert the verbatim `((id "text"))` source appears and
  no footnotes section is appended. If a future kernel gives the switch a
  case for 0, this pin fires and forces a re-read of the whole ref story
  before any release rides on the fall-through.
- **Gnubrain unit**: `runRead` passes `READ_EXPORT_POSTURE` (imported from the
  read barrel) and the writeCreate duplicate-stop excerpt passes the same
  constant (client stubs via the `deps` seam); `READ_DESCRIPTION` wording pin
  updated.
- **Gnubrain integration**: `kb_read` a doc → `kb_write create` (fresh topic,
  inline paste) → `kb_read` the new doc → zero frontmatter lines, no
  fabricated title H1 (the body's own headings appear exactly once), body
  verbatim.
- **`readPins.live.test.ts`**: the "export carries the kernel's YAML frontmatter
  + title heading" line (`readPins.live.test.ts:449-452`) is an unasserted
  comment explaining why that case asserts `toContain(bigBody)` rather than
  byte equality — frontmatter precedes the body. The comment stays true after
  this change because that case rides the raw client with no opts: reword it
  to name the raw-client posture (bare `{id}` call, kernel defaults) instead
  of deleting it. The body-only pin itself is owned by the primitives' live
  suite (above); this repo pins the tool-side behavior through the
  integration round-trip case.

## AGENTS.md updates

- `siyuan-kernel-api` AGENTS.md gains the systemic **explicit-knob rule**:
  wherever a request-optional knob's absent-value fallback is workspace config,
  the client must surface it as an explicit opt — consumer-visible output must
  not depend on unobservable workspace settings ("consumer", not "tool":
  layer 1 is tool-agnostic and the rule binds its callers generally). The rule
  carries its own upkeep hook so it cannot rot: a kernel-upgrade sweep of the
  request contracts must check every new request-optional knob against the rule
  — surface it in the client or name it in the rendering-not-serialization
  wording, never let omission choose. `census.test.ts` is the natural future
  mechanical enforcement point; deliberately not built now — the class recurs
  roughly once per kernel minor version, so a rule referenced from the upgrade
  sweep is proportionate. On the current surface this is `exportMdContent`'s
  `addTitle`/`refMode`/`embedMode` (`yfm`'s fallback is hardcoded `true`, but
  it is settable for the same reason); conf-only knobs with no request override
  on this endpoint (tag markers, ref text markers, `fileAnnotationRefMode`,
  `inlineMemo`) are unpinnable and stay covered by the
  rendering-not-serialization wording.
- `gnubrain` version-coupling list gains one line: **body-only,
  config-independent read posture** — kb_read serves the primitives'
  `READ_EXPORT_POSTURE` (frozen constant beside `docMarkdown`, `byId.ts`) →
  this repo keeps only the description wording; no kernel numbers or request
  args live here → falsifier: the primitives' body-only and ref-rendering live
  cases (built on the constant), plus this repo's `runRead` unit pinning that
  the constant is what reaches the client, and the integration round-trip case
  pinning the landed shape — together they are the dialect's falsifiers, since
  the primitives' live cases only falsify knob semantics.
  The Upgrade checklist (Hard constraints) gains only a cross-reference to the
  layer-1 explicit-knob rule — the kernel-upgrade sweep of the request
  contracts lives in layer 1's own AGENTS.md, beside the rule it upholds, so
  it cannot rot whenever gnubrain happens not to be touched; this repo's
  checklist just points there when its own upgrade pass runs.
- `siyuan-kernel-api` README: the `exportMarkdown(id)` row (`README.md:57`)
  gains the opts note alongside the AGENTS.md rule.
- `siyuan-kb-primitives` README: no edit. `docMarkdown` has no README usage
  section to update (the README's usage sections cover the other read
  primitives; the only `exportMarkdown` mention, in the `moveDocVerified`
  example, is about its `hPath` being the move judgment's synchronous ground
  truth, unrelated to `docMarkdown` reads). The opts threading and the
  `READ_EXPORT_POSTURE` constant are documented at their definition site
  (`byId.ts` JSDoc) and in the `AGENTS.md` `byId.ts` entry below — the single
  greppable home for both the signature and the posture, which the README
  would only duplicate and let drift.
- `siyuan-kb-primitives` AGENTS.md: update the `byId.ts`/`docMarkdown` entry for
  the opts threading (four knobs, pass-through, no posture), the exported
  `READ_EXPORT_POSTURE` constant (the four values, frozen, beside
  `docMarkdown`), and the knob semantics its live cases falsify (body-only,
  ref-rendering, refMode-0 verbatim fall-through) — the posture cases
  constructed from the constant, so the fact and its falsifier share one
  home; the shipped dialect itself is pinned tool-side in gnubrain, since
  layer 2 only passes through. The refMode-0 case is the standing exception
  to "constructed from the constant": it pins a knob the posture does not
  use, precisely because the fall-through is undocumented upstream.

## Timing

Fix before v1 — preventive, not corrective: the sweep
`SELECT COUNT(*) FROM blocks WHERE type='p' AND content LIKE '%lastmod:%'` returns
0 in the live workspace. Re-run it in any other workspace before declaring the
class closed.
