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
  verified deletes and delete sweep (mutation + landing judgment as one
  primitive call, returning a closed union with the evidence the verdict
  was rendered from). Every write mode's mutation is issued there; the
  flows keep only target resolution, preconditions, and envelope wording.
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
  judgment certified.
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
(`readFile`, `homeDir`, `createClient`, `pinnedVersion`) — unit and integration
tests drive the extension through it instead of touching real files.

- **Every kb tool call routes through `gate.ts`.** Reads use `runKbCall`;
  writes run the per-KB grant gate (after `guardCall`, before
  `gateWriteAttempt`), then `gateWriteAttempt`, then a flow. The gate
  order is pinned (shape → breaker → 429 cooldown → `kb` param → mint title →
  cached-verdict drift refusal → grant) and refuses locally with zero kernel
  calls before the op runs. Never call the kernel client outside this path.
- **Toolsets** via `pi-tool-masking`: `gnubrain.read` (registered in
  `tools.ts`, three read tools) and `gnubrain.write` (`write.ts`, one
  `kb_write`). Write `requires` read — enabling writes cascades reads on.
  `/kb tools read|write|off` toggles them live.
- **Write flows** (`write.ts` dispatches edit / append / replace-section /
  delete / move; create is `writeCreate.ts`) are tool-schema orchestration
  laced with session state: baselines seeding, spill receipts, move outlines,
  envelope wording. The kernel-coupled cores they compose —
  `findTitleMatches`, `createVerifiedDoc`, `editVerified`, `insertVerified`,
  `blockInDoc`, `rootEcho`, the fresh-content judgment
  (`checkFreshContent`), `resolveHeadingTarget` (the heading-target
  judgment; `headingInWalk` here maps its arms to wording), the verified
  block/doc moves (`moveBlockVerified` / `moveDocVerified`), the verified
  delete sweep (`sweepSectionMembers`), the verified deletes
  (`deleteBlockVerified` / `deleteDocVerified`), and the placement module
  (the section rule and the anchors derived from it) — live in
  `siyuan-kb-primitives` and return closed `{ kind, …detail }` unions (the
  fresh-content judgment instead returns its arms and the judged walk as
  evidence; the doctrine over them stays in `freshContentRefusal`);
  `writeVerdicts.ts` maps every kind to agent-facing wording via exhaustive
  switches (no default), so a new kind in a primitives release fails
  typecheck until its wording is written here — the anchor echoes ride the
  same rule (`appendAnchorEcho` / `moveAnchorEcho`), and the shared
  pre-judgment failure ladder of the verified mutation flows
  (`mutationFailureEnvelope`: drift / transport-unverified / kernel-refused /
  verification-failed) is worded there too, so a new failure arm fails
  typecheck once, not per flow — the ladder's arms are the primitives'
  exported `MutationFailure` union (composed by the insert / edit /
  block-move / doc-move / block-delete outcomes; create and doc-delete keep
  their distinct arms).
  Schema/shape in `writeSchema.ts`, grant gate in `writeConfirm.ts`, mint
  policy in `writeGuard.ts` (`validateMintTitle` — the guard's stmt
  builders and the mint-title kernel facts both moved down; only the
  wording stays).
- **Session state** stays here: `baselines.ts` (what this chat was shown),
  `breaker.ts` (thin session holder over the barrel's `authLockDodge` —
  session scoping, the genuine-error→event seam, and wording state; the
  dodge schedule itself — trip threshold held in reserve under the kernel's
  6-failure lock, cooldown floor, deadline extension, reset-on-success —
  moved down), grant state, spill receipts. These are session-lifetime
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
  barrel's canonical extended-outline renderer — `containerPrefix` stays
  module-internal to the primitives' `outline.ts`) means the served lines
  can never diverge from the section rule; the tool descriptions document
  the notation the agent sees.
- Every tool result is an envelope `{status: ok | near_matches | duplicate |
  error | refused, message, ...}` (`envelope.ts`) — use its factory helpers,
  don't invent statuses. Large payloads spill to session temp files.

## Version coupling

