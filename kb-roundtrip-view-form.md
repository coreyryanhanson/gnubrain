# kb_read view form: metadata wrapper + refs/embed appendix

Status: **specified, deferred.** An additive later release, built only on top
of the shipped body-form read. Its precondition and the additive guarantees
it relies on are provided by the shipped body-form read (siyuan-kernel-primitives/body.ts): `docView` composes `docBody` and re-fetches nothing, the
read flag is an optional addition to a knob-free schema, the envelope gains
fields without reshaping, and the wording appends. The corruption fix does
not wait for this doc — the body form alone closes it.

## Problem this form solves

Not corruption — no export-rendering body-source primitive exists. The raw
endpoint remains reachable through the layer-1 identity surface, and the
tool-layer gate rule is the guard there. The view form is a
reading-convenience form for three cases the pointer-preserving
body leaves to the agent:

- **Ref-dense docs**: with the body form, each ref is a pointer the agent
  dereferences with its own `kb_read` — one call and one envelope into
  context per ref. The view form inlines every target's content in one call,
  so the economy case holds exactly when the agent wants most of a ref-dense
  doc's targets (one targeted `kb_read` stays cheaper when the agent wants
  one).
- **Metadata alongside the body**: title, dates, tags in one read (via an explicit opt-in, as metadata is dropped from the body read and must be explicitly requested via additional fields).
- **Embed results inline**: the current result of each `{{SELECT …}}` script,
  resolved at read time.

## The two-forms contract

Both forms render the same stored body bytes; `docView` is a pure composition
over `docBody`. The body form is the body source for writes. The view
form adds a wrapper we author and appendices we generate — display bytes,
never a body source.

## Header wrapper

Frontmatter-style metadata (title, dates, tags) plus a sentinel line — an
HTML comment stating this is a rendering, not a body source, and that editing
requires re-reading in body mode. The sentinel teaches at read time and is
the gate's recognition target. The sentinel must be the stable part of the
wrapper: variable content (dates, counts, title) goes around the marker
line, never inside it — wrapper format and gate recognition are one decision,
not two.

## References appendix

The body is never rewritten — pointers stay inline `((id "text"))`, where the
kernel's own refMode 4 rendering destroys them. The appendix enumerates the
doc's refs and resolves each target's content: same-doc targets free from the
walk, cross-doc targets in one batched fetch, each entry carrying anchor
text, target id, and content.

The kernel facts this rides:

- **Refs, not links.** The kernel's refs index counts block refs but never
  block links: `refsFromTree` reads `IsBlockRef`/`IsFileAnnotationRef`/
  `IsEmbedBlockRef` only (`kernel/sql/database.go:545-576`), and a
  `siyuan://blocks/<id>` link parses as `IsBlockLink`
  (`kernel/treenode/node.go:144`). This is the integrity reason the pointer
  form is the body's only ref form — a link-form rendering would silently
  drop the refs/backlink edge on every read-modify-write.
- **General embeds are not ref rows.** `IsEmbedBlockRef` matches only
  `{{SELECT …}}` scripts carrying a `WHERE id = '<block-id>'` clause
  (`GetEmbedBlockRef`, `kernel/treenode/node.go:59-100`); any other embed is
  not in the refs table at all, and embed ref rows carry empty
  `Content`/`Markdown` (`database.go:627-660`). The refs index is therefore
  the enumeration for refs only — **embeds are enumerated from the served
  body's `{{…}}` scripts**, never from the refs table.

Dependency to build, disclosed: the appendix needs a doc's *outgoing* refs,
and `refs.ts` holds only `backlinkCheck` (inbound). That is a new read
primitive (SQL statement + falsifier) — new layer-2 surface, not a hidden
reuse.

## Embed appendix

Each embed script in the body is resolved and shown with its current result;
an unresolvable embed degrades to the verbatim script plus a note. Wording
states that appendix content is a display snapshot (it rides the SQL index,
so lag is possible) — cosmetic, never a write-judgment input.

