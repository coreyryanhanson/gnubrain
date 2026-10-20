# Move-section — design

Status: **Design decided (§2, §6); exposed as a widened `mode: move` section arm, not a new mode (§1); implementation pending**

> **Route and codec are decided.** The route is one batched
> `/api/transactions` call of raw `move` ops — layer 1's `transact` plus
> the primitives' `batch.ts` (`transactThenWalk`), first consumed by the
> batched `delete-section`. `POST /api/block/moveOutlineHeading` is
> rejected on the record: it moves a heading plus its whole section
> atomically, fold-blind, landing exactly at end-of-destination-section
> (`kernel/model/outline.go:29` header; the end-of-destination landing
> ground is `:88-96`, the level rewrite `:100-115`, the silent
> rejections `:49-52`/`:76-81`), but its level rewrite is unconditional,
> it ceilings at same-doc/root-level, and it rejects silently through
> `PushMsg`. The codec is the **insert-before (`nextID`) arm** — members
> in document order onto the destination section's boundary, then the
> heading anchored before the first landed member — with the doc-end
> arm chaining members on `previousID` and reusing the same heading leg
> where no boundary exists (§2), live-confirmed by
> [`move-section-spike.md`](move-section-spike.md). The
> kernel facts the route rides live in the primitives' AGENTS.md fact
> list (the "batched delete route" entries: batch rollback and its
> `blocktrees` residue, ack-time commit-wait, the ≥32-op cliff, queue
> ordering). Cross-doc is in v1 scope — this mode is the multi-doc
> consumer `batch.ts`'s `walk-failed` arm defers to — and the landed arm
> certifies the moved heading's new owner (§2, §6).

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

