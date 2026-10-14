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
them — the fix below pins the config-dependent knobs explicitly, not just the
frontmatter.

## Root cause

`siyuan-kernel-api`'s `exportMarkdown(id)` sends only `{id}` (`client.ts:329-334`).
The endpoint takes seven knobs **from the request** when the client sends them
(`kernel/api/export.go:388-404`); four have config-dependent fallbacks and are
this plan's subject (the other three — `fillCSSVar`/`adjustHeadingLevel`/
`imgTag` — default to a fixed `false` and stay out of scope): `yfm` (hardcoded
`true` when absent — no
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
markdown (`model/export.go:3370-3408`, `model/render.go:456-467`):

- **Block refs** (`((id "text"))`): refMode 3 renders the anchor text alone —
  the pointer vanishes without a trace; refMode 4 (workspace default) fabricates
  `text[^1]` footnote markers plus an appended footnotes section carrying the
  referenced block's content — generated body that round-trips as real content;
  refMode 2 renders `[text](siyuan://blocks/defID)`, preserving the pointer as
  an address; refMode 0 (and identically 1 and 5 — all three marked deprecated
  upstream, `conf/export.go:21-27`) falls through the kernel's
  mode switch — `model/export.go:3370-3408` has cases only for 2/3/4, no
  default — and emits the ref node verbatim, `((id "text"))`, the lossless
  source form, live-verified on the pinned kernel to round-trip as a real
  block ref on re-import. (Workspace config cannot select 0/1/5 —
  `model/conf.go` force-normalizes them to 4 at config load — but the request
  path honors raw values with no range validation, which is why the client's
  opts type below still narrows the union instead of taking `number`.)
  Deprecated is not undocumented: upstream's own mode table names 0 "raw
  text" (`conf/export.go:21-27`), and that documented meaning is exactly what
  the fall-through realizes — verbatim emission. Mode 1's documented meaning
  ("Blockquote") no longer describes anything the kernel does, and 5's
  (anchor hash) matches nothing a caller wants, so 0 is the single exposed
  mode whose documented semantics and realized behavior agree.
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
   Its realization is the mode switch's fall-through (cases only for 2/3/4,
   no default), so its emitted form is
   pinned by a live falsifier in the primitives (below) and re-checked on
   every kernel upgrade; a future kernel that gives the switch a case for 0
   fires that pin. That falsifier is a live-suite case, env-gated: it fires
   on the next live/upgrade run, not as a CI tripwire. Keeping the unnamed
   modes out of layer 1 is surface curation — the same curation layer 1
   already applies to endpoints and deprecated surface — not the kernel's
   numeric range, and the doc comment says so, including that 0 stands for
   *any* non-2/3/4 value (all fall through to verbatim), so a caller does
   not read 0 as special relative to the excluded 1/5. The opts type carries a
   JSDoc naming the explicit-knob rule at the method — layer 1's house style
   puts kernel-fallback caveats at the call site (`listInvalidBlockRefs`,
   `client.ts:300-322`) — so a caller reads the caveat where it bites, not
   only in AGENTS.md. Layer 1 chooses no
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
   (`client.ts:52`). Beside it, export the frozen constant
   `SOURCE_PRESERVING_EXPORT_OPTS: Readonly<ExportMarkdownOpts>`
   (`Object.freeze({ yfm:
   false, addTitle: false, refMode: 0, embedMode: 1 } as const)` — the
   primitives' house freeze pattern (`outline.ts:25`, which annotates
   `Readonly`) with the literal type added; the annotation matters because the
   opts members are mutable optional props, so a bare `ExportMarkdownOpts`
   annotation would let a consumer legally write
   `SOURCE_PRESERVING_EXPORT_OPTS.refMode = 0` and only fail at runtime,
   while `Readonly<…>` fails typecheck and
   stays assignable to the mutable-props parameter) as the
   single home of the four values:
   the kernel magic numbers live where their semantics are pinned and
   falsified, not in the tool layer. The constant's refMode 0 is chosen on
   integrity grounds, not rendering preference: the
   kernel's refs index counts block refs but never block links
   (`refsFromTree` reads `IsBlockRef`/`IsFileAnnotationRef`/
   `IsEmbedBlockRef` only, `kernel/sql/database.go:545-574`; a
   `siyuan://blocks/<id>` link parses as `IsBlockLink`,
   `treenode/node.go:144`), so a link-form rendering would silently drop the
   refs/backlink edge on every read-modify-write of a ref-bearing doc, while
   the verbatim `((id "text"))` form re-imports as a real ref
   (`SetBlockRef(true)`, `kernel/util/lute.go:63`) and keeps the edge.
   Honest framing: refMode 0 is a **bridge** — it reproduces the stored
   `((id "text"))` source form through an export-mode side channel (the
   no-case fall-through), while the parked source-form read produces the
   same bytes robustly with no dependence on any export mode; the live pin
   below is the tripwire that says the bridge broke, and its exit is the
   source-form read (*Parked*), not a mode change. Doc comment:
   source-preserving export options — body-only, refs verbatim, embeds as
   quote blocks — an export-semantics choice any consumer may adopt;
   faithful pass-through of whatever the caller requests, the constant names
   the dialect without changing it. The name is consumer-agnostic on
   purpose: layer 2's doctrine is deterministic primitives, no posture —
   adopting the dialect on the tool path is layer-3 policy, pinned in
   gnubrain (below). Both exports join the read barrel: the constant must be
   reachable from `siyuan-kb-primitives`'s root (`index.ts`), and
   `ExportMarkdownOpts` joins the barrel's curated layer-1 type re-exports
   so a consumer can name the options type it is asked to pass. The
   barrel-completeness sweep in `index.test.ts` derives root-module exports
   and fails on anything unreachable, so a missed re-export breaks CI —
   the plan names the edit anyway so it is not discovered at test time.