Placement constraint (doctrine, not preference): embed resolution must not
move into the primitives. `{{SELECT …}}` is arbitrary authored SQL, and
scoping it is a tool-surface problem — `sqlScope.ts` (certify/rebuild/
verify) lives in gnubrain precisely because the primitives' own statements
are hand-built with fixed heads and no parser. Two admissible shapes, decide
before building: (a) no resolution in the read path at all — the appendix
serves the verbatim script plus a pointer to run it with `kb_query`; or
(b) `docView` composes `docBody` and the *tool layer* supplies resolved
rows for the appendix. Shape (a) is smaller and keeps the primitives
parser-free; shape (b) buys one-call convenience at the cost of threading
resolved rows through the envelope.

## The gate — decided: sentinel bytes only

The principle: recognition is sound only over bytes the recognizer's owner
authored. The wrapper and appendix are the only bytes we author in a served
payload, so a deterministic sentinel line inside the wrapper is the only
sound provenance signal — the same reasoning that rejects write-side
frontmatter recognizers (kernel-generated bytes are indistinguishable from
authored ones) and rejects session-head matching:

- Session-head's provenance coverage includes the body form, whose
  write-back is the supported round-trip — its false-positive class is the
  product's core loop (read → edit → write, and the plan's own integration
  case).
- It needs a payload-head store `baselines.ts` does not keep (it holds
  content hashes, keyed by block id, deliberately never seeded from served
  markdown).
- It cannot see payloads served before a restart, and it has no teaching
  value — enforcement only.

The asymmetry that settles it: a false refusal blocks the supported loop
with redirect wording that cannot fix the bytes; a missed sentinel costs a
bounded, visible pollution event the agent can see and clean. Prefer the
mechanism with no false-positive class over the one with maximum coverage.

**Resolved here, not deferred**: the gate slot is after body resolution (so a
`markdownFile` body is inspected — the file-read-before-probe ordering is
already a pinned unit in `writePrepare`) and before KB resolution/probe —
zero kernel calls, zero dialogs, riding the existing gate ladder. And the
refusal wording names the view rendering and points to body mode; it never
implies that read output or read spill is an unsupported content mechanism.

**Deferred specifics (open questions)**:

- Sentinel text and wrapper format: which metadata keys, date formatting,
  marker wording.
- Match semantics: fire on any exact sentinel-line occurrence vs
  head-anchored only. (Any-occurrence is the current leaning: the only
  false-positive case is an agent hand-authoring the exact line, which in
  practice means echoing served output — the case being caught.)
- One sentinel vs two (head + tail). Two is the current leaning: a
  stripped-head paste still trips the tail marker, and stripping both leaves
  the plain body plus visible appendix bytes — the residual evasion is
  harmless by construction, which is the containment property actually
  wanted.

## Cost budget

The view form is one walk + one refs enumeration + one batched content fetch
+ one SQL round-trip per embed, appended to a body that may already exceed
`PREVIEW_CHARS` — the appendix can push a normal doc into spill. Appendix
content rides the SQL index (lag), and same-doc targets carry ref-stripped
`content`, so a nested ref inside a target renders as anchor text, hiding a
pointer. Budget this before building; it is the largest new code surface in
the two-form design and the reason the form was deferred.

## Ship-together rule

The wrapper, appendix, sentinel, gate leg, `view` flag, and wording land as
one change, or not at all. A wrapper without a gate invites paste; a gate
without a wrapper has nothing to recognize; an appendix without the
outgoing-refs primitive has nothing to enumerate. There is no partial ship
of this form.

## Wording (agent-facing, additive)

- The view form adds metadata and an appendix for reading convenience; it is
  never a body source — re-read in body mode to edit.
- Embeds in the body stay live scripts; the view appendix shows their
  current result as a snapshot (index-lagged; cosmetic, never a
  write-judgment input).
- Block IAL is not carried in either form: `name`/`alias`/`memo`/`custom-*`
  attributes do not round-trip.
