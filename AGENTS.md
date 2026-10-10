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
  mode's mutation is issued there; the flows keep only target resolution,
  preconditions, and envelope wording.
  No source file in this repo
  names `siyuan-kernel-api` — take the client constructor, error classes,
  and kernel types from the read barrel (one requirer = one layer-1 copy in
  every install, which keeps `instanceof` identity alive).

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
command, status slot, and both toolsets. `deps` is the injectable test seam
(`readFile`, `homeDir`, `createClient`) — unit and integration
tests drive the extension through it instead of touching real files.

- **Every kb tool call routes through `gate.ts`.** Reads use `runKbCall`;
  writes run the per-KB grant gate (after `guardCall`, before
  `gateWriteAttempt`), then `gateWriteAttempt`, then a flow. The gate
  order is pinned (shape → breaker → 429 cooldown → `kb` param → mode/body
  shape → mint title → cached-verdict drift refusal → grant) and refuses
  locally with zero kernel calls before the op runs. One deliberate
  exception: `kb_read`'s `kb: "kbs"` discovery form short-circuits ahead
  of the gate with zero kernel calls (it must run while the breaker is
  tripped). Never call the kernel client outside this path.
- **Kernel contact is structural, not signaled.** `runKbCall` wraps the
  op's client in a tracked proxy (`trackKernel`) and only the op receives
  it: any method invocation marks contact, and contact alone drives
  `breaker.recordSuccess()`. Two load-bearing assumptions — every public
  client method except `getVersion` is an authenticated route (`getVersion`'s
  route needs no token, live-pinned by the primitives' `version.live`; the
  other half — no token fails every other route — by layer 1's auth smoke
  matrix), and an op reaches the
  kernel only through the client the gate passed it — so a flow that
  captured or rebuilt a client would silently stop resetting the
  breaker. The probe is target-bound and marks nothing, so a
  probe-only refusal (drift, 429, unreachable retry) never resets the
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
- **Write flows** (`write.ts` dispatches edit / append / replace-section /
  delete / move; create is `writeCreate.ts`) are tool-schema orchestration
  laced with session state: baselines seeding, spill receipts, move outlines,
  envelope wording. The kernel-coupled cores they compose —
  `findTitleMatches`, `createVerifiedDoc`, `editVerified`, `insertVerified`,
  `replaceSectionVerified` (the replace-section sequence: enumeration,
  anchor, insert-before-sweep ordering — the tool layer never sequences
  kernel mutations), `blockInDoc`, `rootEcho`, `ownership`, the
  fresh-content judgment (`checkFreshContent`), `resolveHeadingTarget`
  (the heading-target judgment; `headingInWalk` here maps its arms to
  wording), the verified block/doc moves (`moveBlockVerified` /
  `moveDocVerified`), the verified deletes (`deleteBlockVerified` /
  `deleteDocVerified`), and the placement module (the section rule and
  the anchors derived from it)
  — live in `siyuan-kb-primitives` and return closed `{ kind, …detail }`
  unions whose shapes and evidence the primitives' AGENTS.md documents
  (the fresh-content refusal wording lives in `freshContentRefusal`,
  `writeResult.ts`);
  `writeVerdicts.ts` maps every kind to agent-facing wording via exhaustive
  switches (no default), so a new kind in a primitives release fails
  typecheck until its wording is written here — the anchor echoes ride the
  same rule (`appendAnchorEcho` / `moveAnchorEcho`), and the shared
  pre-judgment failure ladder of the verified mutation flows
  (`mutationFailureEnvelope`) is worded there too, so a new failure arm
  fails typecheck once, not per flow.
  Schema/shape in `writeSchema.ts`, grant gate in `writeConfirm.ts`, mint
  policy in `writeGuard.ts` (`validateMintTitle` — wording only; the
  mint-title kernel facts live in the primitives' `mintTitleProblem`).
- **Session state** stays here: `baselines.ts` (what this chat was shown),
  `breaker.ts` (thin session holder over the barrel's `authLockDodge` —
  session scoping, the genuine-error→event seam, and wording state; the
  dodge schedule itself lives in the primitives), grant state, spill
  receipts. These are session-lifetime
  policy, not kernel facts.
- **SQL handling is pure and testable** in `sqlScope.ts` (node-sql-parser):
  only single-table `SELECT` from `blocks`/`refs`; scope is spliced into the
  AST and re-parsed for verification. It stays here because model-authored SQL
  is a tool-surface problem — the primitives' own statements are hand-built
  with fixed heads, no parser.
- **Result shaping** stays here: `spill.ts` owns inline-vs-spill
  (`withRowPayload`, `PREVIEW_CHARS`, `OUTLINE_HEADINGS`, `RESULT_LIMIT`) and
  `outline.ts` owns outline serving (`serveOutline`/`serveOutlineFromWalk` —
  the required-baselines wrappers: seeding, the inline cut, the spill tail).
  The notation itself (`renderExtendedOutlineLines`, the primitives read
  barrel's canonical extended-outline renderer — its `containerPrefix`
  helper lives in the primitives' `outline.ts`, exported there but not
  re-exported through the barrel) means the served lines can never diverge
  from the section rule; the tool descriptions document the notation the
  agent sees.
- Every tool result is an envelope `{status: ok | near_matches | duplicate |
  error | refused, message, ...}` (`envelope.ts`) — use its factory helpers,
  don't invent statuses. Large payloads spill to session temp files.

## Version coupling

The SiYuan version pin (`PINNED_SIYUAN_VERSION`, `"3.8.6"`), the drift probe
(`probeKernel` → `KernelProbeResult`), and the pinned lock schedule
(`authLockSeconds`) live in `siyuan-kb-primitives`' `version.ts`. This
repo consumes them through the read barrel: writes fail closed on a
`drift` verdict — the gate refuses
before the op runs, and the probe-taking primitives refuse again inside
(defence-in-depth; the sweep alone takes no probe — it runs mid-sequence
after the gate's refusal), reads warn, and the breaker's cooldown rides the barrel's
`authLockDodge`. Change the pin only deliberately, in the primitives repo — its live
suite asserts the kernel reports the pin exactly, and the checklist above
gates the bump.

**Tool-side kernel-fact list** — the complete set of spots in *this* repo
whose comments or wording reference a pinned kernel behavior. Every fact
here is falsified in the primitives repo's unit + live suites (an upgrade
pass re-runs them wholesale); this repo's suites exercise them transitively
and never sole-falsify a pinned fact, so entries name a test only where
this repo pins something of its own — tool-surface wording, or a live case
riding the tool path. The two `sqlScope.ts` entries are the standing
exception named in the rule below: their guard is tool-surface by design,
so this repo falsifies them itself. The tool-side code at each spot is wording and
precondition, not the fact itself; an upgrade pass re-reads this list and
re-falsifies the changed fact in the primitives.

- The fresh-content judgment (`checkFreshContent`, the primitives' read
  barrel) — the precondition rides the live tree, never the SQL index
  (`blocks.content` converges asynchronously), and the walk ≡ SQL
  equivalence (the kernel builds both via `nodeStaticContent`, so walk-form
  and SQL-form baselines hash identically) remains a cross-boundary
  property: the judgment and both reads live in the primitives, the read
  tools' serve seeds ride the walk, and the SQL-form seed sites are
  exactly three — `runEditMode`'s pre-write seed from `blockInDoc`
  (`writeEdit.ts`), `kb_query`'s served rows (`tools.ts`, via
  `rememberServedRows`), and the success-path `echoTail` refresh in
  `writeFlow.ts` (the sites the `rememberServedRows` entry below names).
  Fail-closed on any split (a diverging seed reads as `stale`, named,
  never silently matched — the retry proceeds).
