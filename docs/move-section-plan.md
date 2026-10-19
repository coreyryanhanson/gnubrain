# Move-section — design

Status: **Held — re-derivation onto the batched route pending**

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
> same-doc/root-level ceiling, and silent `PushMsg` rejections). The
> destination-anchor algebra below carries over unchanged; the two-phase judged
> sequence and the pending-set receipt do **not** survive the re-derivation (§6).
> The kernel facts the re-derivation rides live in the primitives' AGENTS.md fact
> list (the "batched delete route" entries: batch rollback and its `blocktrees`
> residue, ack-time commit-wait, the ≥32-op cliff, queue ordering). The surviving
> §2 content — the anchor-stability law (with the leaf→heading-ness discriminator
> fix), the reverse-order member derivation, the fold-blind posture, the
> fresh-guard scoping — carries over. Post-review decisions are recorded where
> the surviving shape lives (§2, §6): the landed arm certifies the moved
> heading's new owner; cross-doc is in v1 scope (this mode is the multi-doc
> consumer `batch.ts`'s `walk-failed` arm defers to); and the anchor-stability
> classifier lands as a pure predicate in the primitives first — unpublished,
> `file:`-linked — never as a dispatch.

Origin: friction §2/§3 in [`../kb-write-friction.md`](../kb-write-friction.md).
The **corruption half of heading-move is already closed** — `moveBlockVerified`
refuses section-bearing heading targets fold-blind and pre-mutation
(`heading-with-section`, plus the matching anchor arm
`heading-anchor-with-section`), because the kernel's move scope for such
headings is fold-dependent hidden state (`resolveHeadingMoveChildren` returns
section children only when `treenode.IsSelfFolded(srcNode)`,
`kernel/model/transaction.go`). So this mode is an **efficiency and
expressiveness fix, not a safety fix**.

## 1. Why approved

*(§1 predates the batched-route foundation; the framing below — including its
reference to delete-section's then-planned sweep shape in §3.1 — is the per-leg
economics it was written against. The re-derivation replaces it with the
one-batch economics of §6.)*

The prerequisites that gated this design are complete — delete-section landed
the generalized partial-apply plumbing and the enumerated loop shape this
sequence composes (§3.1). And the problem this mode solves is **packaging,
not capability**: the sequence it automates is already expressible today, and
the refusal wording itself advises it (move the members individually against
a derived section-end anchor, then the emptied heading). What is missing is
doing it in **one call** — order enforced and verified by construction, one
group receipt, partial-state reporting — instead of ~2N+1 `kb_write` round
trips. That efficiency for agent-driven workflows, plus closing the
silent-corruption trap in the manual sequence (wrong ordering strands
content), is why this is approved rather than deferred.

## 2. What the mode must solve

- **Landing semantics: end of the destination section.** `moveBlock`'s
  `previousID` inserts the moved node *immediately after* the anchor
  (`kernel/model/transaction.go` `doMove` → `InsertAfter`), which is LIFO.
  Issuing the members in reverse document order onto the existing
  section-end anchor (`deriveMoveAnchor`, a leaf position by contract)
  yields `[anchor, m1 … mN]`; the emptied heading then lands directly after
  the anchor and before `m1` → `[anchor, H, m1 … mN]`: correct section
  semantics with the anchor the move path already has. There is **no new
  anchor arm** — but the anchor the move path already has must be a
  **stable** one (next bullet). A start-of-section landing is out of scope
  (§5): inserting a same-or-shallower heading at a section's *start*
  re-bounds the destination
  heading's section — the destination's body would become the moved
  section's body — and the prepend arm it would need is live-pinned
  unreachable.

- **Anchor stability: the derived anchor must be a non-heading block.** A
  heading anchor does not denote a position — "after this heading" means
  "after the heading" unfolded, "after the heading's whole section"
  self-folded (`transaction.go`'s redirect branch), and fold is hidden
  state this package never reads. The kernel's own contract (`MoveAnchor`'s
  precondition) is that a heading anchor is fold-stable **iff its section
  is empty** — and such an anchor is **single-use**: the group's first
  landing makes it section-bearing, so every later leg addresses a
  silently flipped position (a collapsed destination section lands the
  group inverted — body above its heading, re-parented — behind
  unconditional HTTP success per leg). Reverse order is forced by the
  moved-node side and a fixed anchor is forced by the LIFO landing, so a
  multi-leg sequence needs an anchor that survives N+1 uses: the
  destination section must be non-empty and the derived anchor a
  non-heading leaf. This is held **by construction**, not judged after the
  fact — no post-move judgment can repair a flipped address.

