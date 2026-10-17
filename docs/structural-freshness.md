# Structural freshness — design (deferred, deliberate)

Status: **deferred, not decided.** This doc records the option of making
the fresh-content precondition compile-time instead of disciplinary —
what it would look like, what it costs, and what would justify paying
that. Do not start here.

## 1. The gap it closes

Today the fresh-content precondition is **consumer discipline**: the
write barrel is a deliberate import, and each gnubrain flow is trusted to
run `freshContentRefusal` before the mutation. Nothing stops a future flow
from calling `deleteSectionVerified` / `editVerified` / `insertVerified`
without it — the write would land against state the session never saw
(anti-laundering violation) or clobber a concurrent edit, behind a clean
`judged` receipt.

The repo has already made exactly this class of precondition structural
once: the **drift probe**. Every write primitive takes a required
`KernelProbeResult` and refuses `drift` before any kernel call — "no one
can run the write path without a client that can both probe and mutate."
Forgetting the probe is a compile error; forgetting the fresh check is
not. This doc asks whether freshness deserves the same treatment.

Why it is not structural today (the honest reasons, both still true):

1. **The baseline is consumer-held session state.** The judgment asks
   "does the content *now* hash to what this session last served" — the
   primitives are stateless, and `ContentBaselines` lives in gnubrain.
2. **The policy over the outcome arms is flow-specific, not a kernel
   fact.** `vanished` = skip in block-delete ("already gone, safe to
   proceed") but arguably refuse in delete-section ("moved away,
   proceeding destroys"); `stale` → re-baseline-and-retry-with-consent is
   an agent-interaction policy. The judgment is already upstream
   (`checkFreshContent`); only the policy is downstream, and it must be.

A cert design can respect both reasons: it threads **evidence**, not
state or policy.

## 2. The shape

`checkFreshContent` already returns everything a cert needs. Add a
projection beside it:

```ts
// fresh.ts (or a sibling): the judged outcome as a portable certificate.
// Carries evidence only — the consumer keeps its baselines and its policy.
export interface FreshCert {
	/** The strict walk the judgment ran — current by construction. Absent
	 * only on the empty-target short-circuit (`checkFreshContent` returns
	 * `{ arms: [] }` with no walk — nothing was judged, no doc view to
	 * hand back), which is also the create-doc exemption's shape. */
	walk?: WalkedTree;
	/** Every target judged, in input order (the arms as returned); the
	 * ids the cert speaks for are the arms' blockIds — no separate list. */
	arms: FreshOutcome[];
}
```

Mutating primitives require it:

```ts
deleteSectionVerified(client, probe, {
	rootId, walk, headingId,
	/** The freshness certificate the consumer's precondition produced. */
	fresh: FreshCert,
})
```

and fail closed when the cert does not cover the flow's targets (for
delete-section: the delete set derived from the same walk — a mismatch is
a caller/derivation error, the `heading-absent` tripwire class; coverage
is checked against the arms' blockIds). The primitive never interprets
the arms; the consumer already applied its policy before producing the
cert. Aged-cert risk (the cert is minutes old) is the same risk as
today's discipline, made visible instead of silent — the cert carries
its walk when it ran, so a freshness re-check can compare.

## 3. Costs

- **Every flow threads the cert.** Today the precondition runs in edit,
  replace-section, block-delete, and delete-section; the append flow
  (the insert primitive's only consumer) runs **no fresh check at all**
  — itself a live instance of the gap §1 describes, and a cert
  requirement would force an explicit decision there (thread the cert,
  or document the exemption — an insert adds blocks and destroys
  nothing, so the anti-laundering stake is weaker). `createDocVerified`
  needs the empty-cert exemption (a fresh doc has nothing to be stale
  against — the empty-target short-circuit's shape, see §2).
- **Union/seam growth:** the cert-coverage failure needs a home — a new
  refusal arm or a typed input error (house precedent: the write-feeding
  projections refuse `walk-truncated` before any kernel call). The
  testing seam grows correspondingly (`withVerifyWindow` already exists;
  stubs must now mint certs).
- **Cross-repo lockstep:** the signature change lands in
  `siyuan-kb-primitives` and ripples into every gnubrain flow in one
  commit. Fine pre-release/squash (churn is free); this is exactly the
  moment for it if it is ever happening.
- **No perf gain and no perf loss** by itself; pair it with
  [`fresh-walk-dedupe.md`](fresh-walk-dedupe.md) — a cert that carries
  its walk subsumes the dedupe (the cert's walk IS the shared walk), so
  if both are ever wanted, land them as one design.

## 4. When to do it

The trigger is not a bug — it is a *growth* prediction: the moment a
second consumer (or a third flow shape) starts composing write
primitives, "remember the fresh check" stops being reviewable by
familiarity. Until then the one-wrapper discipline in gnubrain
(`writeFresh.ts` as the single policy home, every flow calling it) holds
at near-zero cost. If the sign-off discussion on delete-section's
move-out race ever hardens into "members must never proceed on
`vanished`," that flow-specific policy change is the natural moment to
revisit this doc — a cert with the arms attached gives the primitive's
consumer a typed surface to make such rules against.
