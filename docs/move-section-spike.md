# Move-section spike — the `nextID` (insert-before) arm, live-confirmed

Status: **executed 2026-10-19** against the live SiYuan 3.8.7 kernel
(`SIYUAN_BASE_URL=http://192.168.100.1:6806`). Scripts: `/tmp/spike-move-nextid.mjs`
(codec matrix, cases A–E), `/tmp/spike-move-owed.mjs` (the owed legs, cases
F–J), and `/tmp/spike-move-docend.mjs` (case K, the doc-end chain order,
review follow-up) — raw clients, zero deps, disposable notebooks created and
torn down (no strays). Raw transcripts: `/tmp/spike-move-nextid.log`,
`/tmp/spike-move-owed.log`, `/tmp/spike-move-docend.log`. The containment
legs (cases L, M below) ran as one-off vitest live files over the
primitives — real `sectionOf`/`walkBlockTree`, no replicas, removed after
the run; transcripts: `/tmp/containment-probe-77257.log`,
`/tmp/containment-probe2-77375.log`, `/tmp/crossdoc-probe-77409.log`,
`/tmp/crossdoc-probe-green-77617.log`.

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
     refuse it. *(Now executed — see "Owed legs" below, cases F1–F5.)*
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
     same silent-rollback class as E; not probed. *(Now executed — case H1.)*
   - **Legality-check rejections** (`TxErrCodeReloadUI`) — E probed the skip
     class; the legality class is still owed (§3.2's bullet 3). *(Now
     executed — case G.)*
5. **Recommended §2 decision, pending the owed probes:** the batched mode
   issues **members in document order, each `nextID = <destination section
   boundary>`** (or the doc-end arm once characterized), then **the heading
   `nextID = <first member id>`**. This keeps the heading leg last (fold-safe
   by construction, B2), eliminates the reverse-order derivation and the
   entire anchor-stability refusal set, and reaches empty destination sections.
   The §4 heading-anchor refusal is replaced by a boundary-existence check
   (the destination section must have a following boundary heading, or the
   doc-end arm applies).

## Owed legs — executed 2026-10-19 (second script)

Script: `/tmp/spike-move-owed.mjs`; transcript: `/tmp/spike-move-owed.log`.
Same fixture (`S / s0 / H / m1 / m2 / H2 / sub1 / m3 / T / t1`), same disposable-
notebook discipline. All 14 verdicts passed; the characterizations below are
the record. Walks read flat (root-level only) — `getChildBlocks` on a heading
returns its whole section, so recursive walks double-report (same caveat as
above).

### F — the doc-end destination arm (review finding B1)

The destination section is the doc's **last** section: no following boundary
heading exists, `nextID` has nothing to name, and the codec must fall to the
other arms. Three readings:

- **F1 — all anchors empty.** A bare `move` op (`nextID`/`previousID`/`parentID`
  all empty) falls through `doMove`'s sibling branch into `loadTree("")` →
  `TxErrCodeBlockNotFound` → **whole-batch rollback behind HTTP code 0**. The
  naive "nextID is empty, so just omit it" codec form is not merely wrong —
  it silently no-ops. The class is not HTTP-visible (consistent with §6's
  no-channel finding).
- **F2 — `parentID: <docId>`.** The parent arm **prepends**: `PrependChild` on
  the document node lands every op at the doc's **start**, in reversed order
  (`H, m3, sub1, H2, m2, m1` before `d2, E, e1`). Unusable for end-of-section
  semantics — this is the prepend arm the plan already declared out of scope
  (§5), now live-confirmed reachable only in this wrong-position form.
- **F3 — chained `previousID` in document order.** Each op anchors on the
  previously landed block (first op on the destination section's last leaf,
  `e1`), the heading chained last onto `m3`: the batch lands the whole
  section at the doc end with the members in document order
  (`e1, m1, m2, H2, sub1, m3, H`), source reduced clean — but the heading
  lands **after its members**, which is not the codec's landing semantics
  (§2: the heading belongs between the destination section's last
  pre-existing block and the first member; F3's layout detaches the moved
  body into the destination section and leaves `H` an empty trailing
  section). The verdict originally labeled this layout "correct"; review
  caught it and case K below supplies the corrected form. What F3 does
  establish: the previousID chain survives mechanically at a doc-end
  destination, including the nested-subsection drag (F5).
