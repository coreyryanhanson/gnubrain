# Move-section — design

Status: **Approved**

Origin: friction §2/§3 in [`../kb-write-friction.md`](../kb-write-friction.md).
The **corruption half of heading-move is already closed** — `moveBlockVerified`
refuses section-bearing heading targets fold-blind and pre-mutation
(`heading-with-section`, plus the matching anchor arm
`heading-anchor-with-section`), because the kernel's move scope for such
headings is fold-dependent hidden state (`resolveHeadingMoveChildren` returns
section children only when `treenode.IsSelfFolded(srcNode)`,
`kernel/model/transaction.go`). So this mode would be a **capability and
expressiveness fix, not a safety fix**.

## 1. Why approved

The prerequisites that gated this design are complete — delete-section landed
the generalized partial-apply plumbing and the enumerated loop shape this
sequence composes (§3.1) — and the friction that motivated the mode is an
observed reliability problem for gnubrain: the move path refuses
section-bearing headings (the fold-blind refusals above), so sections can be
deleted and replaced but not moved.

## 2. What the mode must solve

- **The anchor problem.** Move anchors are previousID-based ("lands after X"),
  and `sectionStartAnchor` is append-only by contract (`placement.ts`). With
  end-of-section anchors only, a members-first sequence lands the heading
  **after** its own body — silently inverted section semantics.
- **The sequence.** Members-first in reverse document order onto a
  start-of-section *move* anchor, then the now-empty-section heading onto the
  same anchor; or another ordering with a proof it preserves document order.
  Needs a new anchor arm and a landed-**order** judgment over the post-move
  walk — a materially harder sequence than delete's absence judgment.
- **The fold-safety proof.** The corner where the destination section-start
  *is* the destination heading is exactly the `heading-anchor-with-section`
  hazard; the new anchor arm must be proven fold-safe against
  `resolveHeadingMoveChildren`'s behavior, and pinned live.
- **Partial-state semantics.** Mid-sequence failure leaves members moved and
  the heading (and any un-moved members) behind — the receipt must say exactly
  what moved, in what order, and where the remainder sits. Reuse the
  generalized partial plumbing (the partial-apply state and marker in
  gnubrain's `envelope.ts` and `writeVerdicts.ts`), not a second copy.
- **Fresh-content scope.** The moved set (heading + closure) is judged
  pre-move by the guard the destroy-shaped primitives now carry internally
  (see the primitives' write entry: `ServedBaseline` verdicts over the
  caller-held pre-dest walk) — the mode is born guarded, not retrofitted.
  Outline seeds ride heading rows.

## 3. Preconditions before implementation

Before writing the implementation plan:

1. **Delete-section has landed.** It has: the generalized partial-state
   plumbing (see "Partial-state semantics" above) and the enumerated
   loop shape (`sweepCore`) exist and are directly composable. The delete
   core carries a per-id delete and an absence judgment where this mode
   needs a move and a move-order judgment; parameterizing the loop or
   duplicating it is decided at this plan's implementation time (§2).
2. **The anchor arm is designed and live-pinned** — what a start-of-section
   *move* anchor is, which kernel call expresses it, and a live pin that it is
   fold-safe.

## 4. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4; the
  demotion idiom is documented in the `kb_write` tool description).
- No kernel-side section API.
- No new refusals on the existing move path beyond the fold-blind refusals
  already in place.
