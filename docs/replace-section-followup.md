# Replace-section — batched-route follow-up

Status: **Deferred — optional follow-up, not scheduled.** The per-op sweep
(`sweepSectionMembers`) keeps its consumer and the partial-apply plumbing
stays alive until this lands or is explicitly rejected.

Origin: the `/api/transactions` migration plan (removed after its landed
content joined the repos' AGENTS.md fact lists); its unsettled items live
here. The batched foundation it builds on is landed: layer 1's `transact` +
the primitives' `batch.ts` (`transactThenWalk`), first consumed by the
batched `delete-section` — the kernel facts (batch rollback and its
`blocktrees` residue, ack-time commit-wait, the ≥32-op cliff, queue ordering)
live in the primitives' AGENTS.md fact list.

## 1. What the follow-up is

Re-compose `replaceSectionVerified`'s sweep leg on the batched foundation,
keeping leg 1 unchanged — the insert stays on the single-op endpoint
(`insertVerified` plus its verification) — and preserving the
`insert-unlanded` interleg refusal verbatim: the prevention the
re-composition exists to keep (§2).

## 2. Why the two legs stay two transactions (structural, unchanged)

The `insert-unlanded` interleg refusal is a *prevention*, not a tax. The
kernel's inserts can ack success and silently not land (`absent-from-tree`);
one transaction carrying both legs has no point between the insert and the
deletes at which anything can be judged or refused: the deletes would commit
with a ghost insert and the post-write judgment would only detect the outcome
(`cascade-consumed`), no longer prevent it. Detection is not prevention.

## 3. The gate: corrected leg-2 set-derivation specification

The replacement inserts at section end, inside the old section's member range
(`placement.ts`, the section-end insert rule), so a post-insert
re-enumeration sweeps the replacement into the delete set. The pre-insert
member ids (as enumerated in `replace.ts` before leg 1) must remain the
delete set, with the post-insert walk as judgment evidence only. Until that
shape is specified and reviewed, this follow-up carries no replace-section
work.

## 4. Acceptance criterion (when it lands)

Measured by the same criterion as delete-section's batched landing, on its
sweep leg, with the `insert-unlanded` interleg arm outside it: that arm must
survive unchanged, not shrink.

## 5. The pending-set plumbing deletion rides this follow-up

Once no consumer remains (when this lands or is rejected), delete the
pending-set half of the partial-apply plumbing: every `remainingBlockIds`
pending-set receipt, the `partial`/`interrupted` pending arms'
not-yet-attempted-id sentences, and the sweep `members-survived` sentence
(which goes with the per-op sweep itself) — from `envelope.ts`/`writeVerdicts.ts`
and both repos' AGENTS.md fact lists.

The applied-but-unverified transport is **not** in this list and must not join
it: `PartialApplyState`, `markPartialApply`, and `takePartialApply` are not
pending-set machinery — they carry a write's "mutated, verification never
ran" state into the gate's `withPartialState` catch frame and `finishWrite`
(`writeEcho.ts`/`gate.ts`/`writeResult.ts` in gnubrain), which serve every
write mode and the verification-failure classes batching does not remove. The
transport and the render half are one pipeline, and the delete/keep line must
not be drawn between them: `partialApplyMarker`'s parameter is
`{remainingBlockIds}` and `PARTIAL_APPLY_GUIDANCE` names the field
(`envelope.ts`), so the correct split keeps the type/mark/take pair and the
marker/guidance pair, deletes the `remainingBlockIds` payload, and simplifies
what the deletion strands — `partialApplyMarker` becomes a field-less
`appliedUnverified` marker (a batched write has no pending ids to count) and
the guidance re-points at the outline re-fetch without naming a field that no
longer exists. The `unconfirmedBlockIds` payload stays: the truncated-walk arm
still needs its present/unconfirmed split. Renaming once "partial apply" no
longer names a reachable state is welcome; deleting the transport is not.