- The child-order fact — `getChildBlocks` returns a parent's children in
  document order, so the first element is the doc's first block — lives in
  `firstChildContent` (primitives `byId.ts`); the near-match
  excerpt read (`writeCreate.ts`) keeps only the swallow policy (a
  vanished candidate mid-scan → empty excerpt, kernel errors rethrown
  for classification).
- `rememberServedRows` (`baselines.ts`) — its doc comment claims the same
  getChildBlocks ≡ `blocks.content` equivalence; the code depends on
  nothing (the same for the `serveOutlineFromWalk` doc comment in
  `outline.ts`). The executable-dependence sites are the three SQL-form
  seeds the fresh-content entry above names: `runEditMode`'s pre-write
  seed (`writeEdit.ts`), `kb_query`'s served rows (`tools.ts`), and the
  `echoTail` baseline-refresh comment in `writeFlow.ts` — all seed
  SQL-form content into the baseline map the judgment hashes walk-form
  against.
- The type-`'d'` root-row fact behind doc targeting (`writeFlow.ts`
  `resolveDocTarget` consumes the primitives' `rootEcho` directly; the
  refusal is `noSuchDocEnvelope`) — a block id passed as `docId` reads as
  absent, never normalized to its containing doc. The same type-`'d'` row
  fact is exercised by `kb_read`'s doc resolution (`runRead` in `tools.ts`,
  via the primitives' `ownership` read: a block id there exports its
  containing doc); the missing-docId refusal is wording-only and names
  the same fact.
