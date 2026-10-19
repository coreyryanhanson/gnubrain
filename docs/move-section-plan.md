# Move-section — design

Status: **Held — codec decided (§2, spike-confirmed); §6 duties recorded, implementation pending**

> **Foundation landed; §1 and §3–§5 predate it, §2 is re-derived onto it.** §5's non-goal "No kernel-side section API"
> is **false** for the pinned 3.8.7 — `POST /api/block/moveOutlineHeading` moves a
> heading plus its whole section atomically, fold-blind, landing exactly at
> end-of-destination-section (`kernel/model/outline.go:29`; already documented in the
> primitives' AGENTS.md). And `/api/transactions` is the kernel's real multi-op
> transaction endpoint, now exposed: layer 1's `transact` plus the primitives'
> `batch.ts` (`transactThenWalk`) landed, first consumed by the batched
> `delete-section` — §2's hardest machinery (the two-phase judged sequence, the
> partial-apply receipt) existed only because the plan issued N+1 separate
> `moveBlock` calls, and batching dissolves it. The route is **decided: batched
> `move` ops** (§6 records the decision and the re-derivation duties;
> `moveOutlineHeading` is rejected on the record: its unconditional level rewrite,
> same-doc/root-level ceiling, and silent `PushMsg` rejections). The codec is
> **decided: the insert-before (`nextID`) arm** — members in document order onto
> the destination section's boundary, then the heading anchored before the first
> landed member — with the doc-end arm's leaf-anchored chain where no
> boundary exists (§2, §4) — live-confirmed by
> [`move-section-spike.md`](move-section-spike.md); the two-phase judged
> sequence and the pending-set receipt do **not** survive the re-derivation (§6).
> The kernel facts the re-derivation rides live in the primitives' AGENTS.md fact
> list (the "batched delete route" entries: batch rollback and its `blocktrees`
> residue, ack-time commit-wait, the ≥32-op cliff, queue ordering). The surviving
> §2 content — the fold-blind posture and the fresh-guard scoping — carries
> over; the anchor-stability law and the reverse-order derivation are dissolved
> by the codec decision (§2). Two decisions sit beyond the superseded
> sections (§6): the landed arm certifies the moved heading's new
> owner, and cross-doc is in v1 scope (this mode is the multi-doc
> consumer `batch.ts`'s `walk-failed` arm defers to).

Origin: friction §2/§3 in [`../kb-write-friction.md`](../kb-write-friction.md).
The **corruption half of heading-move is already closed** — `moveBlockVerified`
refuses section-bearing heading targets fold-blind and pre-mutation
(`heading-with-section`, plus the matching anchor arm
`heading-anchor-with-section`), because the kernel's move scope for such
headings is fold-dependent hidden state (`resolveHeadingMoveChildren` returns
section children only when `treenode.IsSelfFolded(srcNode)`,
`kernel/model/transaction.go`). So this mode is an **efficiency and
expressiveness fix, not a safety fix**.

## 1. Why this mode is pursued

(The per-leg economics below is superseded by §6's one-batch route.)

The foundation this sequence composes is complete — delete-section landed
the batched-route plumbing and the enumerated loop shape (§3). And the problem this mode solves is **packaging, plus one
capability the manual path cannot give**: the sequence it automates is
already expressible today, and the refusal wording itself advises it (move
the members individually against a derived section-end anchor, then the
emptied heading) — but no existing path answers where a moved section
actually attached (§2's owner certification). What is missing is doing it in
**one call** — order enforced and verified by construction, one group
receipt — instead of ~2N+1 `kb_write` round trips. That efficiency for agent-driven workflows, plus closing the
silent-corruption trap in the manual sequence (wrong ordering strands
content), is why this mode is pursued rather than deferred — the design is
re-derived onto the batched route (§6), and what remains is
implementation.

## 2. What the mode must solve

- **Landing semantics: end of the destination section, on the
  insert-before arm.** The batched route issues raw `move` ops, and
  `doMove` reads `operation.NextID` first (`transaction.go:695-700`):
  `nextID` inserts the moved node *immediately before* the anchor — the
  `moveBefore` branch, which the fold redirect cannot reach (`!moveBefore`
  guards it, `transaction.go:773-780`), so any anchor is a literal
  position, fold-blind. The codec: **every member of the source section's
  run in document order, each `nextID = <the destination section's
  boundary>`** (the next heading at level ≤ the destination heading's, in
  the caller-held destination walk — `sectionOf`'s boundary), then **the
  heading `nextID = <the first member's id>`** — the members accumulate
  in document order before the boundary, and the heading lands between
  the section's last pre-existing block and the first member:
  end-of-section semantics, no reverse order. A memberless section issues
  only the heading leg (`nextID = <the boundary>`). A destination
  section with **no following boundary** — the doc's last section — has
  no `nextID` address; there the codec switches to the **leaf-anchored
  chain** (§4): the members chain `previousID` in document order from
  the destination section's last non-heading leaf, and the heading
  issues **last**, anchored on that same leaf, landing between the leaf
  and the first member — the same end-of-section semantics (spike K1:
  exact landing unfolded, with the source heading folded, and with the
  nested subsection folded; K2: `InsertAfter` at a shared anchor is
  LIFO across ops, which is why the leaf-anchored heading leg must
  issue last). A doc-end destination whose last block is a heading is
  refused (§4). The
  `previousID`/LIFO alternative — reverse document order onto a
  non-heading anchor — was the only shape the per-leg route could reach;
  it is live-confirmed as a baseline (spike case C) and rejected: with
  the insert-before arm reachable it keeps every hazard the next bullet
  records and none of the reach. A start-of-section landing is out of scope
  (§5): inserting a same-or-shallower heading at a section's *start*
  re-bounds the destination
  heading's section — the destination's body would become the moved
  section's body — and the prepend arm it would need is live-pinned
  unreachable.

- **Anchor stability: dissolved by the arm choice; the per-id path keeps
  its own refusals.** The fold redirect (`transaction.go:773-780`) fires
  only when the anchor side is `previousID` (`!moveBefore`) *and* the
  anchor is a heading: "after this heading" then means "after the
  heading's whole section" self-folded — hidden state this package never
  reads — and such an anchor is **single-use** under a multi-op sequence
  (its first landing makes it section-bearing, so every later leg
  addresses a silently flipped position behind unconditional HTTP
  success). That analysis governed the per-leg baseline and still
  governs the per-id move path, whose fold-blind refusals
  (`heading-with-section`, `heading-anchor-with-section`) stay exactly as
  they are. On the batched route the decided codec's anchors are
  `nextID` positions — the destination section's boundary for every
  member leg, the first landed member for the heading leg — so no
  anchor is ever re-addressed after the state it names changes. The
  doc-end arm's chain (§4) is the characterized exception: its
  `previousID` anchors are stable per leg, and the leaf — the one
  anchor addressed twice, by the first member leg and again by the
  heading leg — is re-addressed deliberately, to land the heading in
  the gap the member legs opened (K2 is the LIFO proof the heading leg
  must issue last); a member leg anchoring on a landed heading member
  can hit the fold redirect, which self-inserts the member into its
  already-correct place (K1h2). No stability classification is
  needed: the planned `stable` /
  `single-use` / `unstable` predicate is dropped from this mode's scope,
  and the prose-only `MoveAnchor` precondition keeps its prose status
  until a consumer with a real need retires it.

- **The moved set.** `sectionOf(sourceHeading).members` in **document
  order**, then the heading. Every block of the run is issued,
  sub-members included: the kernel's ride-along is fold-dependent and
  fold is invisible, so an unfolded subsection heading moved alone
  strands its body in the source, while a folded one drags it — in
  document order, and re-issued in the same order each member keeps its
  place (spike cases B/B2). Only descendants *below* the run's blocks (a
  list's items) are never issued — they ride their container. State and
  pin this; an implementer who "simplifies" the set strands subsection
  bodies in the source.

- **The judged sequence: mutate → judge → mutate → judge.** *(Stale under the
  batched route — §6's acceptance criterion dissolves the two-phase shape; kept
  as the per-leg baseline the re-derivation starts from.)* The heading
  leg is safe only if the member legs *actually landed* — a silent per-leg
  no-op (skip-class rejections ack with unconditional HTTP success) would
  leave `H` section-bearing when its leg runs, and a folded `H` would drag
  its remaining children. Trusting acks is not how this package moves
  blocks; and a judgment placed after the last fold-sensitive mutation is
  a post-mortem, not a safety net. So the sequence is two judged phases, the
  `replaceSectionVerified` shape:
  1. **Member phase.** The reverse-order legs onto the stable anchor, then
     one complete walk per touched doc and the member judgment: the
     enumerated members present in the destination in expected order (the
     run immediately after the anchor is `m1 … mN`) *and* absent from the
     source. Absence is sound only on a complete walk (the `WalkedTree`
     truncation invariant), so the judgment carries an explicit truncated
     arm. Abort here on any miss: `H` is untouched.
  2. **Heading leg.** The emptied heading onto the same stable anchor,
     then the final walk and the destination judgment:
     `sectionOf(destWalk, H).members` **starts with** the enumerated
     member sequence — a prefix, never equality: a shallower moved heading
     legitimately claims following sections (the outline side effect
     below).
  Same-doc, one walk serves both roles at each judgment point; cross-doc,
  each judgment takes its own doc's walk. Two judgments instead of N+1
  per-leg verdicts — the one-call economy survives. This mode joins a rule the primitives
  already obey twice (replace-section, delete-section) and should state in
  their AGENTS.md: **every precondition in a multi-leg sequence is either
  held by construction or re-judged after the legs that could break it.**

- **Partial-state semantics.** *(Stale under the batched route — superseded by
  §6's all-or-nothing arm; kept for the per-leg baseline.)* Mid-sequence
  failure leaves members moved and the heading (and any un-moved members)
  behind — the receipt must say exactly what moved, in what order, and where
  the remainder sits, rendered from the member phase's judgment walk (never
  from an ack prefix). The honest sentence is that **the section is split
  between two places**; the receipt must never read as loss and must not reuse
  delete's vocabulary ("gone"). Reuse the generalized partial plumbing's
  *mechanism* (the partial-apply state and marker in `envelope.ts` /
  `writeVerdicts.ts`), not a second copy.

- **Fresh-content scope: moves stay unguarded.** The fresh-content
  precondition stays scoped to the four destroy-shaped primitives (edit,
  delete-block, replace-section, delete-section). A move destroys nothing —
  a member whose content changed since the baseline travels with its new
  content — so a content precondition is the wrong instrument here; the
  mode's protection against misplacement is the landed-order judgment over
  the live post-move walk (above). Guarding the group while the per-id legs
  stay unguarded would judge identical content differently by path, so the
  line is drawn at the primitives level: **no move mode carries the guard**.
  The rationale is recorded in the tool-side fact list when the
  re-derivation lands (§6), so the absence reads as a decision, not an
  omission.

- **Landing is level-blind; the judgment certifies the owner, not just
  the order.** Landing is end-of-section for every level, but the
  section rule re-bounds the landed heading differently by its level
  relative to the destination section's **boundary** (the next heading
  at level ≤ the destination heading's — the codec's own anchor):
  - A moved heading **strictly shallower than the boundary** is not
    terminated by it: the moved section swallows the boundary heading
    and everything after it, up to the next heading at the moved
    heading's level or shallower. The landed section is larger than
    what was moved — the outline side effect, documented behavior
    stated in the tool description.
  - A moved heading **at the boundary's level or deeper** is terminated
    by the boundary and claims nothing beyond the moved members: at the
    destination heading's level it lands as a following sibling;
    deeper, it lands **inside** the destination's section and nests
    under the destination heading (owner: the destination heading, or a
    deeper heading within the destination section that precedes it).
  The prefix judgment alone passes in every case, so the landed arm
  certifies the moved heading's **new owner** (the nearest preceding
  shallower heading in the destination walk) alongside the order, and
  the receipt says where the section actually attached — including the
  swallow case, where the destination's boundary changed hands. This is
  reporting, not a level rewrite — the mode still never rewrites levels
  (§5); the projection is a read off the walk the verdict already
  holds, not new verification machinery.

- **Cross-doc scope.** Each leg is a same-kernel `move` op; a cross-doc
  destination is in scope and rides the existing cross-doc move semantics
  (the per-id path's membership-only checks); the group's landed judgment
  is §6's predicate. Nothing new is invented here — state it, don't
  discover it.

## 3. Preconditions before implementation

Before writing the implementation plan:

1. **Delete-section has landed — on the batched route.** The foundation is
   layer 1's `transact` plus the primitives' `batch.ts` (`transactThenWalk`);
   delete-section rides the batched route; the batched move composes the
   same foundation with its own judgment sequence (the no-shared-core rule: each
   batched mode owns its judgment; the walk helper is the only shared code).
2. **A live probe, before any product code.** All legs are executed —
   [`move-section-spike.md`](move-section-spike.md) holds the full record:
   the codec matrix (previousID baseline; nextID heading-first and
   members-first; folded source under both; empty destination; skip-class
   rollback) and the owed legs — the **doc-end destination arm** (all-empty
   anchors roll back; `parentID` prepends at doc start; the leaf-anchored
   chain lands the heading before its members (K1, all three fold
   variants); a heading anchor at doc end is fold-**dependent in order**,
   F4a/b), the **legality-check
   rollback** (`TxErrCodeReloadUI`, whole-batch behind code 0), the
   **cross-box skip arm** (encrypted→plain whole-batch rollback) and the
   plain↔plain cross-notebook **success landing**, the **cross-doc residue
   round trip** (wrong-root row → `getBlockInfo` not-found; destination
   write heals nothing; source write restores; heal-then-retry lands
   whole), and the **≥32-op batch** (per-op path, 36 ops / 341 ms, lands
   whole). Their transcript is the implementation plan.

   The spike readings are transcript evidence, not pins. The live suite
   must rehearse what the mode rides so an upgrade pass falsifies them
   in place rather than trusting a transcript that dies with the next
   kernel upgrade: the folded-source readings under the decided codec —
   every fold combination of the source heading and its nested
   subsection headings (the drag and its redirect interaction, cases
   B/B2/F5) — the doc-end fold-dependence (F4a/F4b, the ground the §4
   refusal stands on) and the doc-end chain's fold variants (K1, the
   ground the §4 chain form stands on) — and the ≥32-op batch with a
   completion-latency
   assertion, not landing alone (36 ops / 341 ms is one sample).

## 4. Refusals the mode must add

Group-level, pre-mutation, zero kernel calls — conditions that per-leg
checks would otherwise only surface mid-sequence, after the tear:

- `toHeadingId` names the moved heading itself (identity), or the
  destination section is one the moved section contains.
- The group is **already at the destination** — derived two ways: the
  destination section's boundary lies inside the moved set (the boundary
  heading ∈ `sectionOf(sourceHeading).members ∪ {H}`; e.g. with `# A /
  a1 / ## B / b1`, moving B's section onto the end of A's section makes
  `B` — the moved heading — the destination's boundary), or the moved
  section is the destination section's **trailing run** — the moved
  heading lies inside the destination section and no member of the
  destination section follows the moved section's last block (e.g. with
  `## B / b1 / ### D / d1 / ## C / c1`, moving D's section onto the end
  of B's section: the boundary `## C` is outside the moved set, so the
  first arm misses, yet D's section already occupies the destination's
  end). One refusal,
  never a partial receipt with an empty moved set; on the batched route
  the alternative is the kernel's own skip arms (`TxErrCodeSkipTx`),
  which roll the whole batch back behind a success ack (spike case E).
- There is **no following boundary** — the destination section is the
  last section of its doc and the codec's `nextID` arm has no address
  there. The arm is characterized (spike F, K): an all-empty-anchors op
  rolls the batch back (`TxErrCodeBlockNotFound`, invisible),
  `parentID: <docId>` prepends at the doc's start, and the workable
  doc-end arm is the **leaf-anchored chain** (§2) — members chain
  `previousID` in document order from the destination section's last
  non-heading leaf, and the heading issues **last**, anchored on that
  same leaf, landing between the leaf and the first member (K1: exact
  landing in all three fold variants — unfolded, folded source heading,
  folded nested subsection; the heading leg runs last over an emptied
  section, no drag, and the leaf anchor never redirects). Refused
  pre-mutation, zero kernel calls, whenever the destination section's
  last block is a heading — heading-anchored doc-end forms land in a
  fold-**dependent order** (F4a/F4b: unfolded reverses, folded
  redirects into order), and the heading chained after the last member
  (F3's order) detaches the moved body from its heading entirely (K2:
  `InsertAfter` at a shared anchor is LIFO across ops, so the
  leaf-anchored heading leg must issue last). Same fold-blind posture as
  the per-id path's heading-anchor refusals; the route-out is a
  destination section whose last block is a non-heading leaf (the chain
  form) or the per-id path.

## 5. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4; the
  demotion idiom is documented in the `kb_write` tool description).
