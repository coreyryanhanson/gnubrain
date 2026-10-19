# Move-section — design

Status: **Held — codec decided (§2, spike-confirmed); §6 re-derivation duties outstanding**

> **Foundation landed; §1–§4 predate it.** §5's non-goal "No kernel-side section API"
> is **false** for the pinned 3.8.7 — `POST /api/block/moveOutlineHeading` moves a
> heading plus its whole section atomically, fold-blind, landing exactly at
> end-of-destination-section (`kernel/model/outline.go:29`; already documented in the
> primitives' AGENTS.md). And `/api/transactions` is the kernel's real multi-op
> transaction endpoint, now exposed: layer 1's `transact` plus the primitives'
> `batch.ts` (`transactThenWalk`) landed, first consumed by the batched
> `delete-section` — §2's hardest machinery (the two-phase judged sequence, the
> partial-apply receipt) existed only because the plan issues N+1 separate
> `moveBlock` calls, and batching dissolves it. The route is **decided: batched
> `move` ops** (§6 records the decision and the re-derivation duties;
> `moveOutlineHeading` is rejected on the record: its unconditional level rewrite,
> same-doc/root-level ceiling, and silent `PushMsg` rejections). The codec is
> **decided: the insert-before (`nextID`) arm** — members in document order onto
> the destination section's boundary, then the heading anchored before the first
> landed member — live-confirmed by
> [`move-section-spike.md`](move-section-spike.md); the two-phase judged
> sequence and the pending-set receipt do **not** survive the re-derivation (§6).
> The kernel facts the re-derivation rides live in the primitives' AGENTS.md fact
> list (the "batched delete route" entries: batch rollback and its `blocktrees`
> residue, ack-time commit-wait, the ≥32-op cliff, queue ordering). The surviving
> §2 content — the fold-blind posture and the fresh-guard scoping — carries
> over; the anchor-stability law and the reverse-order derivation are dissolved
> by the codec decision (§2). Three decisions sit beyond the superseded
> sections (§2, §6): the landed arm certifies the moved heading's new
> owner; cross-doc is in v1 scope (this mode is the multi-doc
> consumer `batch.ts`'s `walk-failed` arm defers to); and the codec is the
> insert-before arm, decided by the spike and recorded in §2.

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

(The per-leg economics below is superseded by the one-batch economics of §6.)

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
content), is why this mode is pursued rather than deferred — the design itself
awaits re-derivation onto the batched route (§6) before any of it is
built.

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
  only the heading leg (`nextID = <the boundary>`). The
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
  they are. On the batched route both anchors of the decided codec are
  `nextID` positions — the destination section's boundary for every
  member leg, the first landed member for the heading leg — so no anchor
  is ever re-addressed after the state it names changes, and no
  stability classification is needed: the planned `stable` /
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
2. **A live probe, before any product code.** The codec-deciding readings
   are executed — [`move-section-spike.md`](move-section-spike.md) ran the
   raw-client matrix (previousID baseline; nextID heading-first and
   members-first; folded source under both; empty destination; skip-class
   rollback) and every case landed at the expected layout. Owed:
   - the **doc-end destination arm** — `nextID` is empty there and the op
     falls through to `previousID`/`parentID` semantics: characterize the
     landing and its predicate arm, or refuse it;
   - a batch carrying a legality-check op → confirm the rejection
     (`TxErrCodeReloadUI`, `validateStructureChanges`,
     `transaction.go:2648` — only insert/append/move paths register
     structure-check nodes) rolls the whole batch back while the HTTP
     response reads as success. Unreachable for delete-section; the
     spike exercised the skip class only, so this class is owed.
   - the **cross-box** skip arm (`IsSameCryptoBoundary` → `SkipTx`
     silent rollback behind a success ack) — the same rollback class as
     the spike's case E, unprobed.
   - the cross-doc **move-residue round trip**: force a batched cross-doc move
     to roll back, then confirm by-id resolvability of a moved id
     (unresolvable behind a success ack — the wrong-root row, §6), then the
     heal attempted from the **source** doc restoring resolution, and a write
     to the destination doc confirmed to heal nothing;
   - a **≥32-op move batch**: confirm the per-op execution path still
     applies (the ≥32 bulk path requires an all-delete batch) and the
     batch lands whole — pinning §6's cliff claim against a realistic
     30-member section;
   - the cross-doc **success landing**: a clean batched cross-doc move
     judged over both walks — landing position, the member prefix, and
     source absence. The rollback leg rehearses the residue; only this
     leg rehearses the judgment.
   The spike's readings are live; the legs above are still
   source-verified but not yet live-confirmed, and their transcript is
   the implementation plan.

