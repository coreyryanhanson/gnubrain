# Move-section spike — the `nextID` (insert-before) arm, live-confirmed

Status: **executed 2026-10-19** against the live SiYuan 3.8.7 kernel
(`SIYUAN_BASE_URL=http://192.168.100.1:6806`). Script: `/tmp/spike-move-nextid.mjs`
(raw client, zero deps, disposable notebook created and torn down — no strays).
Raw transcript: `/tmp/spike-move-nextid.log`.

This spike settles review finding **A1** on `docs/move-section-plan.md`: §2's
"There is no new anchor arm" was asserted without testing the batched route's
`nextID` arm. Both reviewers independently identified the `moveBefore` branch of
`doMove` (`kernel/model/transaction.go:695-700`; the fold redirect is guarded by
`!moveBefore`, `:773-780`) as an unexamined, fold-blind addressing mode. The
experiment decides whether the plan's entire `previousID`/LIFO apparatus is a
kernel law or an artifact of an unmade choice.

## Design

One notebook, seven docs (five cases). Source fixture:

```text
# S / s0 / ## H / m1 / m2 / ### H2 / sub1 / m3 / ## T / t1
```

`H`'s section members in document order: `m1, m2, H2, sub1, m3` (`H2` is a
nested subsection heading carrying `sub1`; `m3` follows it). Destination:

```text
# D / d1 / ## B / b1 / ## Z / z1
```

