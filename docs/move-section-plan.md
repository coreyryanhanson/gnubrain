# Move-section — design

Status: **Approved**

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

- **The anchor-stability law is stated once, in the primitives.**
  `deriveMoveAnchor` classifies its result through one predicate in
  `placement.ts` — `stable` (non-heading leaf) / `single-use`
  (empty-section heading: the per-id path's existing semantics, judged
  before its next leg) / `unstable` (section-bearing heading, refused
  everywhere) — and every anchor consumer switches on the class: the
  per-id move keeps accepting `single-use`, this group mode refuses
  anything but `stable`, and a future sequence inherits the check by
  construction instead of by review. The existing
  `heading-anchor-with-section` refusal and this mode's refusal become two
  consumers of one predicate rather than two handwritten guards.

- **The moved set.** `sectionOf(sourceHeading).members` in **reverse
  document order**, then the heading. Reverse order is load-bearing, not an
  implementation detail: a member may itself be a subsection heading, and
  reverse order empties that member's own section before it is issued, so
  `heading-with-section` can never fire mid-sequence. Container descendants
  (closure) are never issued — they ride their container. State and pin
  this; an implementer who "simplifies" the order orphans subsection bodies.

- **The judged sequence: mutate → judge → mutate → judge.** The heading
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

- **Partial-state semantics.** Mid-sequence failure leaves members moved and
  the heading (and any un-moved members) behind — the receipt must say
  exactly what moved, in what order, and where the remainder sits, rendered
  from the member phase's judgment walk (never from an ack prefix). The
  honest sentence is that **the section is split between two places**; the
  receipt must never read as loss and must not reuse delete's vocabulary
  ("gone"). Reuse the generalized partial plumbing's *mechanism* (the
  partial-apply state and marker in `envelope.ts` / `writeVerdicts.ts`),
  not a second copy.

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

- **Outline side effect at the destination.** Landing a shallower moved
  heading at the end of the destination section can claim following deeper
  sections into the moved section (the nearest preceding shallower heading
  changes). This is the honest consequence of "end of H's section" landing;
  it is documented behavior, stated in the tool description, not something
  to bound.

- **Cross-doc scope.** Each leg is a same-kernel `moveBlock`; a cross-doc
  destination is in scope and rides the existing per-leg membership-only
  semantics. Nothing new is invented here — state it, don't discover it.

## 3. Preconditions before implementation

Before writing the implementation plan:

1. **Delete-section has landed.** It has: the generalized partial-state
   plumbing (see "Partial-state semantics" above) and the enumerated
   loop shape (`sweepCore`) exist and are directly composable. The delete
   core carries a per-id delete and an absence judgment where this mode
   needs a move and a move-order judgment; parameterizing the loop or
   duplicating it is decided at this plan's implementation time.
2. **A live probe, before any product code.** A raw-client probe (no
   product code) on a fixture with a nested subsection heading and a
   container member, over both destination shapes:
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
   Both readings are source-verified but not yet live-confirmed; the
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

- The destination anchor sits **inside the moved section's own subtree** —
  the `own-subtree` judgment hoisted from per-leg to group scope.
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
- No kernel-side section API.
- No new refusals on the existing move path beyond the fold-blind refusals
  already in place.
