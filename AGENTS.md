# GNUbrain

Pi extension (`gnubrain`) that exposes a SiYuan kernel as a knowledge base:
four tools (`kb_read`, `kb_search`, `kb_query`, `kb_write`) plus the `/kb`
command. Published to npm as a `pi-package`.

This is the **tools layer** of a three-layer stack (bottom to top):
`siyuan-kernel-api` (typed thin HTTP client) → `siyuan-kb-primitives`
(version-pinned kernel primitives over that client) → **gnubrain** (the four
kb tools, `/kb`, write flows, spill). Kernel-coupled logic — the block-tree
walk, by-ID reads, the title-guard reads, the guarded-create core, the verify
loops, the pin and probe — lives in `siyuan-kb-primitives`, not here.

## Commands

```sh
npm ci                 # Node 22 in CI; repo runs on v24 here
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint --deny-warnings
npm run fmt            # oxfmt (format in place)
npm run fmt:check
npm test               # vitest run — unit + integration (integration self-skips)

# focused unit runs (integration project needs a live kernel, see below)
npx vitest run --project unit __tests__/unit/gate.test.ts
npx vitest run --project unit -t "some test name"
```

Live integration (opt-in, never in CI):

```sh
SIYUAN_INTEGRATION=1 SIYUAN_API_TOKEN=<token> SIYUAN_BASE_URL=<origin> \
  npx vitest run --project integration
# SIYUAN_BASE_URL is required — the harness bakes in no default
```

## Hard constraints

- **No build step.** `package.json` is `"type": "module"` and `pi.extensions`
  points straight at `./index.ts`; pi runs the TypeScript directly. `tsc` is
  `--noEmit` only. Do not add a bundler, `dist/`, or a compile step.
- **NodeNext ESM: import local modules with a `.js` extension even though the
  files are `.ts`** — `import { guardCall } from "./gate.js"`, and in tests
  `"../../tools.js"`. Getting this wrong is the most common breakage.
- **Flat layout.** Every module lives at the repo root (no `src/`); npm
  publishes `*.ts` at the root. Put new modules at the root and keep them flat.
- TypeScript is strict plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- **Formatting is not cosmetic here:** oxfmt uses tabs and 80 columns; oxlint
  must pass with zero warnings. Husky pre-commit runs lint-staged →
  `oxfmt` + `oxlint --fix --deny-warnings` on staged `*.ts`.