The SiYuan version pin (`PINNED_SIYUAN_VERSION`, `"3.8.4"`), the drift probe
(`probeKernel` → `KernelProbeResult`), and the pinned lock schedule
(`authLockSeconds`) live in `siyuan-kb-primitives`' `version.ts` — not in
`validation.ts`. This repo consumes them through the read barrel: writes fail closed on a `drift` verdict — the gate refuses
before the op runs, and the probe-taking primitives refuse again inside
(the sweep takes no probe, so replace-section's drift refusal is the
gate's alone), reads warn, and the breaker's cooldown rides the barrel's
`authLockDodge`. Change the pin only deliberately, in the primitives repo — its live
suite asserts the kernel reports the pin exactly, and the checklist above
gates the bump.

**Tool-side kernel-fact list** — the complete set of spots in *this* repo
whose comments or wording reference a pinned kernel behavior. The
falsifying tests for every fact live in the primitives repo or a local
live suite as noted; the tool-side code at each spot is wording and
precondition, not the fact itself. An upgrade pass re-reads this list and,
where the cited fact changed, updates wording/comments here and
re-falsifies the fact there:

- The fresh-content judgment (`checkFreshContent`, the primitives' read
  barrel) — the precondition rides the live tree, never the SQL index
  (`blocks.content` converges asynchronously), and the walk ≡ SQL
  equivalence (the kernel builds both via `nodeStaticContent`, so walk-form
  and SQL-form baselines hash identically) remains a cross-boundary
  property: the comparison and both reads moved down with the promotion,
  and the serve seeds ride the walk — the one SQL-form seed left is the
  success-path `echoTail` refresh in `writeFlow.ts` (the exception the
  `rememberServedRows` entry below names). Fail-closed on any split (a
  diverging seed reads as `stale`, named, never silently matched — the
  retry proceeds). Falsified
  by the primitives live content-equivalence case and their `fresh` unit
  and live suites.
- The child-order fact — `getChildBlocks` returns a parent's children in
  document order, so the first element is the doc's first block — moved
  down with `firstChildContent` (primitives `byId.ts`); the near-match
  excerpt read (`writeCreate.ts`) keeps only the swallow policy (a
  vanished candidate mid-scan → empty excerpt, kernel errors rethrown
  for classification). Falsified by the primitives' `walk.live`
  (document-order walk) and `byId.test.ts` (the rethrow-verbatim arm).
- `rememberServedRows` (`baselines.ts`) — its doc comment claims the same
  getChildBlocks ≡ `blocks.content` equivalence; the code depends on
  nothing (the same for the `serveOutlineFromWalk` doc comment in
  `outline.ts`). The `echoTail` baseline-refresh comment in `writeFlow.ts`
  (the success-path echo tail it cites is the executable-dependence site)
  is the exception: that refresh seeds SQL-form content into the baseline
  map the judgment hashes walk-form against — the site the fresh-content
  entry above names. Falsified by the same primitives live case.
- The type-`'d'` root-row wording in `resolveDocTarget`'s refusal
  (`writeFlow.ts`) — wording only; the type-`'d'` row semantics the wording
  describes moved with the pin (`rootEcho` in the primitives). The same
  type-`'d'` row fact is also the discovery hint in `kb_read`'s
  missing-docId refusal (`tools.ts`). Falsified by
  the primitives live title round-trip and by-ID cases.
- The insert-shape fact — one `doOperations` entry per markdown insert,
  whole body in its `data` — moved down with `insertVerified` (primitives
  `write.ts`). Falsified by the primitives live insert-shape case plus
  local append/replace-section round trips (`writePlacement.live`).
- The `lsNotebooks` encrypted-flag fact — `encrypted` is always present in
  the listing regardless of lock state, and the SQL surface cannot see
  encrypted boxes, so one rejection covers both lock states — moved down
  with `resolveNotebooks` (primitives `notebooks.ts`); only the rejection
  wording and the warn-and-drop policy stay in `validation.ts`. Falsified
  by the primitives' `notebooks.live` (both lock states) beside the branch,
  plus the local tool-path case (`encryptedNotebook.live`).
- The delete-generation fact — 3.8.3 success no-op vs 3.8.4 "tree not
  found" — moved down with `deleteBlockVerified` / `deleteDocVerified`
  (primitives `delete.ts`); the flow-side wording (kernel error verbatim
  with the fresh outline, the targetGone receipt gate) stays tool-side.
  Falsified by the primitives' `delete.live` (tree-not-found case) and
  their `sweep.live` cascade case.
- The mint-policy claims (`validateMintTitle`, `writeGuard.ts`) —
  wording only; the facts themselves (the `normalizeDocTitle` 512-rune
  truncation bound, the `/` path-separator rule) moved down as
  `mintTitleProblem` in the primitives' `/write` entry (`rootEcho`
  promotion template), falsified by the primitives title round-trip and
  their own unit suite; the rejection set remains a superset claim over
  `normalizeDocTitle`, pinned live by the same round-trip.
- The synchronous-move-rejection fact — the kernel rejects ancestor moves
  synchronously ("Cannot move to this location", doc-level record, no echo
  tail) — moved down with `moveDocVerified` (primitives `move.ts`); the
  doc-level move record shape (outline + title/hpath echo, no
  anchor/newBlockId/destOutline) stays tool-side wording. Falsified by the
  primitives' `move.live` (ancestor-move case).
