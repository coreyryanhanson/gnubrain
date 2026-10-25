# Fix plan — delete receipts under-report what they removed (audit finding 2)

Plan for the root-cause fix of audit finding 2 (delete receipts
under-report what they removed), as validated by a reviewer pass. This
replaces the original fix sketch: the direction was right (carry the
evidence on the verdict, never re-derive flow-side), the shape was wrong
in three ways, detailed below.

## The defect, restated

`deletedBlocksTail`'s contract (`writeEcho.ts`) is "the closure is exactly
what left the doc", and `README.md` promises delete-bearing writes come back
with the id and content of each removed block. Two arms break it:

- **Container block delete** (`writeDelete.ts`): the ok arm hardcodes the
  receipt to `[{ id: blockId, content: outcome.content }]` — the target
  only. A non-heading delete cascades to its descendants, and the primitive
  *already derives exactly that set* for the fresh-content guard
  (`cascadeDescendantsOf` over the stake walk, target first, then
  descendants in document order) — then discards it. A list item with three
  nested children reports one block while four left the doc.
- **Doc delete past the walk bound** (`writeDelete.ts`): the receipt
  itemizes `outcome.preWalk.blocks` with no marker; `walkBlockTree` stops at
  `MAX_WALK_DEPTH = 32`, so a deeply nested doc gets a silently partial
  list, and the same truncated id set feeds the orphan-ref count.

Section delete and replace-section already itemize their full closure from
verdict-carried rows — the block and doc arms are the odd ones out.

## Why the original fix sketch needed rework

1. **Row shape.** It proposed `judgedBlocks: WalkedBlock[]`, but the sibling
   verdicts carry `{ blockId, content }` rows (`JudgedSectionBlock` in
   `sectionDeleteCore.ts`) and both consumers map those into
   `deletedBlocksTail` unchanged. The block arm would be the one odd-shaped
   receipt, with a different mapping and fields the receipt never uses.
2. **Walk-absent target regression.** `cascadeDescendantsOf` derives nothing
   for a target absent from the walk — and a walk-absent target can reach
   the `judged` arm (the `absent` membership arm proceeds by design; the
   kernel answers it synchronously, and the delete can race the walk).
   Today's receipt still reports the target via `outcome.content` (the
   membership read). A receipt built only from the cascade set would emit an
   empty list for a delete that landed — a silent wrongness worse than the
   under-report being fixed.
3. **The doc-arm field.** `deletedBlocksIncomplete: true` breaks the pinned
   exact-key shape in `writeDelete.test.ts` ("doc-level: … pinned shape")
   and, being un-expiring state, just sits there. The message sentence
   alone is the complete fix.

Also unstated in the original: this is a two-repo change and the primitives
release must publish first (`scripts/release.mjs` refuses `file:` specs; a
primitives release takes precedence over any gnubrain release built on it).

## Root cause

Discarded evidence at the verdict seam. The primitive holds the full judged
closure at judgment time and throws it away; the flow then reconstructs a
degraded version of it by hand. The fix restores the "verdicts carry their
evidence" invariant — the tool layer only words the verdict, never
re-derives kernel facts. The rejected alternatives make this plain:
`cascadeDescendantsOf` is off the read barrel on the internal allow-list
precisely so the tool layer cannot re-encode cascade and fold-blindness
facts, and a barrel export would leak an internal for one receipt.

## Step 1 — Carry the judged closure on the verdict (`siyuan-kernel-primitives/delete.ts`)

- Add a row type beside `DeleteBlockOutcome`:

  ```ts
  /** A judged delete row: the target first, then the cascade
   * descendants in judged order. The target's content rides the
   * membership read (nullable — a non-`in-doc` kind that still
   * proceeds), the descendants' from the stake walk (never null) —
   * hence the wider `string | null` than `JudgedSectionBlock`. */
  export type JudgedDeleteBlock = { blockId: string; content: string | null };
  ```