## 4. Refusals the mode must add

Group-level, pre-mutation, zero kernel calls — conditions that per-leg
checks would otherwise only surface mid-sequence, after the tear:

- `toHeadingId` names the moved heading itself (identity), or the
  destination section is one the moved section contains.
- The group is **already at the destination** — derived as: the
  destination section's boundary lies inside the moved set (the boundary
  heading ∈ `sectionOf(sourceHeading).members ∪ {H}`; e.g. with `# A /
  a1 / ## B / b1`, moving B's section onto the end of A's section makes
  `B` — the moved heading — the destination's boundary). One refusal,
  never a partial receipt with an empty moved set; on the batched route
  the alternative is the kernel's own skip arms (`TxErrCodeSkipTx`),
  which roll the whole batch back behind a success ack (spike case E).
- There is **no following boundary** — the destination section is the
  last section of its doc, `nextID` is empty, and the op falls through
  to `previousID`/`parentID` semantics whose landing is uncharacterized
  (owed probe, §3). Refused pre-mutation, zero kernel calls, until that
  arm is characterized and pinned; the route-out is a destination
  section that has a following boundary, or the per-id path.

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

These are the duties the re-derivation must satisfy; they are not yet
re-derived.

- **The route: one batched `move` transaction.** Members in document
  order onto the destination section's boundary (`nextID`), then the
  heading anchored before the first landed member — the decided codec
  (§2, spike-confirmed) — as raw `move` ops in one `/api/transactions`
  call, judged from the per-touched-doc post-write walks
  (`transactThenWalk`).
  Move's batch always takes the kernel's per-op execution path (the ≥32 bulk
  path requires an all-delete batch), so the cliff is not this mode's
  interaction.
- **Cross-doc is in v1 scope.** The judgment is
  per-touched-doc post-write walks, so this mode extends `batch.ts`'s
  `walk-failed` arm to carry the partial walks its docstring defers to
  "a multi-doc consumer" — this mode is that consumer. The extension
  lands in the primitives under the same posture as the anchor
  classifier (§2): unpublished, `file:`-linked, shape perfected side by
  side before either repo releases. The destination side composes the
  caller-provenance gate delete-section models (`foreign` /
  `walk-truncated`): the anchor derives from a caller-held destination
  walk, and the kernel mutates by raw block id with no doc scoping of
  its own. Single-doc v1 would make the automated route narrower than the per-id
  path it replaces, and a later cross-doc release would pay a second
  wording/probe/pin ship.
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
  its heading) as landed. The landed predicate: the moved heading sits immediately before the
  first enumerated member — equivalently, immediately after the
  destination section's last pre-move block, as the caller-held walk
  holds it; `sectionOf(destWalk, H)
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
  `writeSchema.ts`'s mode/param table, `writePrepare.ts`'s ordered
  dispatch and its exhaustive tail, the pinned mode/param list in
  `__tests__/unit/contract.test.ts`, and the `kb_write` tool description
  (`write.ts`); the tool-side fact-list entry recording the fresh-guard
  rationale for moves (§2) rides the same pass. A re-derivation that
  plans only the kernel side leaves these to be discovered later.
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