- The insert-shape fact — one `doOperations` entry per markdown insert,
  whole body in its `data` — lives in `insertVerified` (primitives
  `write.ts`).
- The `lsNotebooks` encrypted-flag fact — `encrypted` is always present in
  the listing regardless of lock state, and the SQL surface cannot see
  encrypted boxes, so one rejection covers both lock states — lives in
  `resolveNotebooks` (primitives `notebooks.ts`); this repo keeps the
  rejection wording and the warn-and-drop policy (`validation.ts`); the
  tool path is pinned locally (`encryptedNotebook.live`).
- The delete-scoping fact — the kernel mutates by raw block id with no
  doc scoping of its own, so `deleteBlockVerified` judges membership
  itself (the shared `blockInDoc` read): `foreign` / `doc-id` refuse
  before any kernel call while `absent` falls through to the
  generation answer; this repo words the refusal arms through the same
  sentence pair the edit flow's pre-guard uses
  (`blockInDocRefusalKind`, `writeVerdicts.ts`).
- The delete-generation fact — 3.8.3 success no-op vs 3.8.4 "tree not
  found" — lives in `deleteBlockVerified` / `deleteDocVerified`
  (primitives `delete.ts`); this repo keeps the flow-side wording (kernel
  error verbatim with the fresh outline, the targetGone receipt gate).
- The mint-policy claims (`validateMintTitle`, `writeGuard.ts`) —
  wording only; the facts themselves (the `normalizeDocTitle` 512-rune
  truncation bound, the `/` path-separator rule) live in the primitives'
  `mintTitleProblem` (`/write` entry); the rejection set remains a
  superset claim over `normalizeDocTitle`.
- The synchronous-move-rejection fact — the kernel rejects ancestor and
  identity moves synchronously ("Cannot move to this location", doc-level
  record, no echo tail; the identity member live-pinned in the primitives'
  `move.live`) — lives in `moveDocVerified` (primitives `move.ts`); this
  repo keeps the doc-level move record shape wording (outline + title/hpath
  echo, no anchor/newBlockId/destOutline) and carries no pre-mutation
  self-check of its own.
- The hpath-rebuild fact — `blocks.hpath` is a derived column the index
  rebuilds asynchronously after `moveDocsByID` (still the pre-move value
  immediately after the move), so the landed judgment and the echoed hpath
  ride the live tree — the fact lives in `moveDocVerified` (primitives
  `move.ts`).
- The search-window fact — the kernel shares one `pageSize` window across
  every `paths` entry of a full-text search call, so a hit-rich KB fills
  the pre-filter window and silently drops the other KBs' matches — lives
  in `searchBoxes` (primitives `search.ts`); the tool side owns only
  the resolve/echo/spill around the per-box fan-out.
- The delete-cascade fact — the kernel's cascade removes a container
  member's descendants with it, so the sweep deletes only the enumerated
  members — lives in `sweepSectionMembers` (primitives `sweep.ts`;
  internal to the replace-section sequence, not on the write barrel);
  the replace-section sequence itself (`replaceSectionVerified`, the
  insert-before-sweep ordering and the enumeration timing) also lives in
  the primitives, and this repo keeps the sweep's partial-apply envelope
  wording (byte-identical receipt, do-not-retry guidance).