- **F4 — heading-anchored doc-end (empty last section, the doc's last block is
  the heading `E`), every member `previousID: E`:**
  - **unfolded** (`F4a`): no redirect — each member `InsertAfter(E)` → LIFO
    reversal, and because the heading leg was issued last, `H` lands
    *immediately after `E`* with the members reversed after it:
    `E, H, m3, sub1, H2, m2, m1`. Wrong order, silent, behind code 0.
  - **folded** (`F4b`): the redirect branch fires on every op —
    `HeadingChildren(E)` grows as each member lands, so the anchor
    effectively becomes "after the section's current last child" and the
    members accumulate in **correct** document order:
    `E, m1, m2, H2, sub1, m3, H`.
  The landing position is correct in both folds (doc end), but the **order**
  is fold-dependent: the doc-end heading anchor is exactly the fold-hidden
  hazard class the plan refuses, in a new costume. A doc-end codec form must
  either chain on non-heading leaves (case K's leaf-anchored form) or refuse
  the heading anchor.
- **F5 — chained `previousID` with the nested subsection heading `H2` folded.**
  The drag rides `H2`'s own op (H2 + its section move together after `m2`),
  and `sub1`'s chained op then redirects into H2's landed section and
  self-inserts harmlessly; the chain completes with the correct layout
  (`e1, m1, m2, H2, sub1, m3, H`; source clean). The drag and the redirect
  interact **benignly** under the chained codec for this shape — but the
  interaction is exactly the fold-dependent machinery the mode refuses to
  reason about; F5 characterizes it, it does not license it. (F5 rode F3's
  heading-last chain order; case K1h2 re-confirms the same benign
  drag/redirect interaction under the corrected order.)

### K — the doc-end chain order, corrected (review follow-up)

F3's chain issued the heading leg last anchored on the last member; case K
re-ran the doc-end arm with the codec's own landing semantics in force — the
heading must sit between the destination section's last pre-existing block and
the first member. Script: `/tmp/spike-move-docend.mjs`; transcript:
`/tmp/spike-move-docend.log`. Five legs, one fixture
(`S / s0 / H / m1 / m2 / H2 / sub1 / m3 / T / t1` → doc-end destination
`D2 / d2 / E / e1`), same disposable-notebook discipline. The corrected form
is the **members-first chain with the heading leg last, anchored
`previousID = <the leaf>`**:

- **K1 — unfolded, folded `H`, folded `H2` (three legs).** All three landed
  exactly `D2, d2, E, e1, H, m1, m2, H2, sub1, m3`, source reduced to
  `S, s0, T, t1`. The heading leg runs last over an already-emptied section
  (no drag — the same structural guarantee as the codec's heading leg, cases
  B2/D) and its anchor is the non-heading leaf (no redirect): fold-safe by
  construction, the doc-end analogue of the decided codec.
- **K2 — the heading leg issued first, same leaf anchor (both folds).**
  Landed `e1, m1, m2, H2, sub1, m3, H` in both folds: each `InsertAfter(e1)`
  pushes the earlier landing down — **LIFO at a shared anchor across ops** —
  so a leaf-anchored heading leg is displaced by every later member leg
  unless it issues last. F3's heading-chained-after-the-last-member order is
  the same corrupted layout reached from the other side.

**Implication for the plan (§4):** the doc-end arm is real and fold-safe —
members chain `previousID` in document order from the destination section's
last non-heading leaf, and the heading issues **last** anchored on that same
leaf (K1). The heading-anchored doc-end forms stay refused (F4a/F4b, the
fold-dependent order); F3's heading-last chain is the corrupted layout, not a
form. F1's precondition stands unchanged: an omitted/empty `nextID` is not a
doc-end address, it is a rollback.

### G — legality-check rollback (`TxErrCodeReloadUI`)

A batch of one legal move (`m1 nextID=Z`) plus one legality-op — a list item
moved with `parentID: <docId>`, making it a direct child of the document
(`CanContainBlock` violation → `ValidateBlockPlacement` → `TxErrCodeReloadUI`
at finalize, `transaction.go:2648`). **Live-confirmed: the whole batch rolled
back** (source intact, destination untouched) **behind HTTP code 0**. The
legality class is the same silent shape as the skip class (E); §6's
cause-free all-or-nothing arm covers both, and its premise now has live
evidence for each class.

### H — cross-box arms (`IsSameCryptoBoundary`)

- **H1 — encrypted → plain.** A batch of one legal same-box move plus one
  encrypted→plain move (`transaction.go:746-748` ��� `TxErrCodeSkipTx`) rolled
  back **whole**, behind code 0. The cross-box skip arm is live-confirmed and
  is the same silent-rollback class as E. (Encrypted notebook created via
  `/api/notebook/createEncryptedNotebook` with the workspace master password;
  workspace encryption is enabled in this deployment.)
- **H2 — plain → plain across two notebooks.** `IsSameCryptoBoundary` allows
  plain↔plain unconditionally (`crypto.go:2103-2108`), and the codec's
  block ids are kernel-global — the batch landed whole in document order in
  the other notebook's doc (`b1, H, m1 … m3` before `Z`), source clean.
  **Cross-KB moves work natively** on this route; the mode's KB-scoping
  decision (destination within a granted KB, cross-box refused pre-mutation)
  is policy, not kernel necessity — the kernel would silently accept
  plain↔plain cross-KB and silently roll back cross-boundary.

### I — cross-doc rollback residue round trip (§6's doctrine, end to end)

Batch: legal cross-doc move (`m1 nextID=Z`) + skip-class op → whole-batch
rollback behind code 0. Then, on the moved id `m1`:

- **Resolver split, live-confirmed.** `getBlockInfo` (blocktree-routed:
  `LoadTreeByBlockIDWithReindexInBox` → the stale row's dest tree → node nil)
  returns **code -1, "Content block not found"** — unresolvable behind the
  success ack, exactly the wrong-root reading. The raw SQL row (`blocks`:
  `root_id` = the *source* doc) still carries the **true pre-move layout** —
  the rolled-back tx never updated the SQL index — so SQL-routed readers keep
  the truth while blocktree-routed readers fail closed (not-found, **never a
  wrong block**). A healthy control id resolved through the same reader
  throughout, so the -1 is the residue, not route breakage.
- **A committed write to the DESTINATION doc healed nothing** (still -1
  after `updateBlock` on the destination doc) — the destination tree does not
  contain the node, so its write never re-upserts the moved id's row.
- **A committed write to the SOURCE doc restored resolvability**
  (`getBlockInfo` → code 0) — the doctrine's heal path, live-confirmed
  (`UpsertBlockTree`'s path/box mismatch detection re-upserts the stale row
  from the source tree).
- **Heal first, then retry works:** the clean codec batch re-issued after the
  heal landed whole in document order, both walks judged — which also
  discharges §3's cross-doc success-landing leg.

### J — ≥32-op move batch (per-op path, cost)

A 36-op cross-doc batch (35-member section + heading, members-first nextID
codec) took the **per-op execution path** as claimed (the ≥32 bulk path
requires an all-delete batch, `processLargeDelete`/`processLargeInsert`) and
**landed whole in document order** — `b1, H, j01 … j35` before `Z`, source
reduced clean. Wall time: **341 ms** for 36 cross-doc ops — each op does two
full-tree `UpsertBlockTree` walks inside the global tx lock (review finding
B4), and 36 ops cost a third of a second; a 200-member section would be
~2 s, tolerable but worth a latency assertion rather than silence in the
live pin.

### Net effect on the plan

Every §3 leg that was source-verified is now live-confirmed. The residue/heal
doctrine (§6's last bullet) held end to end without modification. The two
readings that *change* plan text: the doc-end arm (§4's refusal re-justified
as anchor-class; the supported chain form is case K's leaf-anchored,
heading-leg-last order — F3's heading-chained-last order is the corrupted
layout), and cross-KB (H2: the kernel
accepts plain↔plain cross-notebook moves natively, so the granted-KB
restriction and the cross-box pre-mutation refusal are policy decisions the
plan must state, not kernel facts to discover).

## Containment and container crossings — executed 2026-10-19 (third and fourth runs)

The nested-destination probe: the planned containment refusal tests the
moved set over sibling ids (`members ∪ {H}`); a destination heading nested
inside a **container member's subtree** is inside what the move transports
yet invisible to that set. Does the kernel save a miss, and where does the
codec land when the destination section is container-nested? Same-doc
fixture:

```text
# Probe / a1 / ## H / m1 / blockquote(## Q / q1 [/ ## R / r1]) / m2 / ## Z / z1
```

`sectionOf(H).members = [m1, quote, m2]`; `Q` is **not** in
`members ∪ {H}` but **is** in `sectionOf(H).closure` — the sibling-id
forms of both refusal families miss, the closure test catches (case L0,
no mutation).

| Case | Shape | Ops | Result |
|---|---|---|---|
| L1 | dest Q in quote, boundary null; naive doc-end **leaf chain** | m1, quote, m2, H each `previousID=q1` (q1 inside the quote) | whole-batch rollback behind code 0, layout byte-identical |
| L2 | same shape; naive **append-into-container** | all ops `parentID=<quote>` (incl. quote→quote) | whole rollback behind code 0 |
| L3 | dest Q in quote with boundary R **inside the same quote**; nextID codec | members `nextID=R`, heading `nextID=m1` | whole rollback behind code 0 |
| M1 | destination section container-nested **in the destination doc** (Q in a quote, boundary R in the same quote); nextID codec, cross-doc | members `nextID=R`, heading `nextID=m1` | **clean landing, code 0** — the whole run re-nested as the destination quote's children, member order, heading immediately before the first member, R/r1 still bounding after; source emptied of the run |
| M2 | adversarial provenance-gate miss: anchors resolve into the **source** tree (member ops `nextID=q2` inside the source quote; the quote itself a moved member), cross-doc | as the codec, source-side anchors | the guard fires anyway (`isMovingParentIntoChild`: the anchor and the container cohabit the source tree) → whole rollback, both layouts byte-identical |
| M3 | first moved member is a container; heading leg anchors on it after it has already crossed mid-batch | members `nextID=Z`, heading `nextID=<quote id>` | **clean landing** — `b1, H, quote, m2, Z`; the `nextID` branch takes no fold redirect, the emptied heading drags nothing |

Guard provenance (source-read): the self-anchoring container op trips
`isMovingParentIntoChild` (`transaction.go:1028-1035`) or the
`id == targetParentID` SkipTx arm (`transaction.go:821`), and the op
loop's action-generic rollback (`transaction.go:549-551`) undoes
everything — including ops that had already landed (L1's first member
entered the quote before the rollback restored it). The raw response in
every rollback case is code 0 with the ops echoed as executed
`doOperations` and no failure marker — the silent-rollback shape case E
established, now confirmed for a second op class.

### Implications for the plan

1. **The containment refusal is judged over the moved section's closure**
   — `sectionOf(sourceHeading).closure`, never `members ∪ {H}` (§4's
   bullet reworded). Same-doc the kernel backstops a miss (L1–L3 all roll
   back whole), so the refusal is diagnosability — a precise pre-mutation
   message instead of the silent `nothing-moved` landing.
2. **Cross-doc, the containment shape cannot arise** (the moved set lives
   in the source tree, the destination resolution in the destination
   tree), and the guard's cross-doc blind spot is harmless: the blind
   combination (source node vs destination anchor) is exactly the case
   where nothing is inside anything. M2 shows the cohabiting case still
   trips the guard — the provenance gates are diagnosability, the kernel
   the backstop.
3. **"End of the destination's section" is container-local** (M1): a
   destination heading inside a quote/callout moves the whole section
   INTO that container. Consistent with `append`'s rule; the tool
   description and the owner report must state it.
4. **The owner certification must be container-local** (M1's landed
   state): a document-order backward level scan would name a heading
   outside the quote as the landed heading's owner; only `sectionOf`'s
   container-local membership gets it right.
5. **The heading leg anchoring on a crossed container member is safe**
   (M3), extending A2's first-member anchor to the container case.

## Caveats

- Single small fixture, one notebook, same box; results are 3.8.7-pinned and
  version-coupled like everything else in the primitives. Each reading is a
  single-shape sample — one fold combination per case, one latency sample
  for J — so the live pins must rehearse them (the plan's §3 pin duty),
  not inherit them from this transcript.
- The fold was set by API (`setBlockAttrs`), the way the frontend does it; the
  kernel's fold state is otherwise invisible to clients, which is the point of
  the fold-blind posture.
- Walk-rendering note: `getChildBlocks` on a heading returns the heading's
  **whole section** (`HeadingChildren` semantics), so a naive recursive walk
  double-reports nested sections. The primitives' `walkBlockTree` already
  encodes the correct treatment; the spike's flat top-level read is what the
  layouts above are taken from.
- No throttle/lock effects encountered; the notebook teardown verified clean.
- The containment runs (L, M) left fold state unset — the fold variants of
  the nested-destination shapes are unprobed; the refusal fires
  pre-mutation regardless of fold, and the §3 rehearsal list covers the
  decided codec's fold matrix. The M runs are also single-shape samples
  (one container type — blockquote — per landing shape).