3. **`gnubrain`** — `runRead` (`tools.ts`) passes the primitives'
   `SOURCE_PRESERVING_EXPORT_OPTS`: body-only; refs render verbatim as
   `((id "text"))` (the id inside is directly `kb_read`-able — pointers,
   not stale copies, matching the stack's id-addressed notation); embeds
   materialize with the quote-block seam distinguishing embedded from authored
   text. The duplicate-stop excerpt (`writeCreate.ts:108`) passes the same
   constant, so every agent-served markdown speaks one dialect — the only
   write-side change; the write modes' verdict paths and schemas are untouched.
   `QUERY_DESCRIPTION` (`tools.ts`) additionally names `blocks.markdown`
   among the queryable columns — the stored source of each block, refs and
   embeds verbatim, written by the same renderer the export pipeline uses,
   but index-lagged like the rest of the SQL surface (the walk's fresh
   source read stays parked below; this line is the caveat-carrying escape
   hatch, not a served read form). No kernel numbers appear in this repo: the posture is a named fact consumed
   from the read barrel, so the values and their falsifiers share one home
   down-repo. Baselines and the fresh-content judgment are untouched by the
   posture change: `runRead` seeds no baseline from the exported rendering
   (seeds ride `serveOutline`'s walk and `kb_query`'s served rows), and the
   fresh judgment hashes walk-form/SQL content, never the export.

Plus wording lines in `READ_DESCRIPTION` (pinned in `tools.test.ts`). House
rule: the tool description carries the agent-facing contract in plain
language, no kernel symbols — it costs tokens on every turn; the mechanism
behind each sentence lives in the AGENTS.md updates below, which is where a
wrong sentence gets falsified. The contract:

- kb_read output is a **rendering, not a serialization**: the body alone —
  no frontmatter, no title H1 (the title rides the `hpath` echo); block IAL
  is not exported, and tab titles and inline memos can materialize as
  content.
- Block refs render in their stored `((id "text"))` source form; the id
  inside is directly kb_read-able — pointers, not stale copies, matching the
  stack's id-addressed notation. Refs round-trip: pasting that form into any
  write mode re-imports as a real block ref, so the pointer and the
  refs/backlink edge survive without any flow-side guard.
- Query embeds materialize as quoted content; the embed script is not
  preserved in any export mode. A pasted embed freezes the query's resolved
  result as authored quote text — a stale snapshot indistinguishable from
  real content. This warning is unconditional; **embed round-trip is out of
  scope for v1**.
- There is no "source from the walk instead" escape hatch, deliberately: the
  walk and the outline carry the kernel's ref-stripped `content` —
  `WalkedBlock` keeps `content` and discards the per-child `markdown` field
  the kernel already returns (`walk.ts`), and the outline serves headings
  only — so routing ref-bearing bodies through them would silently drop the
  pointer. No *fresh* tool surface carries the stored embed source (refs now
  ride the read rendering verbatim; the SQL index's `blocks.markdown` column
  does carry it — index-lagged, see *Parked*); the root-cause fix is a
  read-side source form, specified in *Parked: the source-form read* below —
  not a write-side rehydrator. Until it exists the wording says plainly that
  `kb_read` output is a body source for plain content and refs — embeds are
  materialized snapshots — not a byte-exact backup.

Mechanism behind the contract (this plan and the AGENTS.md updates carry it;
the description never does):

- refMode 0 renders a ref in its stored `((id "text"))` source form.
  Pasting that into a write re-imports as a real block ref
  (`SetBlockRef(true)`, `kernel/util/lute.go:63`), so the pointer and the
  refs/backlink edge survive the round trip.
- The dialect choice is integrity, not rendering preference: the kernel's
  refs index counts block refs but never block links (`refsFromTree` reads
  `IsBlockRef`/`IsFileAnnotationRef`/`IsEmbedBlockRef` only,
  `kernel/sql/database.go:545-574`; a `siyuan://blocks/<id>` link parses as
  `IsBlockLink`, `treenode/node.go:144`), so a link-form dialect would
  silently drop the refs/backlink edge on every read-modify-write of a
  ref-bearing doc — the same silent-corruption class this plan closes.
- The materialization caveats ride `SetKramdownIAL(false)`,
  `MaterializeTabTitles`, and `InlineMemo` (workspace config, no request
  override on this endpoint).

## Parked: the source-form read (the walk path's root-cause fix)

The verbatim dialect above closes the ref half of the round-trip gap; embeds
remain a capability limit in every export mode, and the walk path's lossless
surface is still one discarded field away. The root cause there: the kernel
already returns a per-child `markdown` field on every `getChildBlocks` call —
the stored source, refs (`((id "text"))`) and embeds (`{{SELECT ...}}`)
verbatim — and the primitives' `WalkedBlock` (`walk.ts`) keeps only the
ref-stripped `content` and discards it.
The parked fix is read-side, two moves. Framing first: the differentiator
between this and the already-existing `blocks.markdown` column is freshness,
not existence — the column is written by the same renderer
(`treenode.ExportNodeStdMd`) that produces the per-child `markdown` field,
refs and embeds verbatim, but it rides the async SQL index, so it is a stale
source surface agents can reach through `kb_query` today. The walk field is
the *fresh* source read. Exit condition for the parked work: land it when
the prevalence gate (Timing, below) says refs/embed-bearing docs are common
— as moves 1+2 together, never move 1 alone: threading the field with no
agent-facing consumer is speculative surface — **or** when the refMode-0
live pin fires (the export-side bridge broke; see the posture section).

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
   sentence "no *fresh* tool surface carries the stored embed source"
   with a pointer to that form — "source embed-bearing bodies from the
   source read" becomes a true sentence then, and only then.

The per-block alternative — a `getBlockKramdown`-backed read primitive —
stays named but secondary: it returns stored kramdown verbatim, but also
block IAL, which the read posture deliberately omits
(`SetKramdownIAL(false)`), so it needs an IAL strip or an accepted caveat,
and it is per-block rather than per-walk. Prefer the walk field unless a
per-block need appears.

Deliberately not in this pass by default: threading the field alone touches
no agent-facing surface, and inventing the read form here would out-design
the need before the posture fix has landed — the Timing section's prevalence
gate is the one thing that can pull move 1 forward into the pass. Record
both moves when this plan ships so the next session finds them instead of
re-deriving them.

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
  args); `SOURCE_PRESERVING_EXPORT_OPTS` is frozen and carries the four
  documented values, reachable from the read barrel (the `index.test.ts`
  sweep enforces the re-export mechanically).