- Add `judgedBlocks: JudgedDeleteBlock[]` to the `judged` arm of
  `DeleteBlockOutcome`, built at the return site: the target row from the
  membership read (`{ blockId: input.blockId, content: <same expression the
  existing `content` field uses> }`), then
  `cascadeDescendantsOf(judgedWalk, input.blockId).map((b) => ({ blockId:
  b.id, content: b.content }))`. Target first, judged order — the same
  order the fresh guard judged over, so the receipt is the judged snapshot,
  not a re-derivation.
- Keep the existing `content: string | null` field on the `judged` arm
  unchanged — the smaller diff; the flow keeps reading it today and it can
  retire in a later release once no consumer needs it.
- Update the `deleteBlockVerified` docstring's judged-arm entry: the judged
  arm now carries the full judged closure (target first, then the cascade
  descendants), derived inside — same rationale as the existing
  "enumerating them flow-side would re-encode the cascade" sentence.

The type rides the existing `siyuan-kernel-primitives/write` entry's exports
— no new export, no barrel change.

## Step 2 — Itemize the verdict's closure (`gnubrain/writeDelete.ts`)

- **Block arm:** replace the hardcoded single-row array with a map over
  `outcome.judgedBlocks`:

  ```ts
  ...deletedBlocksTail(
      input.sessionId,
      outcome.judgedBlocks.map((b) => ({ id: b.blockId, content: b.content })),
  ),
  ```

  Identical to how `writeDeleteSection.ts` and `writeReplaceSection.ts`
  feed their verdict rows in. The existing `outcome.content` usages (the
  message / echo seams that still want it) stay until they no longer do.
- **Doc arm:** when `outcome.preWalk.incomplete`, append one sentence to the
  ok message — e.g. "the pre-delete walk hit the document's depth bound, so
  this block list is the seen prefix". Message-only: no new envelope field
  (the pinned key-shape test stays untouched). Key on `incomplete`, not the
  generic truncation flag — on the doc path the walk runs without
  `tolerateVanished`, so there the two coincide anyway.
- The exhaustive switches over `DeleteBlockOutcome` need no new arms (the
  field extends an existing arm); typecheck will confirm.

## Step 3 — Tests

- `__tests__/unit/writeDelete.test.ts`:
  1. **Container ok case** (the gap: no test deletes a container with
     children today): `cascadeDelete: true` with `childrenFor` wiring
     `c1` → `p1`; assert `deletedBlocks` equals
     `[{ blockId: "c1", … }, { blockId: "p1", … }]` **and** keep the
     existing walk-count pin — the receipt must stay free of a third walk.
  2. **Truncated doc case:** the existing `nestChain(childrenFor,
     "d-doc", 33)` helper; assert the message names the depth bound.
- Down-repo (`siyuan-kernel-primitives`): a falsification case that the
  judged arm's `judgedBlocks` is target-first, document-order, and total
  (present even when the target row's content is null from a non-`in-doc`
  membership kind that proceeded).

## Order & release

1. Primitives first: step 1 + its test, then its own suite
   (`npx vitest run --project unit 2>&1 | tee /tmp/finding2-prim-$$.log |
   tail -15` in `/root/kb/siyuan-kernel-primitives`).
2. Release the primitives (publish bottom-up — this repo's release script
   refuses a `file:` spec while the dependency isn't on the registry).
3. Then gnubrain: steps 2–3, test-first for the two new cases, then
   `npm run typecheck && npm run lint && npm run fmt:check && npx vitest
   run --project unit 2>&1 | tee /tmp/finding2-test-$$.log | tail -15`.

## Size & residual risk

~15–20 lines of production code total (roughly half down-repo); the bulk of
the work is the tests and the release ordering, not the diff. Residual
limits, both acceptable and worth naming: the receipt's descendants' content
is the stake walk's observation (pre-delete), which is the best available —
the blocks are gone after the mutation; and the doc arm's truncated list
stays a seen prefix, but now says so. No live-kernel run needed — the
cascade rule is the primitives' pinned territory and this fix only carries
its already-derived output.
