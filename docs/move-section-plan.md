# Move-section — design (deferred)

Status: **deferred, not decided.** This doc records why `move-section` sits
behind `delete-section` (see [`delete-section-plan.md`](./delete-section-plan.md)),
the design pressures to resolve, and what must be settled before it earns an
implementation plan. Do not start here.

Origin: friction §2/§3 in [`../kb-write-friction.md`](../kb-write-friction.md).
The **corruption half of heading-move is already closed** — `moveBlockVerified`
refuses section-bearing heading targets fold-blind and pre-mutation
(`heading-with-section`, plus the matching anchor arm
`heading-anchor-with-section`), because the kernel's move scope for such
headings is fold-dependent hidden state (`resolveHeadingMoveChildren` returns
section children only when `treenode.IsSelfFolded(srcNode)`,
`kernel/model/transaction.go`). So this mode would be a **capability and
expressiveness fix, not a safety fix**.

## 1. Why deferred

Highest-risk item on the friction list with the lowest safety return. The
current state is honest, if unhelpful: the refusals refuse, and the refusal
wording advises moving the body blocks individually against a derived
section-end anchor. That advice pushes an agent-side mutation *sequence* onto
the model, against the "the tool layer never sequences kernel mutations"
doctrine — so the value of the mode is real. It just costs more than a rider
on the delete-section PR.

The friction doc's own evidence for expressiveness limits stands: re-nesting a
section is a heading-level `edit` (demote the `#` level; the body follows,
nothing moves — friction §4), and section-level anchoring cannot express
re-nesting via move at all (friction §3). A section **relocation** to another
position is the only thing this mode would add.

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
  generalized partial plumbing delete-section builds (§6 of that plan), not a
  second copy.
- **Fresh-content scope.** The moved set is heading + closure; same honest
  strength discussion as delete-section (outline seeds ride heading rows; the
  pre-move walk is caller-held).

## 3. Preconditions to revisit

Before writing the implementation plan:

1. **Delete-section has landed** — its shared enumerated-mutation core and the
   generalized partial-state plumbing are the seams this mode composes.
2. **The anchor arm is designed and live-pinned** — what a start-of-section
   *move* anchor is, which kernel call expresses it, and a live pin that it is
   fold-safe.
3. **Demand is observed** — the refusal wording's advised workaround
   (individual member moves) has actually been reached for in practice, or the
   friction re-survey after delete-section ships still flags move
   expressiveness. If agents settle happily on member-wise moves + `append`,
   the mode may not be worth its verification surface at all.

## 4. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4), documented in
  delete-section's PR.
- No kernel-side section API.
- No new refusals on the existing move path beyond what shipped with the
  fold-blind fix.