- **Primitives live (the falsifier for the knob semantics)**: export a doc whose
  title contains `&`, `<`, `>` and whose body opens with its own H1 and a `---`
  thematic break; assert the body-only export carries no frontmatter, no
  title H1, no IAL, and the body present via `toContain(originalBody)` rather
  than byte equality. The predicates, named: `!content.startsWith("---")`
  (no frontmatter), the doc title appearing nowhere as a leading `# ` line,
  the body's own H1 appearing exactly once, no `{: ...}` IAL tail, plus the
  `toContain(originalBody)` presence assert — the export re-renders through lute (`SetSanitize(true)` and
  friends), so byte identity is stronger than the fix needs and would flake on
  fixtures; the repo's existing live style is `toContain`
  (`readPins.live.test.ts:452`). Nothing is timestamped in body-only output,
  so no wildcarding. Place it next to the existing `docMarkdown` live
  case. The two posture live cases call `docMarkdown` with
  `SOURCE_PRESERVING_EXPORT_OPTS` — never hand-rolled literals — so the constant
  itself joins the falsified surface and cannot drift from its evidence.
- **Primitives live, second case (the ref/embed falsifier, and the
  refMode-0 fall-through falsifier)**: export a ref-bearing doc — a block
  ref to another doc's block plus a query embed; assert structure, not byte
  identity: refs render verbatim as `((id "text"))`, there are no `[^1]`
  markers and no footnotes section, and the embed's content appears as a
  quote block. Because the posture itself rides refMode 0, the verbatim
  assertion doubles as the fall-through falsifier: if a future kernel gives
  the switch a case for 0, this pin fires and forces a re-read of the ref
  story before any release rides on the fall-through. Like the ref-free
  fixture above, this case asserts containment and absence, never byte
  identity. Both primitives live cases falsify what the knobs do; the
  shipped dialect is pinned tool-side by the gnubrain unit and integration
  cases below — layer 2 only passes through, so it cannot be the dialect's
  falsifier.