- **The anchor-stability law is classified once, in the primitives — as
  a pure predicate, not a dispatch.** `placement.ts` grows one exported
  predicate classifying an anchor `stable` (non-heading leaf) /
  `single-use` (empty-section heading — `deriveMoveAnchor`'s only
  heading output) / `unstable` (section-bearing heading), with a
  placement-corpus test per class; it retires the prose-only
  `MoveAnchor` precondition whether or not this mode ever ships.
  Refusal sites stay deliberate policy sites that call the predicate:
  the per-id move keeps accepting `single-use` (its existing semantics,
  judged before its next leg), and this group mode refuses any heading
  anchor (its derived anchor must be a non-heading leaf — the `stable`
  class). A *derived* anchor can never be `unstable` — that class
  exists only for caller-supplied `previousID` (the
  `heading-anchor-with-section` provenance) — so the earlier framing
  here, "every anchor consumer switches on the class", is dropped:
  unify the classification, not the policy. The predicate lands in the
  primitives first, unpublished (this repo's `file:` link stays) so the
  shape can be perfected side by side before either repo releases.

- **The moved set.** `sectionOf(sourceHeading).members` in **reverse
  document order**, then the heading. Reverse order is load-bearing, not an
  implementation detail: a member may itself be a subsection heading, and
  reverse order empties that member's own section before it is issued, so
  `heading-with-section` can never fire mid-sequence. Container descendants
  (closure) are never issued — they ride their container. State and pin
  this; an implementer who "simplifies" the order orphans subsection bodies.

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
  Record the rationale in the tool-side fact list at implementation time so
  the absence reads as a decision, not an omission.

- **Landing is level-blind; the judgment certifies the owner, not just
  the order.** A moved heading *shallower than or equal to* the
  destination heading lands as a following sibling and can claim
  following deeper sections into the moved section (the nearest
  preceding shallower heading changes) — the honest consequence of "end
  of H's section" landing, documented behavior stated in the tool
  description. The mirror case is a moved heading *deeper than* the
  destination heading: it can never be contained by the destination's
  section — it lands after that section and reattaches to the
  destination heading's own parent — yet the prefix judgment alone
  passes in both cases. Decided post-review: the landed arm certifies
  the moved heading's **new owner** (the nearest preceding shallower
  heading in the destination walk) alongside the order, so both
  divergences surface in the envelope and the receipt says where the
  section actually attached. This is reporting, not a level rewrite —
  the mode still never rewrites levels (§5); the projection is a read
  off the walk the verdict already holds, not new verification
  machinery.

- **Cross-doc scope.** Each leg is a same-kernel `moveBlock`; a cross-doc
  destination is in scope and rides the existing per-leg membership-only
  semantics. Nothing new is invented here — state it, don't discover it.

## 3. Preconditions before implementation

Before writing the implementation plan:

1. **Delete-section has landed — on the batched route.** The foundation is
   layer 1's `transact` plus the primitives' `batch.ts` (`transactThenWalk`);
   delete-section rides the batched route, so the "parameterize the loop or
   duplicate it" question is moot — the batched move composes the same
   foundation with its own judgment sequence (the no-shared-core rule: each
   batched mode owns its judgment; the walk helper is the only shared code).
2. **A live probe, before any product code.** A raw-client probe (no
   product code) on a fixture with a nested subsection heading and a
   container member, over both destination shapes. *(The first two shapes
   below are the per-leg baseline; the batched re-derivation restates them
   against in-tx array order — op 2 addresses state op 1 created — per §6.)*
   - a **populated** destination section — the supported path: issue the
     members in reverse order onto the derived non-heading anchor, then
     the emptied heading, and read
     `sectionOf(postWalk, movedHeadingId).members`. This settles the
     `InsertAfter`/LIFO ordering reading of `transaction.go` against the
     real kernel;
   - an **empty** destination section with `fold=1` set on the destination
     heading (per-block IAL, settable): issue the member legs onto the
     derived *heading* anchor and read the landing positions — legs after
     the first should redirect to the anchor's last child and invert the
     group, recording the hazard the stable-anchor refusal exists for.
   - a batch carrying a legality-check op → confirm the rejection
     (`TxErrCodeReloadUI`, `validateStructureChanges`,
     `transaction.go:2648` — only insert/append/move paths register
     structure-check nodes) rolls the whole batch back while the HTTP
     response reads as success. Unreachable for delete-section; owed here
     once this mode's batched `move` ops issue (the batched-route migration
     deferred this probe to this suite).
   - the cross-doc **move-residue round trip**: force a batched cross-doc move
     to roll back, then confirm by-id resolvability of a moved id
     (unresolvable behind a success ack — the wrong-root row, §6), then the
     heal attempted from the **source** doc restoring resolution, and a write
     to the destination doc confirmed to heal nothing.
   All four readings are source-verified but not yet live-confirmed; the
   transcript is the implementation plan.

