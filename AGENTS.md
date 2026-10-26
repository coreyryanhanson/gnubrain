# GNUbrain

Pi extension (`gnubrain`) that exposes a SiYuan kernel as a knowledge base:
four tools (`kb_read`, `kb_search`, `kb_query`, `kb_write`) plus the `/kb`
command. Published to npm as a `pi-package`.

This is the **tools layer** of a three-layer stack (bottom to top):
`siyuan-kernel-api` (typed thin HTTP client) → `siyuan-kernel-primitives`
(version-pinned kernel primitives over that client) → **gnubrain** (the four
kb tools, `/kb`, write flows, spill). Kernel-coupled logic — the block-tree
walk, by-ID reads, the title-guard reads, the guarded-create core, the verify
loops, the pin and probe — lives in `siyuan-kernel-primitives`, not here.

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
  read barrel (`siyuan-kernel-primitives`) carries all read primitives, the pin,
  the probe, and the layer-1 identity surface; the write entry
  (`siyuan-kernel-primitives/write`) is the only path to the write verdicts —
  the guarded-create core, the verified edit, the verified insert (append
  and replace-section's insert leg), the verified block/doc moves, the
  widened move dispatch (heading `blockId` → the batched section route),
  and the verified deletes. Every write mode's mutation is issued there,
  and the fresh-content precondition rides inside it too (served-baseline
  verdicts in, `fresh-refused` out); the
  flows keep only target resolution, judgment-input minting, and envelope
  wording.
  No source file in this repo
  names `siyuan-kernel-api` — take the client constructor, error classes,
  and kernel types from the read barrel (one requirer = one layer-1 copy in
  every install, which keeps `instanceof` identity alive); error
  classification rides the read barrel's `causeOf` too — the gate and the
  write-result wrapper switch exhaustively on its `KernelCause` union
  instead of re-encoding the layer-1 class list (the inline class checks
  are deliberate policy sites, not the list). A test-only
  third entry (`siyuan-kernel-primitives/testing`) is allowed under
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
  verify loops themselves live in `siyuan-kernel-primitives/write` and refuse on
  version-coupled grounds (drift, silent rollback); a new write mode composes
  them instead of re-encoding them.
- **Verdicts carry their evidence.** Write primitives return every post-write
  fact the tool layer's session policy depends on (walks, ids, hpaths) as
  verdict detail — gnubrain never re-fetches state a verdict already
  observed, so baselines and echoes are seeded from the exact snapshot the
  judgment certified. The edit's landed arm carries the judged four-field
  row (`stored`) and seeds its baseline from `stored.content`
  unconditionally — the pre-write row is guaranteed by the fresh guard's
  walk (an absent target refuses pre-mutation), so `stored.content` is
  always a post-write observation.
- **Soft scope, tool-surface-only guards.** The API token is a workspace-admin
  credential; the threat model is model accident, not a hostile agent. All
  guards (parser certification, scoping, write grant) are tool-surface-only.
  Hard isolation = separate SiYuan instances, if ever needed.
- **Upgrade checklist.** On any SiYuan upgrade: re-run the live suites against
  the new kernel *before* re-pinning — the pin lives in
  `siyuan-kernel-primitives` (`version.ts`), its repo falsifies the version-pinned
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
command, status slot, and both toolsets. The command's parsing/dispatch half
— argument parsing, `/kb tools` verb→state mapping (including the write
`requires` read cascade), scope toggles, usage wording — lives in
`kbCommand.ts`; the KB-name/param vocabulary it and the gate share lives in
`kbScope.ts`; the state lines and `toggleBatch` actuation live in
`toolsets.ts`. A `pi-tool-masking` upgrade touches `kbCommand.ts` as well
as `toolsets.ts`.
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
  delete-section / move; create is `writeCreate.ts`, append is
  `writeAppend.ts`; `write.ts` is the tool
  surface + registration; the widened `mode: move` words its two routes in
  `writeMove.ts` (per-id) and `writeMoveSection.ts` (the batched section
  arm — every heading `blockId` routes there through the primitives'
  `moveVerified` row-type dispatch, memberless or not)) are tool-schema
  orchestration
  laced with session state: baselines seeding, spill receipts, move outlines,
  envelope wording. The kernel-coupled cores they compose —
  `findTitleMatches`, `createDocVerified`, `editVerified`, `insertVerified`,
  `replaceSectionVerified` (the replace-section sequence: enumeration,
  anchor, insert-before-delete ordering — the delete leg rides the
  batched route through the shared core; the tool layer never sequences
  kernel mutations), `blockInDoc`, `rootEcho`, `ownership`,
  `resolveHeadingTarget`
  (the heading-target judgment; `headingInWalk` here maps its arms to
  wording), the verified block/doc moves (`moveVerified`'s per-id route /
  `moveDocVerified`) and the batched section move (`moveSectionVerified`
  over the `moveVerified` dispatch), the verified deletes
  (`deleteBlockVerified` /
  `deleteDocVerified`), `deleteSectionVerified` (the delete-section
  sequence: enumeration → ONE transaction of the N+1 delete ops
  (members first, heading last) → the walk partition over the single
  post-write walk — the tool layer never sequences kernel mutations),
  `orphanedMembersOf` (the heading-delete report's
  walk projection), `partitionByAbsence` (the members-survived acked-set
  split — both ride the read barrel), and the placement module (the
  section rule and the anchors derived from it)
  — live in `siyuan-kernel-primitives` and return closed `{ kind, …detail }`
  unions whose shapes and evidence the primitives' AGENTS.md documents
  (the fresh-content refusal wording lives in `writeFresh.ts` —
  `applyFreshArms` + `freshRefusalEnvelope`); the wording over those
  unions is exhaustive switches
  (no default) with `satisfies never` — or the shared `unreachable()`
  envelope tail where the switch returns an envelope — so a new kind in a
  primitives release fails typecheck until its sentence is written,
  wherever that
  sentence lives. Shared fragments live in `writeVerdicts.ts` —
  transport/verification/drift sentences, the anchor echoes
  (`appendAnchorEcho` / `moveAnchorEcho`), the `blockInDocRefusalKind`
  sentence — and the batched kernel route's shared doctrine in
  `writeBatchedVerdicts.ts` — the refusal note, the repair-first leads
  (`repairFirstLead` / `sameDocRepairFirstLead`), the
  survivor/nothing-deleted skeletons (`batchedSurvivorMessage` /
  `batchedNothingDeletedMessage`), the two shared truncation tails, and
  the post-walk-truncated receipt (`appliedButUnverifiedEnvelope`). The
  one frame shared across flows —
  the pre-judgment failure ladder (`mutationFailureEnvelope`, the one
  async piece: it awaits the flow-supplied echo tail and takes the
  flow's optional `refusalNote` for route residuals the shared frame
  cannot know) — lives in `writeLadder.ts` beside its flow-side bindings
  (`mutationFailure` / `batchedMutationFailure`, plus the batched
  routes' shared refusal and unverified ladders —
  `batchedRefusalEnvelope` / `batchedUnverifiedEnvelope`); the echo
  reads behind its tails stay in `writeEcho.ts` (`echoTail`,
  `errorTail`, `destOutlinePayload`, `deletedBlocksTail`,
  `orphanedRefs`). Every flow's
  post-mutation reads run inside `writeResult.ts` (`finishWrite`) — a
  thrown error there reads as `verificationFailed`
  (applied-but-unverified, never "unreachable"), so no arm can invite
  the blind re-issue; the rethrow policy lives on its docstring. Each mode's own
  verdict sentences co-locate with
  that mode's flow — the composite survivor/nothing-deleted doctrine
  (repair first, then by-id cleanup, never re-run replace-section) in
  `writeReplaceSection.ts` (the batched
  delete-section words its own recovery clauses beside its
  flow — the doctrine and the recovery clauses are each flow's own;
  the sentence skeletons, the by-id-delete guard, the cause-free lead,
  and the truncation tails are shared), and each
  remaining mode composes its envelope frames from both halves.
  Schema/shape in `writeSchema.ts`, grant gate in `writeConfirm.ts`, mint
  policy in `writeGuard.ts` (`validateMintTitle` — wording only; the
  mint-title kernel facts live in the primitives' `mintTitleProblem`).
  Target resolution and the target-judgment wording in `writeTarget.ts`
  (`WriteFlowBase`/`WriteFlowInput`, `resolveDocTarget`, `headingInWalk`,
  `anchorRefusal`, `walkTruncatedMessage`).
- **Session state** stays here: `baselines.ts` (what this chat was shown),
  `breaker.ts` (thin session holder over the barrel's `authLockDodge` —
  session scoping, the 429-accounting seam (every 429 funnels through
  `recordRateLimitFromVerdict` — the classification of thrown errors and
  verification-phase verdicts lives with `causeOf` and the primitives),
  and wording state; the dodge schedule itself lives in the primitives),
  grant state, spill receipts. These are session-lifetime
  policy, not kernel facts.
- **The status slot repaints on the tool-result boundary** — `pi.on(
  "tool_result", repaint)` in `index.ts`; the derivation and paint
  contracts (the lockout join point, the mutation-site coverage the
  boundary rests on) are canonical on `statusInput` in `status.ts`.
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

The SiYuan version pin (`PINNED_SIYUAN_VERSION`, `"3.8.8"`), the drift probe
(`probeKernel` → `KernelProbeResult`), and the pinned lock schedule
(`authLockSeconds`) live in `siyuan-kernel-primitives`' `version.ts`; this repo
consumes them through the read barrel — writes fail closed on `drift` (the
gate refuses before the op runs, the probe-taking primitives refuse again
inside; the section-delete core takes no probe, its sequences run mid-flow
after the gate's refusal), reads warn, and the breaker's cooldown rides the
barrel's `authLockDodge`. Change the pin only deliberately, in the
primitives repo — its live suite asserts the kernel reports the pin exactly,
and the upgrade checklist above gates the bump.

**Tool-side kernel-fact list** — one entry per fact: kernel behavior →
primitives home (module:symbol) → what this repo keeps → falsifier. Facts
are falsified in the primitives repo's suites; this repo exercises them
transitively and names a local test only where it pins something of its own
(tool-surface wording or a live case on the tool path). `sqlScope.ts`
entries are the standing exception — tool-surface by design, so this repo
falsifies them itself. An upgrade pass re-runs the primitives' suites
wholesale, then re-falsifies the changed facts in the primitives.

- **Fresh-content judgment** — the four destroy-shaped write primitives run
  the fresh precondition internally, immediately before mutating
  (`fresh.ts`; currency = as of the walk/enumeration the judgment holds);
  refusal wording via `applyFreshArms`/`freshRefusalEnvelope`
  (`writeFresh.ts`). Repo keeps the seed-site policy: walk seeds everywhere
  except two SQL-form seeds — `kb_query`'s served rows (`rememberServedRows`,
  `baselines.ts`; seeded at `tools.ts`) and `echoTail`'s write-result
  refresh ids (via `blockContents`, `writeEcho.ts`); a diverging seed reads
  as `stale`, named, never silently matched.
- **Child order** — `getChildBlocks` returns document order →
  `firstChildContent` (`byId.ts`); repo keeps the near-match swallow
  (`writeCreate.ts`): vanished candidate mid-scan → empty excerpt, kernel
  errors rethrown for classification.
- **Doc targeting** — a block id passed as `docId` reads as absent
  (type-`'d'` root row), never normalized → `rootEcho` (`byId.ts`);
  consumed by `resolveDocTarget` and `kb_read`'s `ownership` read.
- **Omitted-empty body blocks** — empty block bytes vanish from the body,
  the row keeps its place; the count is the never-silent half →
  `docBody`/`readDoc` (`body.ts`); repo surfaces it (`omittedEmpty`,
  `runRead`).
- **Insert shape** — one `doOperations` entry per markdown insert, whole
  body in its `data` → `insertVerified` (`write.ts`).
- **`lsNotebooks` encrypted flag** — `encrypted` always present regardless
  of lock state → `resolveNotebooks` (`notebooks.ts`); repo keeps the
  rejection wording + warn-and-drop (`validation.ts`), pinned locally
  (`encryptedNotebook.live`).
- **Delete scoping** — the kernel mutates by raw block id with no doc
  scoping; membership judged per path in the primitives (`blockInDoc`;
  caller-provenance over the enumeration walk) →
  `delete.ts`/`deleteSection.ts`/`replace.ts`; refusal arms worded here
  (`blockInDocRefusalKind`, `writeVerdicts.ts`).
- **Delete generation** — 3.8.3 success no-op vs 3.8.4 "tree not found" →
  `deleteBlockVerified`/`deleteDocVerified` (`delete.ts`); repo keeps the
  flow wording: kernel error verbatim with the fresh outline, a
  still-present verdict is an error, never an ok receipt.
- **Section-delete batch** — one transaction of the N+1 deletes: commit-wait,
  whole-group rollback behind HTTP success (cause-free), sub-cliff silent
  no-op, ≥32 bulk path voids the batch, rollback residue → repair-first
  (`deleteSection.ts`/`batch.ts`); repo keeps the wording
  (`writeDeleteSection.ts`, `writeDeleteSection.test.ts`) plus the
  batched-route refusal note and the whole-judged-set unconfirmed payload.
- **Heading-delete scope** — a heading delete removes only the heading;
  members survive, ownership moves to the preceding heading →
  `deleteSectionVerified` + `orphanedMembersOf` (`placement.ts`); repo
  keeps the member report — sound presences, never a truncated walk
  (`writeDelete.ts`; pins `writeDelete.test.ts`, live `writeDelete.live`).
- **Delete-freshness split** (policy, repo-owned) — block/section deletes
  ride the fresh precondition (the section over the WHOLE delete set);
  doc-delete is deliberately unguarded: container-level intent, the receipt
  itemizes every lost block, no interposable refusal point without
  duplicating the walk.
- **Mint policy** — 512-rune truncation bound, `/` path-separator rule →
  `mintTitleProblem`; repo keeps the wording (`validateMintTitle`,
  `writeGuard.ts`), a superset claim over `normalizeDocTitle`.
- **Synchronous move rejection** — ancestor/identity moves rejected
  synchronously (doc-level record, no echo tail) → `moveDocVerified`
  (`move.ts`); repo keeps the record-shape wording, no pre-mutation
  self-check of its own.
- **Widened section move** — heading `blockId` routes to the batched section
  sequence inside `moveVerified` (kernel-side logic all the primitives') →
  `moveSectionVerified` (`moveSection.ts`); repo keeps wording only
  (`writeMoveSection.ts`, `writeMoveSection.test.ts`): group-refusal
  envelopes, the landed receipt led by the `destinationRelation` clause,
  the section title + owner line, the
  `landed-divergent`/unjudged-presence sentences, the `nothing-moved`
  recovery (same-doc: retry once from fresh walks; cross-doc: heal the
  SOURCE doc first, then re-issue once), and the batched-route refusal
  note; widened-capability statement pinned in `writeSchema.test.ts`.
- **Search window** — one `pageSize` window shared across every `paths`
  entry of a full-text search call → `keywordSearchBoxes` (`search.ts`);
  repo owns only resolve/echo/spill around the fan-out.
- **Delete cascade** — a member's descendants cascade with it, so the batch
  deletes only the enumerated members → `deleteApply`
  (`sectionDeleteCore.ts`); repo keeps the composite survivor/nothing-deleted
  wording (repair-first, never a re-run).
- **`kb_query` description claims** — `sort` is a block-type weight, not
  display order; `hpath` a derived label, never an address
  (`QUERY_DESCRIPTION`, `tools.ts`; pinned locally, `tools.test.ts`).
- **`kb_read` description claims** — the `(not targetable)` marker and
  `[unnamed]` fallback name the kernel's write-parent set
  (`TARGETABLE_CONTAINER_TYPES`; pinned locally, `tools.test.ts`).
- **DML through the query endpoint** — since 3.8.4 a silent no-op in every
  mode: not a mutation vector; the tool still rejects DML by shape
  (`sqlScope.ts`, pinned locally, `sqlScope.test.ts`).
- **Breaker floor, probe, cooldown** (`gate.ts`) — version endpoint
  unauthenticated (live-pinned by `version.live`; surface/token-attachment
  half by `siyuan-kernel-api`'s `census.test.ts`); the probe runs on the
  raw client the gate hands the op, never breaker contact; a 429 arms
  `authLockDodge` (session state in `breaker.ts`) and calls inside a lock
  extend it. Repo pins its half: the 429-accounting seam
  (`breaker.test.ts`), the structural-contact policy (`gate.test.ts`), the
  trap (`kernelContact.ts`, `kernelContact.test.ts`).
- **Verbatim title** — titles store verbatim in `blocks.content` (the
  escaped form lives only in `blocks.ial`, unqueried by the guard);
  `writeGuard.ts` wording, falsified by the primitives' title round-trip
  live case.
- **WITH permitted** — the readonly layer permits CTEs, so rung 1 is the
  only defense against WITH shadowing an allowlisted table (`sqlScope.ts`;
  standing exception, pinned locally, `sqlScope.test.ts`).
- **Negative LIMIT** — a negative LIMIT is sqlite's "no limit": unclamped,
  never truncate-flagged (an absent LIMIT gets `RESULT_LIMIT` injected and
  can flag) (`limitOf`, `sqlScope.ts`; pinned locally, `tools.test.ts`).
- **Aggregate rows** — SQL projection semantics: rows whose projection
  omits `box` are exempt from `postFilterRows` (`sqlScope.ts`; re-check
  the live row shape on an upgrade pass, `readPins.live`).
- **Edit landing, tree-primary** — the edit judges walk-vs-walk over
  `(content, type, subType, markdown)` (`parentId` is the concurrent-move
  signal, never watched) off one synchronous post-write walk — no poll,
  no window (index 0–3s stale) → `editVerified`/`judgeEditLanded`
  (`edit.ts`); absence legs ride the same walk (re-parent =
  concurrent-move, absent-complete = concurrent-gone, absent-incomplete =
  absence-unconfirmed); repo words the arms exhaustively (`writeEdit.ts`,
  `writeEdit.test.ts`), the ok outline served from the verdict's
  `postWalk` — no second read. Two route-scoped comparison limits ride
  the live pin (`writePins.live`): `- [x]` stores as `- [X]` (never
  byte-match a submitted body against the stored form) and a `{: …}`
  suffix stores as literal text (attribute state invisible to the
  markdown-only route).
- **Absent-target refusal (edit-only)** — a complete walk emits every
  blocks row except the `d` root, so an absent target refuses
  PRE-mutation: a walk-invisible row's `updateBlock` acks a destructive
  body wipe while `deleteBlock` refuses through the tree, and ids are
  format-indistinguishable through the flush window, so the guard is
  edit-only (the delete flow's `kernel-refused` arm covers the `d`-row
  case) → `editVerified`'s `absent-target` arm (primitives'
  `writePins.live`); repo words the refusal with the carried walk's
  outline — recovery re-targets from the outline, never a re-fetch
  (`editAbsentTargetMessage`, `writeVerdicts.ts`).
- **Re-parse** — submitted markdown is re-parsed by the kernel, stored
  form unknowable at submit; baselines never seeded from it
  (`baselines.ts` wording; owned by the primitives' normalization pin).

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
- The integration suite needs a live SiYuan 3.8.8 kernel and self-skips
  (`describe.skipIf`) unless `SIYUAN_INTEGRATION=1`. It mints two disposable
  notebooks per run and asserts teardown leaves no strays — point it at a
  kernel you can safely mutate, never CI.

## Roadmap (parked)

- RAG / vector sidecar (v2 primary): a third consumer of the primitives read
  barrel — fed by the barrel's `docBody` body read composed with `hPathByID`
  (the title rides the hpath echo, not the body — `docBody` returns body
  bytes only) and `query/sql`, never a
  second writer; it
  must never import `siyuan-kernel-primitives/write`, and composes the same
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
a `file:` path, and the primitives release that this one depends on must
already be on the registry (publish bottom-up).