- **Gnubrain unit**: `runRead` passes `SOURCE_PRESERVING_EXPORT_OPTS`
  (imported from the read barrel) and the writeCreate duplicate-stop excerpt
  passes the same constant (client stubs via the `deps` seam — the recording
  stubs in `writeHarness.ts`, `tools.test.ts`, and the primitives'
  `readStub`/`writeStub` record the opts alongside `id`);
  `READ_DESCRIPTION`/`QUERY_DESCRIPTION` wording pins updated — the four
  contract sentences join the existing markers case
  (`tools.test.ts:453-460`): rendering-not-a-serialization, refs render
  verbatim and round-trip, the unconditional embed-snapshot warning, and
  the no-fresh-source / not-a-byte-exact-backup sentence; `QUERY_DESCRIPTION`
  gains the `blocks.markdown` column name with its index-lag caveat. The integration counting wrapper
  (`encryptedNotebook.live.test.ts:54-73`) forwards the new second parameter:
  its `Object.assign(Object.create(client))` cast would otherwise keep
  compiling while silently dropping the opts, so the wrapped `kb_read` serves
  kernel-default markdown — frontmatter + title H1 — with the case still
  passing on `status === "ok"`: exactly the stale-dialect drift the other
  pins exist to catch, hiding behind a cast.
- **Gnubrain integration**: `kb_read` a doc → `kb_write create` (fresh topic,
  inline paste) → `kb_read` the new doc → zero frontmatter lines, no
  fabricated title H1 (the body's own headings appear exactly once), body
  present via `toContain` with absence asserts for frontmatter and the
  duplicate H1 — the same containment/absence standard as the primitives'
  live cases, for the same reason (the write path re-parses markdown
  through lute, so byte identity would flake on the same fixtures). One
  assertion standard across both suites.
- **Gnubrain integration, ref re-import (the dialect's load-bearing claim,
  which no other planned case falsifies)**: `kb_read` a doc whose body
  carries a block ref → `kb_write create` with that body → assert the refs
  index answers — `backlinkCheck` (read barrel) or `SELECT … FROM refs WHERE
  def_block_id = <target>` — naming the new doc/block. Static evidence says
  the claim holds (`util.NewLute()` sets `SetBlockRef(true)` on the write
  path); this case turns it into a pin, since the other planned cases only
  pin the export side and the plain-body round trip.
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
  it is settable for the same reason); conf-only knobs with no request
  override on this endpoint are unpinnable and stay covered by the
  rendering-not-serialization wording. The unpinnable set is everything the
  export engine seeds from config — not just the marker knobs (tag markers,
  ref text markers, `fileAnnotationRefMode`, `inlineMemo`) but
  `model.NewLute()`'s other Conf inputs
  (`Conf.Export.ParagraphBeginningSpace`,
  `Conf.Editor.CodeSyntaxHighlightLineNum`, `Conf.Editor.DisplayNetImgMark`,
  `Conf.Editor.Spellcheck`, and the workspace custom-emoji map): each must
  be verified live for markdown-output visibility before being declared
  inert in the wording — the enumeration is the upgrade sweep's checklist,
  and an incomplete list is the failure mode the rule exists to prevent.