- The hpath-rebuild fact — `blocks.hpath` is a derived column the index
  rebuilds asynchronously after `moveDocsByID` (still the pre-move value
  immediately after the move), so the landed judgment and the echoed hpath
  ride the live tree — moved down with `moveDocVerified`. Falsified by the
  primitives' `move.live` (the SQL-lag pin).
- The search-window fact — the kernel shares one `pageSize` window across
  every `paths` entry of a full-text search call, so a hit-rich KB fills
  the pre-filter window and silently drops the other KBs' matches — moved
  down with `searchBoxes` (primitives `search.ts`); the tool side owns only
  the resolve/echo/spill around the per-box fan-out. Falsified by the
  primitives' `search.live` (shared-window premise + per-box strategy).
- The delete-cascade fact — the kernel's cascade removes a container
  member's descendants with it, so the sweep deletes only the enumerated
  members — moved down with `sweepSectionMembers` (primitives `sweep.ts`);
  the call-site comment in `writeReplaceSection.ts` is a summary kept for
  the pre-enumeration rationale, and the sweep's partial-apply envelope
  wording (byte-identical receipt, do-not-retry guidance) stays tool-side.
  Falsified by the primitives' `sweep.live` (cascade case).
- The `kb_query` description claims (`tools.ts`, `QUERY_DESCRIPTION`) —
  agent-facing wording: `sort` is a block-type weight, not display order
  (document order comes from the outline or the anchor ids), and `hpath`
  is a derived display label, never an address. Wording pinned by the
  local unit suite (`tools.test.ts`); the semantics ride the primitives'
  walk suites.
- The `kb_read` description claims (`tools.ts`, `READ_DESCRIPTION`) —
  agent-facing wording over the placement module's notation: the
  `(not targetable)` marker and the `[unnamed]` fallback name the kernel's
  write-parent set (`TARGETABLE_CONTAINER_TYPES`, the primitives' shared
  targetable-container set consumed by both the section rule and the
  notation's glyph table). Wording pinned by the local unit suite
  (`tools.test.ts`); the semantics ride the primitives' outline suites.
- The DML-through-the-query-endpoint fact — since 3.8.4 DML via the query
  endpoint is a silent no-op in every mode (code 0, row untouched), so the
  endpoint is no longer a mutation vector and the tool still rejects DML
  by shape. Pinned by the primitives live suite (silent-DML no-op case,
  `writePins.live`); the tool-side shape rejection is pinned locally
  (`tools.test.ts`).
- The breaker-floor and probe/cooldown comments (`gate.ts`) — the local
  cooldown is the barrel's `authLockDodge` reducer (trip threshold 3 held
  in reserve under the kernel's 6-failure per-IP lock, floor
  `authLockSeconds(6)`, monotonic deadline extension), held as session
  state by `breaker.ts`; a `getVersion` probe is unauthenticated so it
  never counts as breaker contact; a 429 arms the local cooldown, and any
  call inside an active lock extends it. Schedule and dodge falsified by
  the primitives' unit suite plus `throttle.live`; the extension's half
  (holder wiring, the genuine-class seam) by the local unit seam suite
  (`breaker.test.ts`).

If an entry here ever grows executable dependence on a pinned behavior, move
the code down into the primitives (the `rootEcho` promotion is the template) —
do not lengthen the list. Sole deliberate exception, narrowed: the
fresh-content judgment's comparison-and-both-reads half moved down
(`checkFreshContent`, the primitives' read barrel), but the tool-side seed
sites' reliance on the walk ≡ SQL equivalence remains — the exception
survives as a qualified cross-boundary property, recorded in that entry.

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
  (`__tests__/unit/writeHarness.ts` is the one `kb_write` setup).
- The version-pinned behaviors (walk order/parentage, verdict primitives,
  the walk ≡ SQL content pair behind the fresh-content judgment,
  auth-lock schedule, live title round-trip, the move facts, the delete
  generation and delete-cascade facts) are falsified by the primitives
  repo's own unit + live suites; this repo's suites exercise them
  transitively and are never the sole falsification of a pinned fact. The
  replace-section and append live cases here pin only tool-surface behavior
  (envelope wording, partial-replace receipts, insert-before-delete ordering
  through the gate), not kernel facts.
- The integration suite needs a live SiYuan 3.8.4 kernel and self-skips
  (`describe.skipIf`) unless `SIYUAN_INTEGRATION=1`. It mints two disposable
  notebooks per run and asserts teardown leaves no strays — point it at a
  kernel you can safely mutate, never CI.

## Roadmap (parked)

- RAG / vector sidecar (v2 primary): a third consumer of the primitives read
  barrel — fed by the barrel's `docMarkdown` (the promoted `exportMdContent`
  read)/`query/sql`, never a second writer; it
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