- The `kb_query` description claims (`tools.ts`, `QUERY_DESCRIPTION`) —
  agent-facing wording: `sort` is a block-type weight, not display order
  (document order comes from the outline or the anchor ids), and `hpath`
  is a derived display label, never an address. Wording pinned by the
  local unit suite (`tools.test.ts`).
- The `kb_read` description claims (`tools.ts`, `READ_DESCRIPTION`) —
  agent-facing wording over the placement module's notation: the
  `(not targetable)` marker and the `[unnamed]` fallback name the kernel's
  write-parent set (`TARGETABLE_CONTAINER_TYPES`, the primitives'
  targetable-container set, keyed on by the heading-target judgment
  (`walk.ts`) and the notation's glyph table (`outline.ts`); exported for
  consumers, though no gnubrain code imports it today). Wording pinned
  by the local unit suite (`tools.test.ts`).
- The DML-through-the-query-endpoint fact — since 3.8.4 DML via the query
  endpoint is a silent no-op in every mode (code 0, row untouched), so the
  endpoint is no longer a mutation vector and the tool still rejects DML
  by shape; the tool-side shape rejection is pinned locally
  (`tools.test.ts`).
- The breaker-floor and probe/cooldown comments (`gate.ts`) — the local
  cooldown is the barrel's `authLockDodge` reducer (its schedule lives in
  the primitives; `breaker.ts` holds it as session state); the version
  endpoint is unauthenticated so a probe never counts as breaker contact
  (falsified live by the primitives' `version.live`), a 429 arms the
  local cooldown, and any call inside an active lock extends it. The
  extension's half (holder wiring, the genuine-class seam) is pinned
  locally (`breaker.test.ts`), and the structural-contact policy on top
  of that fact (probe marks nothing, a real call resets once) is pinned
  by the gate unit suite (`gate.test.ts` with the prototype-shaped
  `ProbeShapeKernel` stub, `writeCreate.test.ts`).
- The verbatim-title fact (`writeGuard.ts` wording) — doc titles store
  verbatim, unescaped, in `blocks.content` (the HTML-escaped form lives
  only in `blocks.ial`, which the guard does not query); falsified by the
  primitives' title round-trip live case.
- The WITH-permitted fact (`sqlScope.ts`) — the kernel's readonly layer
  permits CTEs, so layer 1 is the only line of defense against a WITH
  shadowing an allowlisted table (pinned locally by `tools.test.ts`).
- The aggregate-row claim (`sqlScope.ts`) — SQL projection semantics, not
  kernel behavior: rows whose projection omits `box` (per-type aggregates
  like `SELECT type, COUNT(*)`) carry no `box` field, and `postFilterRows`
  exempts exactly those rows. Re-checked against the live row shape on an
  upgrade pass (`readPins.live`).
- The updateBlock-not-found fact (`writeEdit.ts` wording) — an absent
  edit target is never refused flow-side; updateBlock's synchronous
  not-found error surfaces verbatim through the kernel-refused arm (the
  delete-generation entry is the delete analogue).
- The re-parse fact (`baselines.ts` wording) — submitted markdown is
  re-parsed by the kernel, so the stored form is unknowable at submit
  time and baselines are never seeded from it; owned by the primitives'
  normalization pin.

If an entry here ever grows executable dependence on a pinned behavior, move
the code down into the primitives — do not lengthen the list. The standing
exception is the SQL scope (`sqlScope.ts`): the model-authored-SQL guard is
a tool-surface problem (the primitives' own statements are hand-built and
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
- The integration suite needs a live SiYuan 3.8.6 kernel and self-skips
  (`describe.skipIf`) unless `SIYUAN_INTEGRATION=1`. It mints two disposable
  notebooks per run and asserts teardown leaves no strays — point it at a
  kernel you can safely mutate, never CI.

## Roadmap (parked)

- RAG / vector sidecar (v2 primary): a third consumer of the primitives read
  barrel — fed by the barrel's `docMarkdown` read/`query/sql`, never a
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