- `gnubrain` version-coupling list gains one line: **body-only,
  source-preserving read posture** — kb_read serves the primitives'
  `SOURCE_PRESERVING_EXPORT_OPTS` (frozen constant beside `docMarkdown`,
  `byId.ts`) → this repo keeps only the description wording; no kernel
  numbers or request args live here → falsifier: the primitives' body-only
  and ref-rendering live cases (built on the constant), plus this repo's
  `runRead` unit pinning that the constant is what reaches the client, and
  the integration round-trip cases (plain body, and the ref re-import case)
  pinning the landed shape — together they are the dialect's falsifiers,
  since the primitives' live cases only falsify knob semantics. The entry
  also carries the mechanism the tool description no longer states: the refs
  index counts block refs but never block links (`refsFromTree` reads
  `IsBlockRef`/`IsFileAnnotationRef`/`IsEmbedBlockRef` only,
  `kernel/sql/database.go:545-574`; a `siyuan://blocks/<id>` link parses as
  `IsBlockLink`, `treenode/node.go:144`), so the verbatim dialect keeps the
  refs/backlink edge where a link-form dialect would silently drop it;
  "config-independent" is claimed only for the four pinned knobs — the
  remaining conf-seeded rendering knobs (see the layer-1 rule above) stay
  covered by the rendering-not-serialization wording until verified inert.
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
  `SOURCE_PRESERVING_EXPORT_OPTS` constant are documented at their definition site
  (`byId.ts` JSDoc) and in the `AGENTS.md` `byId.ts` entry below — the single
  greppable home for both the signature and the posture, which the README
  would only duplicate and let drift.
- `siyuan-kb-primitives` AGENTS.md: update the `byId.ts`/`docMarkdown` entry for
  the opts threading (four knobs, pass-through, no posture), the exported
  `SOURCE_PRESERVING_EXPORT_OPTS` constant (the four values, frozen, beside
  `docMarkdown`), and the knob semantics its live cases falsify (body-only,
  verbatim ref rendering — which doubles as the refMode-0 fall-through
  falsifier since the constant rides refMode 0, embed quote materialization)
  — the posture cases constructed from the constant, so the fact and its
  falsifier share one home; the shipped dialect itself is pinned tool-side
  in gnubrain, since layer 2 only passes through. The entry also carries the
  mechanism sentences the tool description drops: ref re-import via
  `SetBlockRef(true)` on the write path, the refs-index vs block-link
  asymmetry, and the IAL/tab/memo materialization caveats.
- All three repos' CHANGELOGs gain drafted `[Unreleased]` entries in the same
  pass — the release scripts promote `[Unreleased]`, and publish order stays
  bottom-up.

## Timing

Fix before v1 — preventive, not corrective: the sweep
`SELECT COUNT(*) FROM blocks WHERE type='p' AND content LIKE '%lastmod:%'` returns
0 in the live workspace — that is the YFM/title-H1 arm only. The refMode-4
arm leaves `[^1]` markers plus referenced-block content as body paragraphs,
so the second arm is
`SELECT COUNT(*) FROM blocks WHERE type='p' AND content LIKE '%[^1]%'`
(authored literal `[^1]` is indistinguishable — the write path never parses
footnotes, `SetFootnotes(false)`, `kernel/util/lute.go:82` — so a nonzero
count is a hypothesis, not a verdict). Re-run both in any other workspace
before declaring the class closed. The same evidence gate governs the parked
source-form read: a refs-table count plus an embed scan (`markdown LIKE
'%{{SELECT%'` on body blocks) decides by prevalence whether the source-form
read pass (moves 1+2) is worth running at all — pull it forward if
ref/embed-bearing docs are common in target KBs, keep it parked if they are
dormant; move 1 never ships alone (see *Parked*).