- **Layering: import the primitives only through their entry points.** The
  read barrel (`siyuan-kb-primitives`) carries all read primitives, the pin,
  the probe, and the layer-1 identity surface; the write entry
  (`siyuan-kb-primitives/write`) is the only path to the write verdicts —
  the guarded-create core, the verified edit, the verified insert (append
  and replace-section's insert leg), the verified block/doc moves, and the
  verified deletes, and replace-section's internal delete sweep
  (mutation + landing judgment as one primitive call, returning a closed
  union with the evidence the verdict was rendered from). Every write
  mode's mutation is issued there, and the fresh-content precondition rides
  inside it too (served-baseline verdicts in, `fresh-refused` out); the
  flows keep only target resolution, judgment-input minting, and envelope
  wording.
  No source file in this repo
  names `siyuan-kernel-api` — take the client constructor, error classes,
  and kernel types from the read barrel (one requirer = one layer-1 copy in
  every install, which keeps `instanceof` identity alive); error
  classification rides the read barrel's `causeOf` too — the gate and the
  write-result wrapper switch exhaustively on its `KernelCause` union
  instead of re-encoding the layer-1 class list (the remaining inline
  class checks are deliberate policy sites, not the list). A test-only
  third entry (`siyuan-kb-primitives/testing`) is allowed under
  `__tests__/` only — statement-shape helpers for the suites, pinned by
  `layerBoundary.test.ts`.

## Design invariants

- **Kernel API only.** All reads/writes go through the kernel HTTP API — never
  write `.sy` files (the agent's microVM can't see host files anyway, and this
  avoids torn-write hazards).
- **Zero model calls.** The extension makes no model/provider calls. The agent
  is the intelligence; SiYuan is the memory.
- **Never silently wrong.** Kernel results that can lie (silently-rolled-back
  inserts, silent no-op DML, hpath-as-address) are verified against the live
  block tree / by-ID asserts, never trusted from the HTTP result. New write
  modes must verify post-write with `getChildBlocks` walk evidence — the
  verify loops themselves live in `siyuan-kb-primitives/write` and refuse on
  version-coupled grounds (drift, silent rollback); a new write mode composes
  them instead of re-encoding them.
- **Verdicts carry their evidence.** Write primitives return every post-write
  fact the tool layer's session policy depends on (walks, ids, hpaths) as
  verdict detail — gnubrain never re-fetches state a verdict already
  observed, so baselines and echoes are seeded from the exact snapshot the
  judgment certified. The edit's landed arm names its evidence's provenance
  (`baseline`): an `unobserved` verdict (no pre-write pair — the index could
  not see the block pre-write) seeds no baseline, so the block reads as
  `unseen` on the next fresh-check instead of trusting a possibly-stale row.
- **Soft scope, tool-surface-only guards.** The API token is a workspace-admin
  credential; the threat model is model accident, not a hostile agent. All
  guards (parser certification, scoping, write grant) are tool-surface-only.
  Hard isolation = separate SiYuan instances, if ever needed.
- **Upgrade checklist.** On any SiYuan upgrade: re-run the live suites against
  the new kernel *before* re-pinning — the pin lives in
  `siyuan-kb-primitives` (`version.ts`), its repo falsifies the version-pinned
  behaviors, and this repo exercises them transitively. A primitives release
  (new pin, changed statements) takes precedence over any gnubrain release
  built on it. On this repo's side, re-read the tool-side kernel-fact list
  under "Version coupling" below — one grep-able list, not a re-derivation.
  Same re-verify discipline for `node-sql-parser` and `pi-tool-masking` (both
  exact-pinned; re-run their certification/toolset cases).
- **Deployment posture** (not re-derivable from this repo): non-empty SiYuan
  access auth code — never `ACCESS_AUTH_CODE_BYPASS=true`; kernel port bound
  to the VM-facing interface only; one kernel per workspace (dual writers =
  torn writes).

## Architecture

`index.ts` is the entry (`register(pi, deps)`): session lifecycle, `/kb`
command, status slot, and both toolsets. The command's library-facing half
— toolset intent resolution, the state lines, and the toggle actuation —
lives in `toolsets.ts`, so a `pi-tool-masking` upgrade touches one place.
`deps` is the injectable test seam
(`readFile`, `createClient`) — unit tests drive the extension through it
instead of touching real files; the integration suite registers toolsets
directly and seeds settings in memory through `loadGnubrainSettings` (or a
temp HOME for the headless child).

- **Every kb tool call routes through `gate.ts`.** Reads use `runKbCall`;
  writes run the per-KB grant gate (after `guardCall`, before
  `gateWriteAttempt`), then `gateWriteAttempt`, then a flow. The gate
  order is pinned (shape → breaker → 429 cooldown → `kb` param → mode/body
  shape → KB resolution → mint title → cached-verdict drift refusal →
  grant) and refuses locally with zero kernel calls before the op runs.
  One deliberate exception: `kb_read`'s `kb: "kbs"` discovery form runs
  after the shape check but ahead of the breaker/cooldown/`kb`-param legs
  with zero kernel calls (it must run while the breaker is tripped). Never
  call the kernel client outside this path.
- **Kernel contact is structural, not signaled.** `runKbCall` wraps the
  op's client in a tracked proxy (`trackKernel`) and only the op receives
  it: any method invocation marks contact, and contact alone drives
  `breaker.recordSuccess()`. Two load-bearing assumptions — every public
  client method is an authenticated route (the version endpoint's
  tokenlessness is live-pinned by the primitives' `version.live`;
  `siyuan-kernel-api`'s `census.test.ts` pins the public surface and
  per-method token attachment — a new public method must join the
  pinned surface list, with its route's auth posture verified, before
  it can ship — the probe runs on
  the raw client the gate hands the op
  alongside the tracked one, so the trap never sees it and carries no
  exemption), and an op reaches the
  kernel only through the clients the gate passed it — so a flow that
  captured or rebuilt a client would silently stop resetting the
  breaker, and a real call through the raw probe handle would silently
  skip marking (the probe parameter is declared as the narrow
  `KernelProbeClient`, so such a call fails typecheck). A
  probe-only refusal (drift, 429, unreachable retry) therefore never
  resets the
  consecutive-auth-failure count. The one exception to contact-drives-
  reset: a verification-phase auth/lock verdict (`authEvent` marker on the
  envelope — the primitives classify verification-phase 401/429 into
  `verification-failed` because the mutation already acked) is counted
  instead, and reset-on-success is skipped for that op — the kernel's
  per-IP FailCount advanced behind the transport success.
- **Toolsets** via `pi-tool-masking`: `gnubrain.read` (registered in
  `tools.ts`, three read tools) and `gnubrain.write` (`write.ts`, one
  `kb_write`). Write `requires` read — enabling writes cascades reads on.
  `/kb tools read|write|off` toggles them live.
- **Write flows** (`writePrepare.ts` carries the ordered kernel-free entry
  ladder and dispatches edit / append / replace-section / delete /
  delete-section / move; create is `writeCreate.ts`; `write.ts` is the tool
  surface + registration) are tool-schema orchestration
  laced with session state: baselines seeding, spill receipts, move outlines,
  envelope wording. The kernel-coupled cores they compose —
  `findTitleMatches`, `createDocVerified`, `editVerified`, `insertVerified`,
  `replaceSectionVerified` (the replace-section sequence: enumeration,
  anchor, insert-before-sweep ordering — the tool layer never sequences
  kernel mutations), `blockInDoc`, `rootEcho`, `ownership`,
  `resolveHeadingTarget`
  (the heading-target judgment; `headingInWalk` here maps its arms to
  wording), the verified block/doc moves (`moveBlockVerified` /
  `moveDocVerified`), the verified deletes (`deleteBlockVerified` /
  `deleteDocVerified`), `deleteSectionVerified` (the delete-section
  sequence: enumeration → members-first heading-last sweep → absence
  judgment, composed on the sweep core — the tool layer never sequences
  kernel mutations), `orphanedMembersOf` (the heading-delete report's
  walk projection), `partitionByAbsence` (the members-survived acked-set
  split — both ride the read barrel), and the placement module (the
  section rule and the anchors derived from it)
  — live in `siyuan-kb-primitives` and return closed `{ kind, …detail }`
  unions whose shapes and evidence the primitives' AGENTS.md documents
  (the fresh-content refusal wording lives in `writeFresh.ts` —
  `applyFreshArms` + `freshRefusalEnvelope`); the wording over those
  unions is exhaustive switches
  (no default) with `satisfies never`, so a new kind in a primitives
  release fails typecheck until its sentence is written, wherever that
  sentence lives. Shared fragments live in `writeVerdicts.ts` — transport/verification/drift
  sentences, the anchor echoes (`appendAnchorEcho` / `moveAnchorEcho`),
  the `blockInDocRefusalKind` sentence, the sweep `members-survived` sentence
  and its split-derived payload fields (one home for both sweep
  consumers — replace-section and delete-section), and the one frame
  shared across flows, the
  pre-judgment failure ladder (`mutationFailureEnvelope`, the one async
  piece: it awaits the flow-supplied echo tail, `writeEcho.mutationFailure`).
  Each mode's own verdict sentences co-locate with that mode's flow, which
  composes its envelope frames from both halves.
  Schema/shape in `writeSchema.ts`, grant gate in `writeConfirm.ts`, mint
  policy in `writeGuard.ts` (`validateMintTitle` — wording only; the
  mint-title kernel facts live in the primitives' `mintTitleProblem`).
- **Session state** stays here: `baselines.ts` (what this chat was shown),
  `breaker.ts` (thin session holder over the barrel's `authLockDodge` —
  session scoping, the 429-accounting seam (every 429 funnels through
  `recordRateLimitFromVerdict` — the classification of thrown errors and
  verification-phase verdicts lives with `causeOf` and the primitives),
  and wording state; the dodge schedule itself lives in the primitives),
  grant state, spill receipts. These are session-lifetime
  policy, not kernel facts.
- **SQL handling is pure and testable** in `sqlScope.ts` (node-sql-parser):
  only single-table `SELECT` from `blocks`/`refs`; scope is spliced into the
  AST and re-parsed for verification. It stays here because model-authored SQL
  is a tool-surface problem — the primitives' own statements are hand-built
  with fixed heads, no parser.
- **Result shaping** stays here: `spill.ts` owns inline-vs-spill
  (`withRowPayload`, `PREVIEW_CHARS`, `OUTLINE_HEADINGS`); the shared
  query-window dial (`RESULT_LIMIT`) lives in `limits.ts`;
  `outline.ts` owns outline serving (`serveOutline`/`serveOutlineFromWalk` —
  the required-baselines wrappers: seeding, the inline cut, the spill tail).
  The notation itself (`renderExtendedOutlineLines`, the primitives read
  barrel's canonical extended-outline renderer — its `containerPrefix`
  helper is module-private in the primitives' `outline.ts`) means the
  served lines can never diverge
  from the section rule; the tool descriptions document the notation the
  agent sees.
- Every tool result is an envelope `{status: ok | near_matches | duplicate |
  error | refused, message, ...}` (`envelope.ts`) — use its factory helpers,
  don't invent statuses. Large payloads spill to session temp files.

## Version coupling

The SiYuan version pin (`PINNED_SIYUAN_VERSION`, `"3.8.7"`), the drift probe
(`probeKernel` → `KernelProbeResult`), and the pinned lock schedule
(`authLockSeconds`) live in `siyuan-kb-primitives`' `version.ts`. This repo
consumes them through the read barrel: writes fail closed on a `drift` verdict
— the gate refuses before the op runs, and the probe-taking primitives refuse
again inside (defence-in-depth; the sweep alone takes no probe — it runs
mid-sequence after the gate's refusal), reads warn, and the breaker's cooldown
rides the barrel's `authLockDodge`. Change the pin only deliberately, in the
primitives repo — its live suite asserts the kernel reports the pin
exactly, and the upgrade checklist above gates the bump.

**Tool-side kernel-fact list** — one line per fact: the kernel behavior → its
home (primitives module:symbol) → what this repo keeps (wording/precondition
only) → falsifier. Every fact is falsified in the primitives repo's unit +
live suites; this repo's suites exercise them transitively and never
sole-falsify a pinned fact, so an entry names a local test only where this
repo pins something of its own — tool-surface wording, or a live case riding
the tool path. The three `sqlScope.ts` entries are the standing exception
named in the rule below: their guard is tool-surface by design, so this repo
falsifies them itself. An upgrade pass re-runs the primitives' suites
wholesale, then re-reads this list and re-falsifies the changed facts in the
primitives.

- **Fresh-content judgment** — the precondition rides the live tree, never
  the SQL index (`blocks.content` converges asynchronously), and walk-form ≡
  SQL-form baselines hash identically (the kernel builds both via
  `nodeStaticContent`) → the judgment is structural: the four
  destroy-shaped write primitives (`editVerified`, `deleteBlockVerified`,
  `replaceSectionVerified`, `deleteSectionVerified`) run it internally,
  immediately before mutating, taking the session's served-baseline
  verdicts (`ServedBaseline` — `served` with the stored hash, or
  `never-served`) as a required input. The three set-derived guards
  (`deleteBlockVerified`, `replaceSectionVerified`,
  `deleteSectionVerified`) take the session's lookup
  (`baselines.servedBaseline`) and consult it only for the ids their own
  derivation derives, so the judged set never crosses the input surface;
  `editVerified` instead takes the single target's verdict — its judged
  set is the caller-named block id by design. Currency:
  `editVerified`/`deleteBlockVerified` judge on a walk taken
  immediately before mutating; `replaceSectionVerified`/
  `deleteSectionVerified` judge over the enumeration walk their
  sequences already hold — currency "as of the enumeration", so a change
  landing after that walk is caught only via the seed read's
  walk-vs-index divergence (the seed-path `stale` arm). The judgment
  refuses `fresh-refused` — carrying every judged arm plus the judged
  walk, so the flow re-baselines and serves the refusal outline from
  exactly the snapshot the judgment certified (`applyFreshArms` +
  `freshRefusalEnvelope` — one refusal construction per flow, the arm
  policy inside it, `writeFresh.ts`; the stale arm carries its own comparison path
  (`compared`), so the lead keys on the arm — no consumer-side memo). This repo keeps the
  seed-site policy: serve seeds ride the walk everywhere except exactly
  one SQL-form seed site — `kb_query`'s served rows (`tools.ts`, via
  `rememberServedRows`) — and the write echo tail seeds from the walk it
  serves, never overwritten by a later read, SQL-reading only the write's
  own block IDs. Fail-closed on any split: a diverging seed reads as
  `stale`, named, never silently matched. The equivalence claim in
  `rememberServedRows` (`baselines.ts`) is prose-only; the
  executable-dependence site is the one SQL-form seed just named.
- **Child order** — `getChildBlocks` returns document order; the first
  element is the doc's first block → `firstChildContent` (primitives
  `byId.ts`). This repo keeps only the near-match swallow policy
  (`writeCreate.ts`): a vanished candidate mid-scan → empty excerpt, kernel
  errors rethrown for classification.
- **Doc targeting** — a block id passed as `docId` reads as absent
  (type-`'d'` root row), never normalized to its containing doc →
  `rootEcho`. Consumed by `resolveDocTarget` (`writeTarget.ts`, refusal
  `noSuchDocEnvelope`) and exercised by `kb_read`'s doc resolution
  (`runRead`, `tools.ts`, via the primitives' `ownership` read: a block id
  there exports its containing doc); the missing-docId refusal is
  wording-only and names the same fact.
- **Omitted-empty body blocks** — the walk field rides omitempty on
  `getChildBlocks` rows, so a genuinely empty block's bytes vanish from
  the body while its row keeps its place; the count is the policy's
  never-silent half → `docBody`/`readDoc` (`body.ts`, computed beside
  the joiner). This repo keeps only the envelope surfacing
  (`omittedEmpty` on the `kb_read` ok envelope, `runRead`).
- **Insert shape** — one `doOperations` entry per markdown insert, whole
  body in its `data` → `insertVerified` (primitives `write.ts`).
- **`lsNotebooks` encrypted flag** — `encrypted` is always present
  regardless of lock state, and the SQL surface cannot see encrypted boxes,
  so one rejection covers both lock states → `resolveNotebooks` (primitives
  `notebooks.ts`). This repo keeps the rejection wording and the
  warn-and-drop policy (`validation.ts`); tool path pinned locally
  (`encryptedNotebook.live`).
- **Delete scoping** — the kernel mutates by raw block id with no doc
  scoping of its own, so membership is judged per path inside the
  primitives: single block deletes by the shared `blockInDoc` read →
  `deleteBlockVerified` (primitives `delete.ts`); delete-section and
  replace-section by caller-provenance — the delete/replace set derives
  from the enumeration walk, never from caller-supplied ids, and
  `deleteSectionVerified`/`replaceSectionVerified` check the walk's own
  root against the claimed doc (`walk.rootId !== rootId`, zero kernel
  calls — the walk carries its own root, `WalkedTree.rootId`) →
  `deleteSectionVerified` (primitives `deleteSection.ts`) and
  `replaceSectionVerified` (primitives `replace.ts`). This repo words
  the refusal arms through the shared sentence pair
  (`blockInDocRefusalKind`, `writeVerdicts.ts`).
- **Delete generation** — 3.8.3 success no-op vs 3.8.4 "tree not found" →
  `deleteBlockVerified` / `deleteDocVerified` (primitives `delete.ts`). This
  repo keeps the flow-side wording: kernel error verbatim with the fresh
  outline; a still-present verdict is an error, never an ok receipt.
- **Heading-delete scope** — `deleteBlock` on a heading removes only the
  heading; the members survive it and their section ownership moves to the
  preceding heading (the delete path is fold-blind, unlike move) →
  `deleteSectionVerified` (primitives `deleteSection.ts`) as the
  load-bearing consumer — the delete set assumes the heading delete is
  per-block and non-cascading — and `orphanedMembersOf` (primitives
  `placement.ts`) as the report-side consequence. This repo keeps only
  wording and the ok-arm policy: the heading-delete report on a
  heading-scoped `mode: delete` names the members left in place — sound
  presences, complete by construction (the report only runs on the
  judged-gone arm, whose post-walk is never truncated: a truncated one
  refuses as `absence-unconfirmed` first, and the guard's own stake-walk
  truncation refuses before the mutation — the projection's degrade arms
  are exhaustive-switch tail only, unreachable in this flow
  (`writeDelete.ts`);
  falsifiers: the live pin in the
  primitives' `delete.live` for the fold-blind fact, plus the local
  wording pins
  (`writeDelete.test.ts`, `writeDeleteSection.test.ts`, live
  `writePins.live`).
- **Delete-freshness split** (policy, not fact — this repo owns it) — the
  block-delete path rides the same fresh-content precondition as edit and
  replace-section, judged inside `deleteBlockVerified` (the flow supplies
  only the target's verdict; the cascade stake beyond the target derives
  inside the primitive and judges on the seed path — a stale descendant
  refuses a delete that once proceeded; no flow-side membership read — a
  block outside the doc or already absent reads as `vanished` there and
  refuses at the primitive's scoping arms); the delete-section path
  guards the same way, over the WHOLE delete set (closure + heading —
  the replace-section precedent: the cascade makes descendants part of
  what is at stake; the agent's intent is the section's content, and the
  members are enumerated by the walk, never named by the agent), but the
  doc-delete path is deliberately unguarded: the intent is
  container-level destruction a member's content change cannot redirect, the
  receipt itemizes every lost block, and the primitive's walk-then-mutate
  sequence leaves no interposable refusal point without duplicating its walk.
- **Mint policy** — the `normalizeDocTitle` 512-rune truncation bound and
  the `/` path-separator rule → `mintTitleProblem` (primitives `/write`
  entry). This repo keeps the wording (`validateMintTitle`,
  `writeGuard.ts`); the rejection set remains a superset claim over
  `normalizeDocTitle`.
- **Synchronous move rejection** — the kernel rejects ancestor and identity
  moves synchronously (doc-level record, no echo tail; identity member
  live-pinned in `move.live`) → `moveDocVerified` (primitives `move.ts`).
  This repo keeps the doc-level move record shape wording (outline +
  title/hpath echo, no anchor/newBlockId/destOutline) and carries no
  pre-mutation self-check of its own.
- **hpath rebuild** — `blocks.hpath` is derived and the index rebuilds it
  asynchronously after `moveDocsByID` (still the pre-move value immediately
  after the move), so the landed judgment and the echoed hpath ride the live
  tree → `moveDocVerified` (primitives `move.ts`).
- **Search window** — the kernel shares one `pageSize` window across every
  `paths` entry of a full-text search call, so a hit-rich KB fills the
  pre-filter window and silently drops the other KBs' matches →
  `keywordSearchBoxes` (primitives `search.ts`). The tool side owns only the
  resolve/echo/spill around the per-box fan-out.
- **Delete cascade** — the kernel's cascade removes a container member's
  descendants with it, so the sweep deletes only the enumerated members →
  `sweepCore` (primitives `sweep.ts`), the shared enumerated sweep with
  two consumers (`sweepSectionMembers` = replace-section,
  `deleteSectionVerified` = delete-section). The replace-section
  sequence itself (`replaceSectionVerified`: insert-before-sweep ordering,
  enumeration timing) lives in the primitives; this repo keeps the sweep's
  partial-apply envelope wording (byte-identical receipt, do-not-retry
  guidance).
- **`kb_query` description claims** (`QUERY_DESCRIPTION`, `tools.ts`) —
  agent-facing wording: `sort` is a block-type weight, not display order
  (document order comes from the outline or the anchor ids), and `hpath` is
  a derived display label, never an address. Wording pinned locally
  (`tools.test.ts`).
- **`kb_read` description claims** (`READ_DESCRIPTION`, `tools.ts`) —
  agent-facing wording over the placement module's notation: the `(not
  targetable)` marker and the `[unnamed]` fallback name the kernel's
  write-parent set (`TARGETABLE_CONTAINER_TYPES`, keyed on by the
  heading-target judgment (`heading.ts`) and the notation's glyph table
  (`outline.ts`)). Wording pinned locally (`tools.test.ts`).
- **DML through the query endpoint** — since 3.8.4 DML via the query
  endpoint is a silent no-op in every mode (code 0, row untouched): not a
  mutation vector. The tool still rejects DML by shape (`sqlScope.ts`);
  pinned locally (`sqlScope.test.ts`).
- **Breaker floor, probe, cooldown** (`gate.ts`) — the version endpoint is
  unauthenticated (live-pinned by the primitives' `version.live`); that
  it is the only tokenless route is a manually verified invariant, with
  the surface/token-attachment half enforced by `siyuan-kernel-api`'s
  `census.test.ts`; the probe runs on the raw client the gate
  hands the op, so a probe never counts as breaker contact. The local
  cooldown is the barrel's `authLockDodge` reducer (schedule in the
  primitives; `breaker.ts` holds it as session state); a 429 arms it and
  any call inside an active lock extends it. This repo pins its half: the
  429-accounting seam (`breaker.test.ts`), the structural-contact policy
  (probe marks nothing, a real call resets once — `gate.test.ts` with the
  prototype-shaped `ProbeShapeKernel` stub, `writeCreate.test.ts`), and the
  trap itself (`kernelContact.ts`, falsified directly by
  `kernelContact.test.ts`).
- **Verbatim title** — doc titles store verbatim, unescaped, in
  `blocks.content` (the HTML-escaped form lives only in `blocks.ial`, which
  the guard does not query). `writeGuard.ts` wording; falsified by the
  primitives' title round-trip live case.
- **WITH permitted** — the kernel's readonly layer permits CTEs, so rung 1
  is the only line of defense against a WITH shadowing an allowlisted table
  (`sqlScope.ts`). Standing exception — pinned locally
  (`sqlScope.test.ts`).
- **Negative LIMIT** — a negative LIMIT is sqlite's "no limit": passed
  through unclamped, never truncate-flagged (an absent LIMIT, by contrast,
  gets `RESULT_LIMIT` injected and can flag). `sqlScope.ts` `limitOf` /
  `tools.ts` `buildQueryEnvelope`; pinned locally (`tools.test.ts`).
- **Aggregate rows** — SQL projection semantics, not kernel behavior: rows
  whose projection omits `box` (per-type aggregates like
  `SELECT type, COUNT(*)`) carry no `box` field, and `postFilterRows`
  exempts exactly those rows (`sqlScope.ts`). Re-checked against the live
  row shape on an upgrade pass (`readPins.live`).
- **updateBlock not-found** — an absent edit target is never refused
  flow-side; updateBlock's synchronous not-found error surfaces verbatim
  through the kernel-refused arm (`writeEdit.ts` wording; the
  delete-generation entry is the delete analogue).
- **Re-parse** — submitted markdown is re-parsed by the kernel, so the
  stored form is unknowable at submit time and baselines are never seeded
  from it (`baselines.ts` wording; owned by the primitives' normalization
  pin).

If an entry here ever grows executable dependence on a pinned behavior, move
the code down into the primitives — do not lengthen the list. The standing
exception is the SQL scope (`sqlScope.ts`): the model-authored-SQL guard is a
tool-surface problem (the primitives' own statements are hand-built and
parser-free), so its kernel assumptions stay here and are re-checked against
the live kernel on an upgrade pass.

## Settings

- Global `~/.pi/agent/settings.json` carries `baseUrl`, `apiToken`, `kbs`, and
  the interaction dials.
- Project `<cwd>/.pi/settings.json` may contain **only**
  `gnubrain.defaultKBs`; any other key degrades the whole session.
- Build paths with `globalSettingsPath()` / `projectSettingsPath()` from
  `settings.ts`, never by hand-joining.
- `all`, `tools`, and `kbs` are reserved KB names and cannot be registered.

## Testing notes

- `__tests__/unit` runs with default parallelism; `__tests__/integration` sets
  `fileParallelism: false` and an explicit `INTEGRATION_ORDER` in
  `vitest.config.ts`. The throttle schedule pin — and its one lock-arming
  live case — lives in the primitives' live suite (`throttle.live`, run
  last there); no case in this repo's live suite arms the kernel's per-IP
  lock (the extension's dodge wiring is unit-pinned in `breaker.test.ts`).
- Unit tests use `__tests__/helpers/fakePi.ts` and SQL-routed kernel stubs
  (`__tests__/unit/writeHarness.ts` is the `kb_write` flow harness;
  `index.test.ts` drives `kb_write` through the real `register()`).
- The version-pinned behaviors are falsified by the primitives repo's
  unit + live suites (the fact list under Version coupling names where
  each lives); this repo's live cases pin tool-surface behavior (envelope
  wording, partial-replace receipts, gate ordering) — where a case also
  asserts kernel landing shape (`writePlacement.live` does, via the
  primitives' own predicates), the fact it exercises is falsified
  down-repo, never solely here.
- The integration suite needs a live SiYuan 3.8.7 kernel and self-skips
  (`describe.skipIf`) unless `SIYUAN_INTEGRATION=1`. It mints two disposable
  notebooks per run and asserts teardown leaves no strays — point it at a
  kernel you can safely mutate, never CI.

## Roadmap (parked)

- RAG / vector sidecar (v2 primary): a third consumer of the primitives read
  barrel — fed by the barrel's `docBody` body read composed with `hPathByID`
  (the title rides the hpath echo, not the body — `docBody` returns body
  bytes only) and `query/sql`, never a
  second writer; it
  must never import `siyuan-kb-primitives/write`, and composes the same
  auth-lock dodge the breaker does, from the barrel's `authLockDodge`. Store
  the embedding model id per-vector so model swaps are re-embeds, not
  migrations.
- Embedding-assisted dedup as primary identity; title guard stays as the
  zero-dep fallback (via the existing `near_matches` status).
- Smaller parked items: spill-file cleanup pass, named KB groups,
  host-side asset fetch.

## Release

`npm run release:{patch,minor,major}` (or an explicit `x.y.z`) runs
`scripts/release.mjs`: tests → version bump → promotes the CHANGELOG
`[Unreleased]` section → commit/tag → `npm publish` → reinstate `[Unreleased]`
→ push. Draft CHANGELOG entries before releasing. `prepublishOnly` also runs
tests + typecheck and `scripts/check-pack.mjs` (every root module must ship;
nothing else may). The script refuses to release while any dependency spec is
a `file:` path — the co-development link (`file:../siyuan-kb-primitives`)
must be swapped to an exact pin before publishing, and the primitives release
that this one depends on must already be on the registry (publish bottom-up).
