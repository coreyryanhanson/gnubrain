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

`siyuan-kernel-api`'s `exportMarkdown(id)` sends only `{id}` (`client.ts:329-335`).
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
markdown (`model/export.go:3370-3391`, `model/render.go:455-466`):

- **Block refs** (`((id "text"))`): refMode 3 renders the anchor text alone —
  the pointer vanishes without a trace; refMode 4 (workspace default) fabricates
  `text[^1]` footnote markers plus an appended footnotes section carrying the
  referenced block's content — generated body that round-trips as real content;
  refMode 2 renders `[text](siyuan://blocks/defID)`, preserving the pointer as
  an address. (Workspace config cannot select modes 0/1/5 — `model/conf.go`
  force-normalizes them to 4 at config load — but the request path honors raw
  values with no range check, which is why the client's opts type below narrows
  the union instead of taking `number`.)
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
   refMode?: 2 | 3 | 4; embedMode?: 0 | 1 }` — each field sent only when defined
   (`compact` already drops `undefined`). The ref/embed
   values are literal unions, not `number`: `model/conf.go` normalizes 0/1/5
   only at config load, while the request path (where `Validate` is a no-op,
   `apicontract/export.go:90`) honors raw values — once the knob exists, a
   stray `0` would reach the deprecated raw-block translation. The type, not
   policy, keeps the config-unreachable modes out of layer 1. Layer 1 chooses no
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
   `READ_EXPORT_POSTURE: ExportMarkdownOpts` (`yfm: false, addTitle: false,
   refMode: 2, embedMode: 1`, `as const`) as the single home of the four values:
   the kernel magic numbers live where their semantics are pinned and
   falsified, not in the tool layer. Doc comment: body-only posture on the tool
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
the wording says so plainly: no export mode emits importable `((id "text"))`
ref syntax, so `kb_read` output is not a valid body source for ref- or
embed-bearing content — the agent must not reconstruct a write body from
the rendering there. Creating from a pasted rendering degrades
acceptably (a `siyuan://` link imports as a real block link,
`treenode/node.go:148`), but a pasted embed freezes the query's resolved
result as authored quote text — a stale snapshot indistinguishable from real
content. The same degradation reaches `edit`/`replace-section`, whose body is
taken verbatim: rewriting a ref-bearing block from the rendering lands the
link form over the stored `((id "text"))` source, and nothing refuses it —
the flows seed the fresh precondition from the live row when the session has
no baseline (`writeEdit.ts`; `unseen` → adopt), so the corruption is silent,
visible only in the echo. The wording says so: for ref- or embed-bearing
content, source the write body from the outline/walk form, which carries the
stored source — the same baselines the edit flow already judges against.
Treat the output as a body source for plain content, not a byte-exact backup;
a true round-trip
(rehydrating refs, re-materializing embed scripts) is a parked write-side
primitive, not something this fix delivers.

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
  case. Both live cases call `docMarkdown` with `READ_EXPORT_POSTURE` — never
  hand-rolled literals — so the constant itself joins the falsified surface
  and cannot drift from its evidence.
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
- **Gnubrain unit**: `runRead` passes `READ_EXPORT_POSTURE` (imported from the
  read barrel) and the writeCreate duplicate-stop excerpt passes the same
  constant (client stubs via the `deps` seam); `READ_DESCRIPTION` wording pin
  updated.
- **Gnubrain integration**: `kb_read` a doc → `kb_write create` (fresh topic,
  inline paste) → `kb_read` the new doc → exactly one title H1, zero frontmatter
  lines, body verbatim.
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
  The Upgrade checklist (Hard constraints) gains one clause: the kernel-upgrade
  sweep of the request contracts for new request-optional knobs runs against
  the layer-1 explicit-knob rule — new knobs surface exactly when they appear,
  which is the only moment the rule needs to be re-read.
- `siyuan-kernel-api` README: the `exportMarkdown(id)` row (`README.md:57`)
  gains the opts note alongside the AGENTS.md rule.
- `siyuan-kb-primitives` README: the `docMarkdown` section (`README.md:242`)
  gains the opts threading and the exported `READ_EXPORT_POSTURE` constant.
- `siyuan-kb-primitives` AGENTS.md: update the `byId.ts`/`docMarkdown` entry for
  the opts threading (four knobs, pass-through, no posture), the exported
  `READ_EXPORT_POSTURE` constant (the four values, frozen, beside
  `docMarkdown`), and the knob semantics its live cases falsify (body-only,
  ref-rendering) — the cases constructed from the constant, so the fact and
  its falsifier share one home; the shipped dialect itself is pinned tool-side
  in gnubrain, since layer 2 only passes through.

## Timing

Fix before v1 — preventive, not corrective: the sweep
`SELECT COUNT(*) FROM blocks WHERE type='p' AND content LIKE '%lastmod:%'` returns
0 in the live workspace. Re-run it in any other workspace before declaring the
class closed.