- No start-of-section landing and no heading-level rewriting —
  end-of-section only (§2).
- No kernel-side section API. *(False for the pinned 3.8.7 — `moveOutlineHeading`
  exists and is rejected on the record; see the header note above.)*
- No new refusals on the existing move path beyond the fold-blind refusals
  already in place.

## 6. Re-derivation duties on the batched route

These are the duties the implementation must satisfy; the route and
codec decisions they build on are recorded in §2.

- **The route: one batched `move` transaction.** Members in document
  order onto the destination section's boundary (`nextID`), then the
  heading anchored before the first landed member — the decided codec
  (§2, spike-confirmed), with the doc-end arm's leaf-anchored chain
  where the destination section has no following boundary (§2, §4,
  spike K1) — as raw `move` ops in one `/api/transactions`
  call, judged from the per-touched-doc post-write walks
  (`transactThenWalk`).
  Move's batch always takes the kernel's per-op execution path (the ≥32 bulk
  path requires an all-delete batch), so the cliff is not this mode's
  interaction. The drift posture is the batched precedent's: the batched
  route has no drift arm of its own — the primitive owns the probe and the
  `drift` arm, refusing before issuing (delete-section's shape, recorded in
  its union docstring); the gate's cached-verdict refusal stays as
  defence-in-depth.