(A non-heading anchor never satisfies the kernel's heading-anchor redirect
branch (`ast.NodeHeading == targetNode.Type`, `transaction.go`);
`deriveMoveAnchor` does, however, return a heading whenever the destination
section is empty, and that anchor is redirectable once the sequence's own
first leg makes it section-bearing — hence the stable-anchor requirement
(§2) and the probe's folded-empty-destination case.)

## 4. Refusals the mode must add

Group-level, pre-mutation, zero kernel calls — conditions that per-leg
checks would otherwise only surface mid-sequence, after the tear:

- `toHeadingId` names the moved heading itself (identity), or the
  destination section is one the moved section contains.
- The group is **already at the destination** — one refusal, never a
  partial receipt with an empty moved set.
- The destination section is **empty** — the derived anchor is the
  destination heading itself (`single-use` class), which the group's first
  landing makes section-bearing and fold-unstable. Refused pre-mutation,
  zero kernel calls, without reading `fold` — the same posture as the
  existing fold-blind refusals — and worded with the route out: append a
  body block into the destination section first, or move the members
  per-id (where `heading-anchor-with-section` fires loudly).

## 5. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4; the
  demotion idiom is documented in the `kb_write` tool description).
- No start-of-section landing and no heading-level rewriting —
  end-of-section only (§2).
- No kernel-side section API. *(False for the pinned 3.8.7 — `moveOutlineHeading`
  exists and is rejected on the record; see the review note above.)*
- No new refusals on the existing move path beyond the fold-blind refusals
  already in place.

## 6. Re-derivation duties on the batched route

Recorded here when the `/api/transactions` foundation landed (the migration
doc that owned them was removed after its landed content joined the AGENTS.md
fact lists); these are the duties the re-derivation must satisfy, not yet
re-derived.

- **The route: one batched `move` transaction.** Members in reverse document
  order, then the heading, as raw `move` ops in one `/api/transactions` call,
  judged from the per-touched-doc post-write walks (`transactThenWalk`).
  Move's batch always takes the kernel's per-op execution path (the ≥32 bulk
  path requires an all-delete batch), so the cliff is not this mode's
  interaction.
- **Cross-doc is in v1 scope — decided post-review.** The judgment is
  per-touched-doc post-write walks, so this mode extends `batch.ts`'s
  `walk-failed` arm to carry the partial walks its docstring defers to
  "a multi-doc consumer" — this mode is that consumer. The extension
  lands in the primitives under the same posture as the anchor
  classifier (§2): unpublished, `file:`-linked, shape perfected side by
  side before either repo releases. The destination side composes the
  caller-provenance gate delete-section models (`foreign` /
  `walk-truncated`): the anchor derives from a caller-held destination
  walk, and the kernel mutates by raw block id with no doc scoping of
  its own. Single-doc v1 was declined: refusing cross-doc would make
  the automated route narrower than the per-id path it replaces, and a
  later cross-doc release would pay a second wording/probe/pin ship.
- **The cause-free all-or-nothing arm covers move's batch.** Every skip arm
  reachable from move ops lives in the move paths, and skip-class rejections
  plus `TxErrCodeReloadUI` become silent rollbacks under the batch — the
  least informative envelope landing on the mode with the richest failure
  semantics. That is the accepted trade, decided on live evidence. If the
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
  walk per touched doc, landed-order judgment read off the walk; `transact` is
  one call, so the only throw is post-issue pre-ack — no walk can certify
  state, and the transport-unverified frame carries the whole judged set as
  its unconfirmed payload. Decided post-review: the landed judgment
  certifies the moved heading's **new owner** beside the landed order
  (§2), so the deeper-than-destination case — a section that lands
  outside the destination's section — surfaces in the envelope instead
  of passing the prefix test silently; the ownership projection is
  reporting off the walk, never a level rewrite.
- **The reverse-order member derivation carries over, not dissolved.** The
  batched route issues raw ops, so the per-leg `heading-with-section` refusal
  that guards a forward-ordered derivation is not in the loop; keep reverse
  order and pin it with its own probe.
- **Move's rollback residue and heal are characterized, not assumed from the
  delete case.** Every executed move writes both trees' index rows in-tx
  (`finishMove` → `writeTree` on source and target), so a rolled-back move
  batch leaves *wrong-root* rows — the post-move layout behind the pre-move
  tree. There is no clean case; wrong-root rows resolve to not-found (still
  never a wrong block). A cross-doc rollback makes the moved ids unresolvable
  behind success acks, and the heal is a committed write to the **source**
  doc — the tree that actually contains the node — never the destination (a
  destination write never walks the moved node's row). Move therefore keeps
  the conservative arm: **do not re-issue; heal first, then retry** — a
  re-issued move batch trips its own skip arms and rolls back again, looping
  until an out-of-band committed write to the source doc restores
  resolvability. The probe legs are in §3.2.
