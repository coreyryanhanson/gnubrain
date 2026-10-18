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
  yields `[anchor, mN … m1]`; the emptied heading then lands directly after
  the anchor and before `mN` → `[anchor, H, m1 … mN]`: correct section
semantics with the anchor the move path already has. There is **no new
anchor arm**. A start-of-section landing is out of scope (§5): inserting a
  same-or-shallower heading at a section's *start* re-bounds the destination
  heading's section — the destination's body would become the moved
  section's body — and the prepend arm it would need is live-pinned
  unreachable.

- **The moved set.** `sectionOf(sourceHeading).members` in **reverse
  document order**, then the heading. Reverse order is load-bearing, not an
  implementation detail: a member may itself be a subsection heading, and
  reverse order empties that member's own section before it is issued, so
  `heading-with-section` can never fire mid-sequence. Container descendants
  (closure) are never issued — they ride their container. State and pin
  this; an implementer who "simplifies" the order orphans subsection bodies.

- **The landed-order judgment.** One post-sequence walk per touched doc,
  replacing per-leg verification: (a) every enumerated member id present in
  the destination doc, in expected order, consecutive from the anchor;
  (b) the moved heading's destination section is exactly the enumerated
  member sequence; (c) the source is free of the enumerated members. The
  per-id legs do **not** each run the full `moveBlockVerified` judgment —
  one group judgment is cheaper than N+1 per-leg walks, and it is the only
  judgment that catches a fold/skip-class redirect mid-sequence. This
  judgment is the mode's safety net.

- **Partial-state semantics.** Mid-sequence failure leaves members moved and
  the heading (and any un-moved members) behind — the receipt must say
  exactly what moved, in what order, and where the remainder sits. The
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
   product code) on a fixture with a nested subsection heading, a container
   member, and an empty-section heading: issue the members in reverse order
   onto the derived section-end anchor, then the emptied heading, and read
   `sectionOf(postWalk, movedHeadingId).members`. This settles the
   `InsertAfter`/LIFO ordering reading of `transaction.go` against the real
   kernel — the one claim in this design that is source-verified but not yet
   live-confirmed — and its transcript is the implementation plan.

(A previously drafted precondition — designing and live-pinning a
start-of-section *move* anchor arm — is **dropped**: with end-of-section
landing there is no new anchor arm and no fold-safety proof to make. A
non-heading anchor can never satisfy the kernel's heading-anchor redirect
branch (`ast.NodeHeading == targetNode.Type`, `transaction.go`), so there
is nothing to pin.)

## 4. Refusals the mode must add

Group-level, pre-mutation, zero kernel calls — conditions that per-leg
checks would otherwise only surface mid-sequence, after the tear:

- The destination anchor sits **inside the moved section's own subtree** —
  the `own-subtree` judgment hoisted from per-leg to group scope.
- `toHeadingId` names the moved heading itself (identity), or the
  destination section is one the moved section contains.
- The group is **already at the destination** — one refusal, never a
  partial receipt with an empty moved set.

## 5. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4; the
  demotion idiom is documented in the `kb_write` tool description).
- No start-of-section landing and no heading-level rewriting —
  end-of-section only (§2).
- No kernel-side section API.
- No new refusals on the existing move path beyond the fold-blind refusals
  already in place.