- **Cross-doc is in v1 scope.** The judgment is
  per-touched-doc post-write walks, so this mode extends `batch.ts`'s
  `walk-failed` arm to carry the partial walks its docstring defers to
  "a multi-doc consumer" — this mode is that consumer. The extension
  lands in the primitives unpublished, `file:`-linked, its shape
  perfected side by side before either repo releases. The destination side composes the
  caller-provenance gate delete-section models (`foreign` /
  `walk-truncated`): the anchor derives from a caller-held destination
  walk, and the kernel mutates by raw block id with no doc scoping of
  its own. Cross-**box** is policy, not kernel behavior: the kernel
  accepts plain↔plain cross-notebook moves natively (spike H2) and
  silently rolls back cross-crypto-boundary batches (`IsSameCryptoBoundary`
  → `SkipTx`, spike H1) — the mode scopes the destination doc to a
  granted KB and refuses cross-box pre-mutation, zero kernel calls.
  Single-doc v1 would make the automated route narrower than the per-id
  path it replaces, and a later cross-doc release would pay a second
  wording/probe/pin ship. Two `batch.ts` duties ride the same extension:
  the docstring's "consumers keep the batch single-doc" sentence is
  amended to its real scope — the ≥32 bulk path is all-delete, so the
  single-doc habit was delete-route hygiene, not a batch constraint —
  otherwise it reads as forbidding this mode's consumer; and the
  `walk-failed` arm's partial-walk payload ripples into
  `delete-section`'s exhaustively-switched arms and wording, which must
  compile and read correctly against the widened union.