(`B`'s section is `b1`; `Z` is the next boundary heading.) All moves are
cross-doc, same notebook, issued as raw `move` ops in one `/api/transactions`
batch, then verified by live-tree walks (`getChildBlocks` from the doc root —
never the SQL index). Correct landing for "move H's section to the end of B's
section" is `… b1, H, m1, m2, H2, sub1, m3, Z …` and source reduced to
`S, s0, T, t1`.

| Case | Codec | Order | Source fold | Expected |
|---|---|---|---|---|
| A | all ops `nextID=Z` | heading first, then members in doc order | unfolded | correct |
| A2 | members `nextID=Z`, heading `nextID=m1` (the already-landed member) | members first, heading **last** | unfolded | correct |
| B | as A | heading first | `fold=1` on `H` | drag hazard observed? |
| B2 | as A2 | members first, heading last | `fold=1` on `H` | hazard dissolved? |
| C | `previousID=b1` (non-heading leaf anchor) | members reverse doc order, heading last | unfolded | §2's algebra |
| D | as A2 | members first, heading last | unfolded | empty destination section (`b1` absent) |
| E | legal op + skip-class op (`move m3 nextID=m3` → `TxErrCodeSkipTx`) | — | — | whole-batch rollback behind HTTP success |

`fold` was set per-block via `/api/attr/setBlockAttrs` (the frontend-equivalent
IAL). Each case ran in fresh docs; the notebook was removed at the end.

## Results

Every case landed **exactly at the expected layout** — flat destination
`d1, B, b1, H, m1, m2, H2, sub1, m3, Z, z1`, source reduced to `S, s0, T, t1`
(D without `b1`; E unchanged in both docs). Details worth recording:

- **C (previousID baseline).** The plan's §2 arithmetic is live-confirmed:
  reverse-order members onto a non-heading leaf anchor, heading last →
  `[b1, H, m1 … m3]`.
- **A (nextID, heading first).** The `moveBefore` branch is fold-blind on the
  destination side: `nextID=Z` — a **heading** anchor — never redirects, and
  document-order member issuing works. No reverse order needed.
- **A2 (nextID, heading last).** The reviewer's claimed counter-argument —
  "under `nextID` the heading leg must land first" — is **false**: the heading
  can anchor on `nextID = <first landed member>`, so `nextID` admits a
  heading-leg-last codec too. (The reviewer's counter-argument only constrained
  the *heading-first* variant; it is not forced by the arm.)
- **B (nextID, heading first, folded source).** The drag hazard is real —
  `resolveHeadingMoveChildren` returns the folded heading's whole section on
  the first op, dragging `H` + all five members before `Z` — but it **self-
  cancels** for this op set: the drag preserves document order, and re-moving
  each member in the same order to the end of the pre-`Z` run reproduces the
  correct order. The final layout is correct. The hazard is not benign in
  general (see Implications).
- **B2 (nextID, heading last, folded source).** Members leave the folded
  section one by one (plain moves — the drag only applies when the *moved node
  itself* is a folded heading); the heading moves last over an already-emptied
  section, so its drag has nothing to drag. **Structurally hazard-free** — the
  same property the `previousID` codec claims for its heading leg, now
  available on the insert-before side.
- **D (empty destination).** `nextID` reaches the empty-destination section
  natively: the batch landed `H`'s section directly after the empty `B`
  heading. The shape §4 currently refuses ("append a body block into the
  destination section first") needs no refusal and no workaround.
- **E (rollback).** The batch's second op was `move m3 nextID=m3`
  (`id == targetSiblingID` → `TxErrCodeSkipTx`). The kernel rolled back the
  **whole batch** — the legal first op included — while the HTTP response read
  `{"code":0,"msg":"","data":[…]}` with the ops echoed. Silent whole-batch
  rollback behind a success ack is live-confirmed for move ops; the §6
  cause-free all-or-nothing arm's premise holds, and the mode's most likely
  failure mode is exactly this shape (oracle's `nothing-moved` verdict arm is
  the right precedent).

## Implications for the plan (A1 resolution)

1. **The anchor-stability law is a consequence of choosing `previousID`, not a
   kernel law.** On the insert-before side there is no fold redirect at all:
   any anchor — including a heading — is a literal position. The §2 law, the
   §4 heading-anchor refusal, its "append a body block first" route-out, the
   `single-use` class, and the empty-destination refusal are all downstream of
   an unmade choice.
2. **A nextID codec dominates on every axis the spike touched:** document
   order (no reverse-order derivation to pin), no single-use anchor rule, no
   heading-anchor refusal, empty destinations reachable natively, and — with
   the heading leg last anchored on the first landed member (A2/B2) — the same
   folded-source structural guarantee the previousID codec was prized for.
3. **The previousID codec remains viable** (C confirmed it), and its heading-
   leg-last property is preserved by the A2/B2 variant of the nextID codec, so
   the original codec no longer has a unique advantage on the folded-source
   axis either. Keeping it would retain one thing only: familiarity with the
   per-id move path's anchor algebra.
4. **What the spike does not settle** (owed before the §2 paragraph is
   written):
   - **Doc-end destination** — `nextID` is empty there, and the empty-`nextID`
     op falls through to `previousID`/`parentID` semantics (the append/prepend
     arm, review finding B1). Untested; the landed predicate must cover it or
     refuse it.
   - **Partial coverage under drag** — B's self-cancellation relied on every
     dragged member being re-moved. A member appended to the source section
     after enumeration (review finding B3, currency) would be dragged by the
     heading leg in a heading-first codec and never re-moved — landing it
     in the destination without ever being judged. The members-first
     codec narrows the exposure to the heading leg alone: the enumerated
     members are re-moved by their own ops, but a post-enumeration append
     still under a folded `H` is dragged on that leg and lands unjudged —
     the plan's currency bullet carries the detection duty.
   - **Cross-crypto-boundary batch** (`IsSameCryptoBoundary` → `SkipTx`) —
     same silent-rollback class as E; not probed.
   - **Legality-check rejections** (`TxErrCodeReloadUI`) — E probed the skip
     class; the legality class is still owed (§3.2's bullet 3).
5. **Recommended §2 decision, pending the owed probes:** the batched mode
   issues **members in document order, each `nextID = <destination section
   boundary>`** (or the doc-end arm once characterized), then **the heading
   `nextID = <first member id>`**. This keeps the heading leg last (fold-safe
   by construction, B2), eliminates the reverse-order derivation and the
   entire anchor-stability refusal set, and reaches empty destination sections.
   The §4 heading-anchor refusal is replaced by a boundary-existence check
   (the destination section must have a following boundary heading, or the
   doc-end arm applies).

## Caveats

- Single small fixture, one notebook, same box; results are 3.8.7-pinned and
  version-coupled like everything else in the primitives.
- The fold was set by API (`setBlockAttrs`), the way the frontend does it; the
  kernel's fold state is otherwise invisible to clients, which is the point of
  the fold-blind posture.
- Walk-rendering note: `getChildBlocks` on a heading returns the heading's
  **whole section** (`HeadingChildren` semantics), so a naive recursive walk
  double-reports nested sections. The primitives' `walkBlockTree` already
  encodes the correct treatment; the spike's flat top-level read is what the
  layouts above are taken from.
- No throttle/lock effects encountered; the notebook teardown verified clean.