The foundation this sequence composes is complete — delete-section landed
the batched-route plumbing and the enumerated loop shape (§3). The problem
this mode solves is **packaging, plus one capability the manual path cannot
give — atomicity**: the sequence it automates is already expressible today,
and the refusal wording itself advises it (move the members individually
against a derived section-end anchor, then the emptied heading), so the
corruption trap the manual sequence once held is already closed by the
fold-blind refusals; but the manual path is N+1 `kb_write` calls (one per
member, then the emptied heading), each a model turn, and cannot be atomic
— a mid-sequence failure strands half a section, and the emptied-heading
leg is last by necessity — and no path answers where a moved section
actually attached (§2's owner certification). The batched route delivers
**one call, one group receipt, all-or-nothing**, with the owner report.
Two decisions were once conflated here and are now separated. The
**batched transaction** is genuinely new machinery and unavoidable for
atomicity — a flow cannot call `transact` itself, because the tool
layer never sequences kernel mutations (the layering contract both
repos carry; `layerBoundary.test.ts` greps imports, not client
capabilities, so the bar is the contract, not the test) — so the
batched primitive is the only route to all-or-nothing. The **mode vocabulary** is a separate choice: a distinct
`move-section` mode was considered and rejected — its params
would be the per-id shape verbatim (`blockId`/`toDocId`/`toHeadingId`,
already on `move`), and a second mode keeps the original friction (the
agent must know whether a heading bears a section *before* calling — the
decomposition problem wearing a new name). The decision: **`mode: move`
widens** — a heading `blockId` names the moved section, the
members-then-heading legs ride the batched route inside the existing
`move` flow, and the dispatch keys on row type, not on
section-bearingness: every heading — memberless or not — rides the
batched route, so the agent never needs to know whether a heading bears
a section before calling (the memberless degenerate is the same route
at its degenerate shape, not the per-id path; non-heading blocks keep
the per-id semantics). The
asymmetry with `delete`/`delete-section` is a principle, not an
inconsistency: inferring scope from hidden state is safe for a
non-destructive mode and catastrophic for a destructive one, which is
why `delete-section` stays an explicit mode while `move` widens. The
cheapest rejected alternative remains on the record: running those legs
as sequential per-id verified keeps — it closes the call count at a
fraction of the pin burden but loses all-or-nothing, and a torn per-id
move is worse than a stranded half-section: the already-landed members
then trip `already-at-destination`, so recovery means diffing the live
tree by hand. Atomicity is the decisive property; the widened arm over
the batched route is how it ships. The design rides the batched route
(§6), and what remains is implementation.

## 2. What the mode must solve

- **The codec's load-bearing invariant.** Every leg inserts immediately
  before the same literal anchor — the `nextID` boundary arm, the chain
  arm's per-leg `previousID` anchors — so landed order = issue order;
  the only fold-dependent effects left are drags of blocks that are not
  re-issued (`resolveHeadingMoveChildren`), and those always land
  inside the enumerated run's span, where the divergence arm sees them.
  The fold readings below (B/B2/D1a–c/K1h2/F5) are corollaries of this
  invariant; traced against `transaction.go`.
- **Landing semantics: end of the destination section, on the
  insert-before arm.** The batched route issues raw `move` ops, and
  `doMove` reads `operation.NextID` first (`transaction.go:695-700`):
  `nextID` inserts the moved node *immediately before* the anchor — the
  `moveBefore` branch, which the fold redirect cannot reach (`!moveBefore`
  guards it, `transaction.go:762-768`), so any anchor is a literal
  position, fold-blind. The codec: **every member of the source section's
  run in document order, each `nextID = <the destination section's
  boundary>`** (the next heading at level ≤ the destination heading's, in
  the caller-held destination walk — `sectionOf`'s boundary), then **the
  heading `nextID = <the first member's id>`** — the members accumulate
  in document order before the boundary, and the heading lands between
  the section's last pre-existing block and the first member:
  end-of-section semantics, no reverse order. A memberless section issues
  only the heading leg (`nextID = <the boundary>`). A destination
  section with **no following boundary** — no next sibling heading in
  its container, so the section is its container's last, which includes
  but is not limited to the document's last section (what "doc-end"
  names below) — has
  no `nextID` address; there the codec switches to the **chain arm**:
  the members chain `previousID` in document order from
  `deriveMoveAnchor`'s projection — the destination section's **last
  member** (`section.members.at(-1)`), recursing into it while it is a
  heading, so the anchor is a leaf, a container, or a heading with an
  EMPTY section (spike CT1–CT4: the container anchor lands the run
  after it as siblings, heading tail included; spike N1/N2: the
  empty-section tail heading anchors after-heading — placement **is**
  end-of-section there and the fold branch has nothing to jump past —
  while the earlier "last non-heading member" phrasing landed the run
  before the tail heading and swallowed it, live-confirmed as N1x); the
  anchor is a sibling position, never a block inside a container's tail
  — anchoring on a tail heading *inside* a container lands the run
  inside the container around that heading's section (spike CT3),
  against container-locality; the one heading inside a container the
  recursion does reach is the fixed point itself — an EMPTY destination
  section inside a container anchors on the destination heading, inside
  that container, and is clean and fold-independent (spike CT6/CT6h:
  after-heading is end-of-section while the section is empty, the
  redirect has no target) — a heading anchor inside a container is safe
  exactly when its section is empty, the only heading shape
  `deriveMoveAnchor` derives — and the heading issues **last** on the
  boundary arm's own leg,
  `nextID = <the first landed member>` (spike D1a–c: exact landing
  unfolded, with the source heading folded, and with the nested
  subsection folded — the same fold-blind branch, so the chain arm
  carries no LIFO rule and its heading leg carries no heading anchor).
  The chain legs are explicit `previousID` ops: an omitted or empty
  `nextID` is not a doc-end address — an op with all anchors empty
  rolls the batch back behind code 0 (spike F1). The recursion's fixed
  point **is** the empty destination section: no members → the anchor is
  the destination heading itself:
  fold-independent while the section is empty (the redirect has no
  target, `transaction.go:765`), and the landed judgment, not a
  refusal, owns the concurrent-append divergence (§6's tail clause;
  spike D1h–j). A memberless moved section on the chain arm reduces to
  a single heading leg (`previousID = <the chain anchor>`, or
  `previousID = <the destination heading>` on an empty destination —
  spike D1f–g — or, with `toHeadingId` omitted against an empty
  destination doc, the doc-end form's `parentID = <docId>` prepend). **A destination with no `toHeadingId` at all** — the
  per-id shape's documented doc-end form — has no destination section:
  the codec rides the chain arm anchored on
  `deriveMoveAnchor(destWalk, undefined)`'s projection — the
  destination doc's last root-level block on `previousID`, the
  `parentID = <docId>` prepend when the doc is empty — the projection
  the per-id path already uses for its doc-end form, with the heading
  leg unchanged (`nextID = <the first landed member>`); the predicate's
  chain clause reduces to "nothing follows the run at doc level", and
  the owner projection reads the landed state unchanged. Same-doc and
  cross-doc are identical there. **The anchors are container-local
  sibling positions.**
  The doc-end chain anchor lives inside the destination section's own
  container by construction, and spike M1's boundary did too, so a
  destination section that is itself container-nested — a heading
  inside a quote, callout, or list — re-nests the moved members **into
  that container**: spike M1 landed the whole run as the destination
  quote's children, member order preserved, heading immediately before
  the first member, the boundary still bounding after it. A boundary outside the
  destination's container cannot arise — `sectionOf`'s boundary shares the
  heading's parent, container-local by construction; the container-nested
  doc-end chain is live-confirmed too (spike CT5/CT6: the destination
  section is its container's last section, the chain anchor a sibling
  inside that container, and the run re-nests into it — the same
  locality, both arms). This is the section rule's locality, the
  same rule `append` obeys — documented behavior the tool description
  must state, and the owner report is what surfaces it. The heading
  leg's anchor may likewise be a container member that has already
  crossed mid-batch: the landing is the heading immediately before it
  (spike M3 — the `nextID` branch takes no fold redirect, and the
  emptied heading drags nothing). The `previousID`/LIFO codec (spike
  case C — the per-id route's only reachable shape, its hazards
  recorded in the spike) is rejected: the insert-before arm supersedes
  it. A start-of-section landing is out of scope
  (§5): inserting a same-or-shallower heading at a section's *start*
  re-bounds the destination
  heading's section — the destination's body would become the moved
  section's body — and the only prepend arm the kernel offers is the
  doc-start `parentID` form, live-confirmed reachable but landing at
  the document's start (spike F2), the wrong position — so a
  start-of-section landing cannot be expressed.

- **Anchor stability: dissolved by the arm choice; the per-id path keeps
  its own refusals.** The fold redirect (`transaction.go:762-768`) fires
  only when the anchor side is `previousID` (`!moveBefore`) *and* the
  anchor is a heading: "after this heading" then means "after the
  heading's whole section" self-folded — hidden state this package never
  reads — and such an anchor is **single-use** under a multi-op sequence
  (its first landing makes it section-bearing, so every later leg
  addresses a silently flipped position behind unconditional HTTP
  success). That analysis governs the per-id move path, whose fold-blind refusals
  (`heading-with-section`, `heading-anchor-with-section`) stay exactly as
  they are. On the batched route the decided codec's anchors are
  `nextID` positions — the destination section's boundary for every
  member leg, the first landed member for the heading leg — so no
  anchor is ever re-addressed after the state it names changes. The
  doc-end arm's chain is the one `previousID` shape: its anchors are
  stable per leg and each is addressed exactly once; the first landed
  member is the single block addressed twice, once per side
  (`previousID` by the next member's leg, `nextID` by the heading leg),
  and the `nextID` side is fold-blind — no LIFO rule and no
  shared-anchor hazard (spike D1a–c); a member leg anchoring on a
  landed heading member can hit the fold redirect, which self-inserts
  the member into its already-correct place (K1h2). No stability
  classification is
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

- **Fresh-content scope: moves stay unguarded.** The fresh-content
  precondition stays scoped to the four destroy-shaped primitives (edit,
  delete-block, replace-section, delete-section). A move destroys nothing —
  a member whose content changed since the baseline travels with its new
  content — so a content precondition is the wrong instrument here; the
  mode's protection against misplacement is the landed-order judgment over
  the live post-move walk (§6). Guarding the group while the per-id legs
  stay unguarded would judge identical content differently by path, so the
  line is drawn at the primitives level: **no move path carries the guard**.
  The cross-doc residual is named, not absorbed: a moved member also
  leaves the source doc — delete-shaped for the source's readers — and
  the per-id path carries that exposure unguarded today, so the same
  path-symmetry argument covers it. The rationale is recorded in the
  tool-side fact list when the mode lands (§6), so the absence reads
  as a decision, not an omission.

- **Landing is level-bounded; the judgment certifies the owner, not
  just the order.** Landing is end-of-section for every level, but the
  section rule re-bounds the landed heading by its level relative to
  the destination section's **boundary** (the next heading at level ≤
  the destination heading's — the codec's own anchor):
  - A moved heading **strictly shallower than the boundary** is
    refused before the batch (§4's `shallower-than-boundary`): it
    would not be terminated by the boundary — the moved section would
    swallow the destination's boundary heading and the sections after
    it into itself, silently re-bounding the destination's section.
    That is the outline corruption this mode exists to prevent, and §5
    forbids the level rewrite that would make it safe, so the mode
    refuses rather than reports. The refusal is a level comparison
    over walks the sequence already holds — zero kernel calls.
  - A moved heading **at the boundary's level or deeper** is terminated
    by the boundary and claims nothing beyond the moved members: at the
    destination heading's level it lands as a following sibling;
    deeper, it lands **inside** the destination's section and nests
    under the destination heading (owner: the destination heading, or a
    deeper heading within the destination section that precedes it).
  The landed arm
  certifies the moved heading's **new owner** — the heading whose
  `sectionOf`-derived section contains the landed heading, read
  container-locally off the walk, never a document-order backward level
  scan (in spike M1's landed state the true owner sits inside the
  destination's quote, and a backward scan names a heading outside it) —
  alongside the order, and
  the receipt says where the section actually attached. This is
  reporting, not a level rewrite — the mode still never rewrites levels
  (§5). The projection is new code, not a read the primitives already
  have: no owner projection exists today, so it lives in `placement.ts`
  beside `sectionOf`, with placement-corpus cases (M1's quote case,
  the deeper-landing case, and the enclosing-container case are the
  three that matter; §6's pin table). The owner is
  `{ headingId, level } | null` — a moved heading at the document's
  level terminates the document's section and owns only its members, so
  no heading's section contains the landing (reachable on both arms);
  `null` names the container/doc root, and the receipt says so.

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
   anchors roll back; `parentID` prepends at doc start; the chained
   members with the heading on the boundary arm's own `nextID` leg land
   exactly across the fold matrix — D1a–c; the empty-destination and
   memberless degenerates under both anchor folds — D1d–g; the
   concurrent-append swallow — D1h–j; a heading-anchored doc-end form
   lands fold-**dependent in order** — F4a/b, the recorded history
   behind the trim's rejection of that form), the **legality-check
   rollback** (`TxErrCodeReloadUI`, whole-batch behind code 0), the
   **cross-box skip arm** (encrypted→plain whole-batch rollback) and the
   plain↔plain cross-notebook **success landing**, the **cross-doc residue
   round trip** (wrong-root row → `getBlockInfo` not-found; destination
   write heals nothing; source write restores; heal-then-retry lands
   whole), the **containment matrix** (L0–L3, M1–M3: the closure
   refusal's ground, the container-local landings, the guard backstop),
   the **chain anchor on an empty-section tail heading** (N1/N1h/N2/N2h, plus the N1x
   mis-landing contrast — the §2 anchor-rule correction's live ground),
   and the **≥32-op batch** (per-op path, 36 ops / 341 ms, lands
   whole). Their transcript is the implementation plan.

   The spike readings are transcript evidence, not pins. The live suite
   must rehearse what the mode rides so an upgrade pass falsifies them
   in place rather than trusting a transcript that dies with the next
   kernel upgrade. The single inventory of those rehearsals — case id →
   what it falsifies → where it is pinned — is §6's pin table; this
   section records only what the spike executed, never a second copy of
   the pin plan. The original spike's raw transcript files under `/tmp` are gone except
   the `/tmp/spike-move-trim-*.log` set (which corroborates all ten D1
   verdicts), the N-leg transcript `/tmp/spike-move-tailheading.log`, and
   the CT5–CT10 container-shapes transcript
   `/tmp/spike-move-unprobed.log`;
   the spike doc is now the record — re-probe any reading
   the live suite has not yet pinned before relying on it.

## 4. Refusals the mode must add

Group-level, pre-mutation, zero kernel calls in the refusal itself —
every refusal judges walks the sequence already holds, never a fresh
fetch — conditions that would otherwise only surface mid-sequence,
after the tear. (The named
`headingId`/`toHeadingId` must resolve to heading rows in their walks —
`heading-absent` otherwise, a precondition rather than a §4 refusal.
The destination heading is additionally judged flow-side by the
per-id path's existing arm — `resolveHeadingTarget` (read barrel) over
the pre-move destination walk: `untargetable` when its parent type is
outside `TARGETABLE_CONTAINER_TYPES` (`tabs`, unnamed containers). The
read surface marks those headings `(not targetable)`, so accepting one
here would contradict the outline notation; `WalkedBlock.parentType` is
already on the row, so the judgment is free. The judgment is not an arm
of the new primitive's union: the flow holds the destination walk before
the primitive call, the derivation already lives in the primitives and
is shared with the per-id path, and a duplicate union arm would double
the judgment and word it from a payload the flow already holds. One
owner, flow-side, for both arms of `move`.)

- `toHeadingId` names the moved heading itself (identity), or the
  destination section lies inside what the move transports — judged over
  the moved section's **closure** (`sectionOf(sourceHeading).closure`),
  never the sibling-id set: a destination heading nested inside a
  container member's subtree is transported with the move yet invisible
  to `members ∪ {H}` (spike L0: the sibling-id forms of the
  identity/containment and already-at-destination arms miss it; the
  closure test catches). Same-doc, the kernel backstops a miss — every
  naive derivation the shape permits (the doc-end leaf chain onto the
  destination's leaf, append-into-container, a `nextID` anchored at a
  boundary inside the moved container) rolls the batch back **whole**
  behind code 0 (spike L1–L3), so the refusal's value is
  diagnosability: a precise pre-mutation message instead of the silent
  `nothing-moved` landing. Cross-doc the shape cannot arise (the moved
  set lives in the source tree, the destination resolution in the
  destination tree), and an anchor that cohabits a tree with the moved
  container — a gate miss anchoring into the source doc — still trips
  the kernel's own self-anchoring guards (`isMovingParentIntoChild`
  walks the anchor's real ancestry in whatever tree it resolved into;
  `id == targetParentID`), rolling back whole (spike M2). One closure
  test serves both docs' resolutions.
- The moved heading is **strictly shallower than the destination
  section's boundary** — landing would not be terminated by it: the
  moved section would swallow the destination's boundary heading and
  the sections after it into itself, silently re-bounding the
  destination's section (the outline corruption this mode exists to
  prevent; §5 forbids the level rewrite that would make it safe).
  Refusing keeps every reachable landing inside the landed predicate's
  exact-equality scope (§6's order clause). Judged pre-mutation with
  zero kernel calls: both levels read off walks the sequence already
  holds — the moved heading's off the source walk, the boundary's off
  the destination walk (`sectionOf`'s boundary, container-local).
- The group is **already at the destination** — derived two ways: the
  destination section's boundary is the moved heading itself or lies
  inside what the move transports (the boundary heading is `headingId`,
  or ∈ the moved section's `closure` — the sibling set plus every
  transported descendant; the closure excludes the heading itself, so
  the self case is its own test — e.g. with `## B / b1 / ## H /
  m1`, moving H's section onto the end of B's section makes `H` — the
  moved heading — the destination's boundary), or the moved
  section is the destination section's **trailing run** — the moved
  heading is a **member** of the destination section (`sectionOf`
  members, not the closure: a moved section nested in a container
  inside the destination section sits in the closure but is a
  legitimate destination, judged normally by the landed predicate's
  span clause) and no member of the destination section follows the
  moved section's last block — the memberless degenerate compares the
  moved heading itself, so the arm fires when it is already the
  destination section's last member, and with `toHeadingId` omitted the
  same reads at doc level (the moved section already occupies the
  document's end) — e.g. with
  `## B / b1 / ### D / d1 / ## C / c1`, moving D's section onto the end
  of B's section: the boundary `## C` is outside the moved set, so the
  first arm misses, yet D's section already occupies the destination's
  end). One refusal,
  never a receipt reporting a move: the trailing-run derivation issues
  only position-preserving re-inserts, so the batch acks behind an
  unchanged layout and the landed predicate reads a false `landed` over
  the no-op (the run sits immediately before the pre-move anchor); the
  first derivation's anchor lies inside the transported set, so adjacency
  cannot pass and the judgment lands on a `nothing-moved` whose
  recovery guidance fits nothing. Either way the receipt misreports
  a no-op — the same ground the per-id path's `already-at-destination`
  arm stands on. The kernel's skip arms are not the ground here: no anchor
  names the op's own id, and no anchor sits inside the moved subtree
  (spike case E's skip-class rollback is a different shape — the §6
  cause-free arm covers it).

## 5. Non-goals (until revisited)

- No re-nesting via move — that is `edit`-demotion (friction §4; the
  demotion idiom is documented in the `kb_write` tool description).
- No start-of-section landing and no heading-level rewriting —
  end-of-section only (§2).
- No reproduce-and-delete route: `append`/`insert` of the section's
  markdown at the destination followed by `delete-section` at the source
  composes two existing verified primitives with zero new kernel facts,
  and is rejected on the record — block ids change, so inbound refs, IAL
  attributes, `created`/`updated`, and history are lost; and the two
  calls are not atomic, so a tear leaves a duplicated section, worse
  than a stranded one.
- No *new* kernel-side section API — the existing `moveOutlineHeading`
  is rejected on the record (header note above).
- No new refusals on the per-id move path beyond the fold-blind
  refusals already in place — the widened section arm *replaces*
  `heading-with-section` for every heading `blockId` (the row-type
  dispatch routes all headings to the section sequence;
  `heading-with-section`'s concern is discharged by the section arm's
  own §4 refusals), it does not add gates beside it.

## 6. Duties on the batched route

These are the duties the implementation must satisfy; the route and
codec decisions they build on are recorded in §2.

- **The route: one batched `move` transaction.** Members in document
  order onto the destination section's boundary (`nextID`), then the
  heading anchored before the first landed member — the decided codec
  (§2, spike-confirmed), with the doc-end arm chaining members on
  `previousID` and reusing the same heading leg where the destination
  section has no following boundary (§2, spike D1) — as raw `move` ops
  in one `/api/transactions`
  call, judged from the per-touched-doc post-write walks
  (`transactThenWalk`).
  Move's batch always takes the kernel's per-op execution path (the ≥32 bulk
  path requires an all-delete batch), so the cliff is not this mode's
  interaction. Scale is the stated posture: each op runs two full-tree
  upserts inside the kernel's global transaction lock (36 ops / 341 ms in
  the spike; roughly 2 s at 200 members), and the kernel's write queue is
  FIFO on client timestamp, so a large section move delays every other
  write in the session for that window — the tool description says a
  large section move is a heavy operation. The drift posture is the batched precedent's: the batched
  route has no drift arm of its own — the primitive owns the probe and the
  `drift` arm, refusing before issuing (delete-section's shape, recorded in
  its union docstring); the gate's cached-verdict refusal stays as
  defence-in-depth. The dispatch is a row-type
  judgment — "is `blockId` a heading?" — and it lives in the
  primitives, beside the sequences it routes between: one entry point,
  `moveVerified` in `move.ts`, over the per-id input shape
  (`blockId`, `rootId`, `destRootId`, `sameDoc`, the caller's
  destination walk, `toHeadingId?`). The entry owns the source walk's
  single fetch, reads the row type off it, and dispatches internally —
  a heading to the batched section sequence (`moveSectionVerified`,
  every heading memberless or not), a non-heading block to the per-id
  sequence, which becomes an internal core taking the fetched walk
  instead of fetching its own (the cross-doc fetch `moveBlockVerified`
  performs today moves into the entry; the core's scoping and target
  checks are unchanged). No path fetches the source walk twice, and
  the flow's cross-doc shape is unchanged (it holds only the
  destination walk, from the destination resolution). The placement
  rides the layering contract, not a capability claim: the routing
  judgment sits with the mutation sequences it routes between, inside
  the write barrel's boundary, so the flow neither sequences kernel
  mutations nor re-derives placement — same-doc the flow does hold the
  source walk, and routing there would still split the routes'
  ownership across the layer line. The flow keeps its wording branch
  over a closed wrapper — `{ route: "per-id" | "section", outcome }` —
  the plan's own `walk-refused` argument one level up: one flat union
  across both routes would carry every arm in a single kind space,
  with `already-at-destination` colliding at two payload shapes (the
  per-id arm's `{ blockId }` against §4's group derivation) and
  forcing field-presence narrowing inside the flow's `satisfies never`
  switch; the wrapper keeps each route's union exactly as closed as it
  is today, and the two nested exhaustive switches never need to know
  which route ran before the wrapper names it. The module
  docstring states the walk rule
  (the entry takes the caller's destination walk — the flow serves and
  seeds from it — and owns the source walk's single fetch, reusing the
  caller's walk for both roles same-doc).
- **Cross-doc is in v1 scope.** The judgment is
  per-touched-doc post-write walks, so this mode extends `batch.ts`'s
  `walk-failed` arm to carry the partial walks its docstring defers to
  "a multi-doc consumer" — this mode is that consumer. The extension
  lands in the primitives unpublished, `file:`-linked, its shape
  perfected side by side before either repo releases. The destination walk is
  caller-held — the flow holds it from the destination resolution, and
  the destination serve seeds baselines per the seed-site rule. The
  source walk is the entry's own single fetch (the route bullet's
  dispatch), shared by the dispatch, the moved-set derivation, and the
  §4 refusals — zero calls in the refusal itself (§4). Both walks pass
  through the caller-provenance gate delete-section models
  (`sectionSubjectOf`: `foreign` / `walk-truncated`, per walk — the
  widened consumer needs a source-vs-destination role discriminant on
  per-walk refusals, and takes it as a local wrapper arm in the new
  module — `walk-refused` carrying `role: "source" | "destination"`
  over the existing shared types — because two of the three per-walk
  arms are payload-free shared types (`WalkTruncated`;
  `heading-absent`'s `SectionRefusal`), so widening the shared shapes
  ripples across every consumer; `ForeignRefusal`'s payload stays as it
  is and delete-section is untouched). The roles are not symmetric, and
  the asymmetry is where the safety lives: the source walk is fetched
  by the entry's own `rootId`, so its root matches by construction and
  `foreign` cannot fire on it — the source side's guard is the
  derivation itself, the moved set read off the fetched walk and never
  caller-supplied (delete-section's own rationale: the derivation, not
  post-hoc validation, is the guard), so no gate miss can issue raw
  `move` ops for another doc's blocks; only the caller-held destination
  walk can be foreign, and a gate miss there mis-anchors the batch — a
  misplaced landing the landed judgment and the kernel guards catch,
  never a foreign-doc mutation. The source-side `foreign` check stays
  as a cheap fail-closed tripwire against a future caller, and the
  `role` discriminant exists for wording, not safety — same-doc one
  walk serves both roles. The kernel guards are the backstop, and their cross-doc
  reach is characterized (spike M1–M3): the containment shape cannot
  arise cross-doc (the moved set lives in the source tree, the
  destination resolution in the destination tree), and an anchor that
  cohabits a tree with a moved container — a gate miss anchoring into
  the source doc — still trips `isMovingParentIntoChild` (it walks the
  anchor's real ancestry in whatever tree the anchor resolved into) or
  the `id == targetParentID` arm, rolling the batch back whole behind
  code 0 (spike M2); the gates are diagnosability, the kernel the
  backstop. Cross-**box** is policy, not kernel behavior: the kernel
  accepts plain↔plain cross-notebook moves natively (spike H2) and
  silently rolls back cross-crypto-boundary batches (`IsSameCryptoBoundary`
  → `SkipTx`, spike H1 — transcript evidence and a `batch.ts`
  raw-contract fact, not bought for this mode: unreachable through it,
  since encrypted boxes are dropped at KB validation) — the cross-box refusal is a
  consequence of the destination resolution the flow already performs,
  not new gate machinery: `writeTarget.resolveDocTarget` resolves
  `toDocId` box-scoped — same-KB by construction, a cross-notebook
  destination reading as `noSuchDocEnvelope` — exactly as the per-id
  move flow resolves it today; `writeConfirm.ts` stays a
  zero-kernel-call local decision and gains nothing, the primitive
  receives no box knowledge, and its union stays box-blind — no
  cross-box arm exists to invent.
  Single-doc v1 would make the automated route narrower than the per-id
  path it replaces, and a later cross-doc release would pay a second
  wording/probe/pin ship. Packaging rides the same pass: the dispatch
  entry `moveVerified` (`move.ts`, already a shipped module) joins the
  `./write` barrel exports as the flow's one entry, and the new
  primitive module (`moveSection.ts`, exporting `moveSectionVerified` —
  the `deleteSection.ts`/`deleteSectionVerified` precedent) joins the
  primitives' `package.json` `files` allowlist and the barrel beside
  it; the barrel-completeness test lists both, the two new
  `placement.ts` projections (the next-sibling-of-the-run projection
  and the owner projection) join the read barrel's internal exports per
  its placement bullet (`sectionSubjectOf`/`cascadeDescendantsOf`
  precedent, completeness guard updated in the same pass), and the
  tool side's `layerBoundary.test.ts` import discipline covers the
  widened flow (the section-arm module beside `writeMove.ts`, or the
  branch within it — whichever imports the new primitive). Two `batch.ts` duties ride the
  same extension: the docstring's "consumers keep the batch single-doc"
  sentence is amended to its real scope — the ≥32 bulk path is
  all-delete, so the single-doc habit was delete-route hygiene, not a
  batch constraint — otherwise it reads as forbidding this mode's
  consumer; and the `walk-failed` arm's partial-walk payload is
  additive — `delete-section`'s arm reads only `error` and compiles
  unchanged, so the edits are the arm's docstring plus this consumer's
  switches, not a wording pass over delete-section.
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
  implementation surfaces a move failure class the cause-free arm cannot
  serve honestly, the route re-opens. No HTTP-visible batch failure channel exists
  (the kernel publishes reasons only on the editor websocket's `txerr` push,
  which a zero-dep HTTP client does not speak; `undoState` reads dead for
  API-originated writes; doc history is an async delayed task) — carrying a
  failed-batch failure reason stays off the table unless a kernel release
  grows an HTTP-visible channel.
- **One call, one post-write walk per touched doc.** `transact` is one
  call, so the only throw is post-issue pre-ack — no walk can certify
  state, and the transport-unverified frame carries the whole judged set
  (the enumerated moved ids) as its unconfirmed payload. The landed
  judgment is a stated predicate over the post-write walks, not a
  phrase — an unstated formula invites a membership-only check, which
  reads a fold-inverted group (body above its heading) as landed. The
  predicate is sibling-run
  adjacency, not array adjacency — the walk is a pre-order flattening on
  which container members' descendants sit between siblings (M1,
  CT1–CT4), so "contiguous in order" read as array adjacency would
  report legitimate container landings as divergent. Two facts over the
  post-write destination walk: (a) `sectionOf(postDestWalk, H)`'s member
  run **is** the enumerated member run — exact equality, in landed
  order (the strictly-shallower swallow is refused pre-mutation, §4's
  `shallower-than-boundary`, so the landed section claims nothing
  beyond the moved members); (b) the next sibling after that run in
  `H`'s sibling run is the destination section's boundary **as the
  pre-move destination walk holds it** (the codec's own anchor), never
  a boundary re-derived from the post-write walk — clause (b) needs a
  next-sibling-of-the-run projection beside `landingId`, not
  `sectionOf`. A
  memberless moved section lands `H` alone immediately before the
  boundary, an empty destination section contributes no block between
  its heading and the boundary, and both degenerate shapes reduce to
  the same clause. Adjacency pins the
  container for free — the anchor and the run read as siblings wherever
  they landed — so a destination re-nest into a quote or callout (spike
  M1) keeps its reading without any container-local reasoning. The
  doc-end arm has no boundary; there the run occupies the position
  immediately after the destination section's last pre-existing block —
  the chain anchor as the pre-move walk holds it (the chain arm's
  landing, spike D1a); with `toHeadingId` omitted the same clause reads
  at doc level — the run immediately after the destination doc's last
  root-level block (`docEndMoveAnchor`'s anchor). The
  run's tail is pinned with its head: on the chain arm nothing follows
  the run within the destination's container — the destination section
  is the container's last, so a block in that position arrived after
  anchor derivation and was swallowed behind the run's insertion point
  (spike D1h/D1j); on the boundary arm the head clause already pins the
  tail (the run sits immediately before the pre-move boundary).
  Content in the tail position that the pre-move walks do not account
  for is a `landed-divergent` arm, never a tolerated extension. The
  order clause is **exact equality**: `sectionOf(destWalk, H).members`
  equals the enumerated member run in landed order — the prefix
  tolerance existed only for the strictly-shallower swallow, and §4's
  `shallower-than-boundary` refusal removes that landing from the
  reachable set. The members are **absent from the
  source walk** — a cross-doc clause only. Same-doc one walk serves
  both roles, and a successful move leaves every member present in it,
  so absence there is false after every landing and proves nothing;
  same-doc success is the positional clauses above, judged on the
  single walk. Cross-doc, the moved ids are checked absent from the
  complete post-write source walk. A truncated post-write walk refuses
  (`post-walk-truncated`, per touched doc, carrying whatever its
  complete walks certify — absence is never asserted off a truncated
  walk) rather than asserting absence. The judgment runs in a fixed
  order — `nothing-moved` first, judged on positive facts over the seen
  span (presence is sound on an incomplete walk — delete-section's
  actual ordering: survivors/pre-move state outrank truncation), then
  `post-walk-truncated` (a truncated walk grounds neither landing nor
  absence), then the landed arms. Beside the order, the judgment
  certifies the moved heading's **new owner** (the heading whose
  `sectionOf`-derived section contains the landed heading, read
  container-locally — §2's owner bullet — derived as the last heading in
  document order preceding the landed heading whose `sectionOf`
  closure contains it — containment is `sectionOf`'s own product, so
  the projection cannot diverge from the section rule the way a second
  placement derivation would, and it is never a backward level scan,
  which M1's landed state falsifies), so the deeper landing (the
  section nests inside the destination's) surfaces in the envelope
  instead of passing silently; the ownership projection is reporting
  off the walk, never a level rewrite, and no prediction is checked
  against it — the level comparison that bounds landing is §4's
  pre-mutation refusal, not a post-walk double derivation.
  When the landed heading sits inside a container with no heading
  around it, the enclosing container's preceding heading is the answer
  — a `sectionOf` section contains such a landing via `closure`, not
  `members`; that case joins the placement corpus beside M1 and the
  deeper landing, and the corpus arbitrates the formulation over
  synthetic walks before the kernel wiring. The anchor derivations
  (§2's two forms) and the owner projection live in the primitives'
  `placement.ts` beside `sectionOf`, with placement-corpus cases — the
  flow never re-derives placement from walk order.
- **The document-order member derivation replaces the reverse-order one.**
  The batched route issues raw ops, so the per-id `heading-with-section`
  refusal that guarded a forward-ordered derivation is not in the loop;
  the folded-source readings are spike cases B/B2, and the set rule
  (every block of the run issued, sub-members included) is §2's.
- **Currency is as of the enumeration, and the drag lands at the front
  of the run.** The op array derives from pre-mutation walks. A block
  appended to the source section after enumeration is not in the moved
  set — but a leg whose source node is self-folded drags that node's
  current children with it (`resolveHeadingMoveChildren` fires on any
  self-folded heading — the moved heading's leg, or a folded mid-run
  member heading's leg; `transaction.go:927-929`), and the leg's branch
  inserts the node and then its remaining children immediately before
  the anchor (`transaction.go:792-799`), so the appended block lands at
  the **front** of that leg's run — between `H` and `m1` on the moved
  heading's leg, at the front of the sub-run on a folded member's leg —
  always inside the enumerated span, not outside it. The landed
  predicate catches it in its lead (the run is no longer contiguous and
  in order), and the divergence arm names it: every block inside the
  **enumerated run's span** — the landed heading through the enumerated
  run's last member, the span the drag inserts into — that is in neither
  the enumerated set nor the pre-move destination section
  (`sectionOf(preDestWalk, toHeadingId)`'s heading and members) is an
  unjudged presence, whatever its provenance, never a silent one. The
  span is the enumerated run's — with the shallower refusal in place
  the landed section's members are exactly the enumerated run, so span
  and landed section coincide. The section-scoped
  comparison set is what keeps
  same-doc honest: the caller holds one walk serving both roles, so a
  walk-wide exemption would sweep the whole document's pre-move content
  into the tolerated set. A concurrent append into the destination
  section between the boundary walk and the batch lands ahead of the
  moved run on the boundary arm (the member legs anchor at the
  boundary): the predicate passes and the landing is still correct
  end-of-section semantics — no divergence. On the chain arm the same
  append lands behind the run's insertion point and is swallowed into
  the moved section's tail, fold-dependently (spike D1h/D1j; a folded
  destination heading redirects the first leg past the append, D1i) —
  the predicate's tail clause catches it as `landed-divergent`, never a
  silent one. The destination-side divergences that
  matter are the boundary id vanishing (the batch rolls back whole,
  `TxErrCodeBlockNotFound`) and the boundary heading moving elsewhere
  (the anchor resolves where it now sits — a landed-divergent report).
  The unfolded case has no drag: a block appended into the source
  section after enumeration simply stays in the source, the predicate
  passes, and the receipt must not overstate — the same explicit
  residual acceptance `deleteSectionVerified` records (a concurrent
  addition under the heading after enumeration falls outside the set).
  Mirrors `deleteSection.ts`'s "as of the enumeration" wording; the drag
  reading is spike case B.
- **The tool-side seams land with the primitive — inside `mode: move`,
  not a new mode.** No new schema row: `move` already carries
  `blockId`/`toDocId`/`toHeadingId` (`writeSchema.ts`), so the widened
  arm is the existing per-id shape with `blockId` widened to name a
  heading (the moved section's root; non-heading blocks keep the
  per-id semantics) and `toDocId` required, matching `move`'s verdict).
  The `writePrepare.ts` dispatch and its exhaustive tail keep their
  shape — the section arm is a wording branch inside the `move` flow,
  while the row-type dispatch itself lives in the primitives' entry
  point (the route bullet above): the routing judgment sits with the
  mutation sequences it routes between, inside the write barrel's
  boundary — not because the flow lacks the walk (same-doc it holds
  the source walk), but because the tool layer neither sequences
  kernel mutations nor re-derives placement. With the section arm
  live, `heading-with-section` is unreachable from the tool path —
  every heading `blockId` routes to the section sequence, memberless
  or not — so it stays in the primitives' union as the per-id
  contract and defence-in-depth for non-tool callers, its docstring
  marking it unreachable from the widened flow (an arm a later
  contributor could misread as live otherwise); the description
  change also retires the per-id refusal's
  move-the-members-individually advice sentence, which the widened
  capability contradicts. The
  destination-doc resolution the flow already performs for `move`
  (`writeTarget.resolveDocTarget` on `toDocId` — box-scoped, so a
  cross-KB destination refuses before any op; the grant gate gains
  nothing, per the cross-doc bullet above) is reused unchanged. The
  `kb_write` tool description (`write.ts`) carries the capability
  statement, and it is load-bearing: the widened arm removes a refusal
  (`heading-with-section`), so the description must say what a
  heading `blockId` now does — "move this heading" moves the
  heading's whole section, memberless or not (a memberless heading
  moves as its single block, same route and landing), with
  landing, locality, the shallower refusal, and weight stated per the
  wording bullet below. The description-name pin lives in
  `__tests__/unit/writeSchema.test.ts` (the mode-description sweep;
  `contract.test.ts` pins the wire key list, which does not change).
  Both fact lists gain their entries in the
  same pass: the primitives' bullet titled "The batched delete route"
  widens to the batched route and gains the move-specific facts (the
  codec and its landing, the chain arm's anchors, the
  no-single-use-anchor posture, the rollback residue and heal
  doctrine); the tool-side list gains the §4 refusal set and the
  landed/owner sentences as wording-only entries (the judgments are
  the primitive's — the delete-section entry's shape), plus the
  no-fresh-guard rationale. A plan that
  covers only the kernel side leaves these to be discovered later.
- **The outcome unions.** The entry returns one closed wrapper —
  `{ route: "per-id" | "section", outcome }` — over the two routes'
  closed unions, and every consumer switch is exhaustive at both
  levels: the wrapper's `route` discriminant, then the route's own
  union. The per-id family is `moveBlockVerified`'s union, unchanged.
  The section family: Arms:
  - *Refusal* (pre-mutation, nothing applied — cross-box is refused
    flow-side at the destination resolution, so no box arm exists
    here): `drift`; the per-walk gate refusals (`foreign`,
    `walk-truncated`, `heading-absent` — per walk, the
    `sectionSubjectOf` gate) wrapped in the `walk-refused` arm
    carrying `role: "source" | "destination"` (the cross-doc bullet's
    local wrapper; the shared types stay untouched; `foreign` is
    reachable only on the destination role — the cross-doc bullet's
    asymmetry); `own-closure` (§4's
    identity/containment refusal, judged over the moved section's
    closure); `shallower-than-boundary` (§4's level refusal, judged on
    the held walks' levels); `already-at-destination` (§4's two
    derivations).
  - *Transport*: `kernel-refused` (the batch call was refused by HTTP —
    on the batched route that is not proof of non-application, so the
    flow's refusal frame carries the route's `refusalNote`, never a
    nothing-landed claim); `transport-unverified` (post-issue pre-ack throw — the
    whole judged set as the unconfirmed payload); `walk-failed` (a
    post-write walk threw — widened per the cross-doc bullet to carry
    the partial walks).
  - *Judgment*: `landed` (predicate and owner certification passed —
    carries the landed run's ids in document order, the owner's id and
    level, or `null` when no heading owns the landing (§2's owner
    bullet), the anchor echo — boundary id or doc-end chain anchor — and
    both post-write walks, same-doc one walk serving both);
    `landed-divergent` (the run broke — carries the divergent position
    (`null` when the run is absent from the destination's complete
    walk: destination complete, a source-side member vanished, so
    `nothing-moved`'s clause fails and there is no position to report),
    the unjudged presences, span and tail alike, and the walks; the arm
    also covers the cross-doc copy case — the run landed in the
    destination while a member is still visible in the complete source
    walk, the per-id path's `still-in-source` folded here (a copy means
    the move did not land));
    `nothing-moved` (the
    cause-free silent-rollback arm — detected when the landed predicate
    failed and the batch did not apply: cross-doc, every enumerated id
    still present in the complete post-write source walk; same-doc, neighbour
    identity over the single walk — the block immediately preceding
    the enumerated run's head in the pre-move walk still immediately
    precedes it, with the enumerated members following in the
    enumerated order (index-shaped adjacency would misread any
    concurrent earlier insertion) — since set membership alone cannot
    distinguish landed from a silent no-op there; carries both post-write walks and the judged set,
    delete-section's `nothing-deleted` shape, so the flow serves and
    re-baselines from the state the verdict certified); `post-walk-truncated` (a
    truncated post-write walk — carries the complete walks and the
    judged set, whatever they certify; absence never asserted).
- **The ok envelope's payload.** The landed receipt is built from the
  verdict's own evidence, never a re-fetch: the landed run's ids in
  document order as the post-write walk holds them; the owner report
  (id and level); the destination outline
  served from the verdict's post-write destination walk and
  baseline-seeded from that serve (the `destOutlinePayload` precedent,
  anti-laundering invariant); and the source echo tail rendered from
  the post-write source walk (the per-id move's tail precedent).
  Same-doc, one walk serves both halves and is served once — the per-id
  precedent (`sameDoc ? {} : destOutlinePayload`), never outline plus
  echo tail from the same walk. The post-mutation arms sit inside
  `finishWrite` as delete-section's do — a throw from the destination
  serve outside that wrapper would render as a bare error. Moves
  carry no fresh guard, so no fresh-refusal path exists — but the
  serve-seeds-baselines policy is the seed-site rule's, unchanged.
- **Wording homes are named.** The primitives return the closed verdict
  unions; this repo words them, and every sentence has a home:
  - the §4 refusals (identity/containment, already-at-destination) —
    refusal-envelope wording in the widened move flow (a section-arm
    module beside `writeMove.ts` or a branch within it), exhaustive over
    the primitives' refusal union; the `untargetable` refusal is not on
    that union — it is judged and worded flow-side, composed from the
    per-id path's existing arm, so its wording home is the same flow
    module without riding the primitives' switch;
  - the landed arm's owner report and the landed-divergent /
    unjudged-presence sentences (the currency bullet above) — the same
    flow module, over the landed union;
  - the silent-rollback sentence (a `nothing-moved` arm, on
    delete-section's `nothing-deleted` precedent) — it leads with the
    observation and branches recovery on `sameDoc`, a fact the flow
    already holds, never on a re-read: the rollback residue is
    invisible to every read the tool surface issues (SQL and the doc
    walk hold the pre-move truth; only by-ID resolution sees the
    wrong-root rows — spike I), so a distinguishing re-read cannot be
    made, and a wording-path kernel call would re-fetch state the
    verdict already judged. Same-doc: nothing applied — the batch
    rolled back whole; retry once from fresh walks (ids stay
    resolvable; the mild case self-converges). Cross-doc: a committed
    write to the **source** doc first, then re-issue once — the heal is
    safe advice whether or not residue exists (a clean
    `TxErrCodeBlockNotFound` rollback leaves no damage, so the
    heal-first step is merely unnecessary there, never wrong); no
    execution path is claimed beyond that (delete-section's posture) —
    plus move's own residue/heal recovery wording, and the refusal note
    move's own transport failure carries (`mutationFailureEnvelope`'s
    `refusalNote` — a refused batch is not proven unapplied) — the same
    flow module, never delete-section's repair sentence (the residue
    bullet below);
  - the tool description's widened-capability statement — a
    heading `blockId` on `mode: move` moves the heading's whole
    section (memberless or not — a memberless heading moves as its
    single block, same route and landing), landing at the
    destination section's end — followed by the container-local landing
    statement (a destination section inside a quote, callout, or list
    re-nests the moved members into that container — the section rule's
    locality, spike M1), leading with the shallower refusal (a move
    whose heading is strictly shallower than the destination section's
    boundary is refused — it would swallow the destination's boundary
    heading and the sections after it), the heavy-operation
    statement (a large section move delays every other write for the
    batch's window), and the same-KB scope statement (a cross-notebook
    `toDocId` reads as `noSuchDoc` — the per-id path's existing
    wording, now stated in the description) — the `kb_write` tool
    description (`write.ts`);
  - shared fragments stay in `writeVerdicts.ts`; a new one lands there
    only when a second consumer exists.
- **Pins and suite placement — the single pin table.** The landed
  predicate, the owner projection, and the §4 refusals are pure
  walk-over-walk projections: their unit corpus over synthetic
  `WalkedTree`s lands before the primitive is wired to the kernel, so
  the live cases confirm the corpus rather than define the semantics;
  without it the mode's silent failure mode is "accepted a wrong
  landing". The live pins join `move.live.test.ts` — no new live file and no
  `INTEGRATION_ORDER` change; a backstop fact the code does not branch on pins one
  case each, its multiplicity living as transcript evidence in the fact
  list, never as pins — and the fact lists carry the docstring/live
  split explicitly: a fact a module docstring records without a live
  pin is named as docstring-only there, so an upgrade pass does not
  re-derive which facts the suites falsify. §3 records what the spike executed; this table
  is the only pin plan.

| Case ids | What it falsifies | Home |
|---|---|---|
| §4 refusals — `own-closure`, `shallower-than-boundary`, both `already-at-destination` derivations | the refusal derivations, including the L0 closure-over-siblings reading | unit corpus |
| `untargetable` (flow-side, not a primitive arm) | the widened arm composes the per-id path's existing `resolveHeadingTarget` judgment — no new pin; the composition rides the flow's existing move-path tests | none (already pinned) |
| Predicate arms — exact member equality, span, tail, `nothing-moved`, truncation ordering | the landed judgment over synthetic walks: sibling landing, deeper landing, drag-at-front, chain-tail append, doc-end (omitted `toHeadingId`), truncated walks | unit corpus |
| Owner projection — M1's quote case, the deeper landing, the enclosing-container case | the closure-containment formulation — `sectionOf`'s own product, container-local by construction | unit corpus |
| B/B2/F5 | the folded-source drag and its redirect interaction, across every fold combination of the source heading and its nested subsection headings | primitives live |
| D1a–c | the trim chain's landing across folds — no LIFO rule, no shared-anchor hazard | primitives live |
| D1d–e | the empty-destination degenerates under both anchor folds | primitives live |
| D1f–g | the memberless forms on both arms — under the row-type dispatch these are every memberless heading's route, not a dead branch | primitives live |
| D1h–j | the concurrent-append swallow matrix — the tail clause's falsifier (the anchor's fold decides swallow vs redirect) | primitives live |
| CT1–CT4 | container anchors — quote/list chain anchors land the run as siblings | primitives live |
| CT5–CT10 | the container shapes: the container-nested doc-end chain re-nests the run (both arms), the empty-section fixed point anchors on the destination heading inside its container fold-independently, and callout (`callout`/`NOTE`) and superblock (`s`) chain anchors land the run as siblings after the container with no per-container divergence on the sibling insert | primitives live |
| M1/M3 | the destination-container re-nest and the crossed-container heading leg, across container types | primitives live |
| N1/N1h/N2/N2h | the chain anchor on an empty-section tail heading — `deriveMoveAnchor`'s recursion fixed point lands end-of-section, fold-independent (the redirect's `0 < l` guard); N1x is the mis-landing record: the retired "last non-heading member" rule swallows the tail heading | primitives live |
| container-nested doc-end chain; container-tail chain form (spike case CT) | the chain anchor inside a nested container / on a non-heading container (spike CT's doc-end section was doc-level) | primitives live |
| cross-doc residue round trip | wrong-root rows resolve not-found; the destination write heals nothing; the source write restores; heal-then-retry lands whole | primitives live |
| L1–L3 | the containment-rollback backstop — the §4 closure refusal's ground | primitives live, one case |
| M2 | the source-tree-anchor rollback backstop — the cross-doc note's ground | primitives live, one case |
| ≥32-op batch | a move-only batch takes the per-op path at any arity and lands whole (the latency datum — 36 ops / 341 ms — lives in the module docstring, never a wall-clock assertion) | primitives live |
| Widened-capability wording | the tool description states what a heading `blockId` now does | `__tests__/unit/writeSchema.test.ts`, `writePins.live` |

The widened arm rides `move`'s existing pins; the integration
project's `INTEGRATION_ORDER` is unchanged — the new cases above join
`move.live.test.ts`. The spike's standalone containment probe files are
transcript evidence; the live-suite pins replace them when they land.
The upgrade checklist's re-run-the-suites pass then falsifies these
facts in place, not against a transcript.

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
  keeps the cross-doc arm conservative: **do not re-issue; heal first,
  then retry** — a re-issued move batch over residue trips its own skip
  arms and rolls back again, looping until an out-of-band committed
  write to the source doc restores resolvability. The same-doc arm's
  recovery is the plain retry-once the silent-rollback wording gives
  (ids stay resolvable, so no heal precedes it). The recovery wording is move's own, not
  delete-section's: the delete-section repair sentence (committed write,
  then one re-issue) re-issued here would re-trip the skip arms and
  strand the agent healing the wrong doc. The kernel records undo data
  for these ops (`storeHeadingMoveBlockIDs`); the dead-`undoState`
  posture the no-channel bullet records covers it. The probe legs are
  in §3, precondition 2.