- **The cause-free all-or-nothing arm covers move's batch.** Every skip arm
  reachable from move ops lives in the move paths, and skip-class rejections
  plus `TxErrCodeReloadUI` become silent rollbacks under the batch — the
  least informative envelope landing on the mode with the richest failure
  semantics; the skip-class half is live-confirmed (spike case E). That
  is the accepted trade, and a deliberate departure from
  `docs/replace-section-followup.md` §2, which keeps a prevention leg in
  its own transaction: all move legs are the same op class, and every
  skip arm reachable from them rolls the batch back whole, so
  detection-after-the-fact is the honest posture here. If the
  re-derivation surfaces a move failure class the cause-free arm cannot serve
  honestly, the route re-opens. No HTTP-visible batch failure channel exists
  (the kernel publishes reasons only on the editor websocket's `txerr` push,
  which a zero-dep HTTP client does not speak; `undoState` reads dead for
  API-originated writes; doc history is an async delayed task) — carrying a
  failed-batch failure reason stays off the table unless a kernel release
  grows an HTTP-visible channel.
- **What must not survive the re-derivation (acceptance criterion):** the
  two-phase judged sequence (§2's "mutate → judge → mutate → judge") and the
  "split between two places" pending-set receipt. One call, one post-write
  walk per touched doc; `transact` is
  one call, so the only throw is post-issue pre-ack — no walk can certify
  state, and the transport-unverified frame carries the whole judged set as
  its unconfirmed payload. The landed judgment is a stated predicate over
  the destination walk, not a phrase — an unstated formula invites a
  membership-only check, which reads a fold-inverted group (body above
  its heading) as landed. The landed predicate: the run `[H, m1 … mN]` occupies the position
  immediately before the destination section's boundary (the codec's own
  anchor), as the caller-held walk holds it — a memberless moved section
  lands `H` alone immediately before the boundary, an empty destination
  section contributes no block between its heading and the boundary, and
  both degenerate shapes reduce to the same clause. The doc-end arm has
  no boundary; there the run occupies the position immediately after the
  destination section's last pre-existing block (the leaf-anchored
  chain's landing, spike K1). `sectionOf(destWalk, H)
  .members` **starts with** the enumerated member run — a prefix, never
  equality, because a moved heading strictly shallower than the
  boundary legitimately claims following sections into itself (§2's
  ownership bullet: the outline side effect), a tolerance bounded by
  the owner certification: order may under-report what follows the
  moved section, never where the section attached. The
  members are **absent from the source walk**; a truncated walk refuses
  (`walk-truncated`) rather than asserting absence. Beside the order,
  the judgment certifies the moved heading's **new owner** (the nearest
  preceding shallower heading in the destination walk), so both
  divergences — the strictly-shallower swallow (the section takes the
  destination's boundary heading and the sections after it with it) and
  the deeper landing (the section nests inside the destination's) —
  surface in the envelope instead of passing the prefix test silently;
  the ownership projection is reporting off the walk, never a level
  rewrite.
- **The document-order member derivation replaces the reverse-order one.**
  The batched route issues raw ops, so the per-leg `heading-with-section`
  refusal that guarded a forward-ordered derivation is not in the loop;
  the folded-source readings are spike cases B/B2, and the set rule
  (every block of the run issued, sub-members included) is §2's.
- **Currency is as of the enumeration, and the drag makes one divergence
  silent.** The op array derives from pre-mutation walks. A block
  appended to the source section after enumeration is not in the moved
  set — but if the source heading is folded, the heading leg's drag
  transports it into the destination, and neither judgment arm sees it:
  the prefix test passes (it sits outside the enumerated run) and source
  absence passes (the drag removed it). Fold is invisible, so the
  posture assumes the transport can happen: the landed judgment names
  every block in the landed run that is in neither the enumerated set
  nor the pre-move destination walk — an unjudged presence, whatever its
  provenance (dragged source append or concurrent destination append),
  never a silent one. The destination-side displacement case — an append
  into the destination section between the boundary walk and the batch —
  fails the predicate's lead instead of passing mid-section: a
  landed-divergent arm names the displaced position. Mirrors
  `deleteSection.ts`'s "as of the enumeration" wording; the drag reading
  is spike case B.
- **The tool-side seams land with the primitive.** The new mode joins
  `writeSchema.ts`'s mode/param table as `move-section` — `docId` +
  `headingId` name the moved section, `toDocId` + `toHeadingId` the
  destination (`move` already carries `toDocId`, so this is the per-id
  shape with `blockId` widened to the section's heading) — plus
  `writePrepare.ts`'s ordered dispatch and its exhaustive tail, the
  pinned mode/param list in `__tests__/unit/contract.test.ts`, and the
  `kb_write` tool description (`write.ts`); the tool-side fact-list
  entry recording the fresh-guard rationale for moves (§2) rides the
  same pass. A re-derivation that plans only the kernel side leaves
  these to be discovered later.
- **Wording homes are named.** The primitives return the closed verdict
  unions; this repo words them, and every sentence has a home:
  - the §4 refusals (identity/containment, already-at-destination,
    no-following-boundary) — refusal-envelope wording in the new flow
    module (`writeMoveSection.ts`), exhaustive over the primitives'
    refusal union;
  - the landed arm's owner report and the landed-divergent /
    unjudged-presence sentences (the currency bullet below) — the same
    flow module, over the landed union;
  - the silent-rollback sentence (a `nothing-moved` arm, on
    delete-section's `nothing-deleted` precedent) and move's own
    residue/heal recovery wording — the same flow module, never
    delete-section's repair sentence (the residue bullet below);
  - shared fragments stay in `writeVerdicts.ts`; a new one lands there
    only when a second consumer exists.
- **Pins and suite placement.** Every §3 reading lands in a named case
  or it stays unpinned: the fold-combination matrix (cases B/B2/F5),
  the doc-end fold-dependence (F4a/F4b) and the doc-end chain's fold
  variants (K1), and the ≥32-op batch with its
  completion-latency assertion live as a batched-move pin in the
  primitives' live suite, beside `move.live`; tool-surface wording pins
  here (`writePins.live`), the mode/param list in
  `__tests__/unit/contract.test.ts`, and the integration project's
  `INTEGRATION_ORDER` gains the new flow. The upgrade checklist's
  re-run-the-suites pass then falsifies these facts in place, not
  against a transcript.
- **Move's rollback residue and heal are characterized, not assumed from the
  delete case.** Every executed move writes both trees' index rows in-tx
  (`finishMove` → `writeTree` on source and target). A same-doc rollback
  is the mild case: the root never changes, so ids stay resolvable and
  only `parent_id`/`updated` rest stale — self-converging on the doc's
  next committed write. The cross-doc rollback is the wrong-root case:
  the moved ids' rows carry the post-move layout behind the pre-move
  source tree and resolve as not-found (still never a wrong block)
  behind success acks; the heal is a committed write to the **source**
  doc — the tree that actually contains the node — never the destination
  (a destination write never walks the moved node's row). Move therefore
  keeps the conservative arm: **do not re-issue; heal first, then
  retry** — a re-issued move batch trips its own skip arms and rolls
  back again, looping until an out-of-band committed write to the source
  doc restores resolvability. The recovery wording is move's own, not
  delete-section's: the delete-section repair sentence (committed write,
  then one re-issue) re-issued here would re-trip the skip arms and
  strand the agent healing the wrong doc. The probe legs are in §3.2.
