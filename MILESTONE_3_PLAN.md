# Milestone 3 Plan — KB Extension

Implements the M3 row of DESIGN_v2.md §11: *KB extension — tool set, `kb` param
validation, `/kb` command (on/off toggles incl. `all`, scope, chat state via
`appendEntry`), interactive write confirmation.*

Everything here is extension-side (`gnubrain`). The client (`siyuan-kernel-api@0.3.0`,
exact pin) exposes every kernel method M3's runtime paths need — `getVersion`,
`listNotebooks`, `query` (readonly-only; the client hardcodes `mode:
"readonly"` on the wire), `search`, `exportMarkdown`, `getChildBlocks`,
`createDocWithMarkdown`, `insertBlock`/`appendBlock`/`updateBlock`/`deleteBlock`/`moveBlock`,
`removeDocByID`, `moveDocsByID` — plus the notebook/doc lifecycle methods
(`createNotebook`, `removeNotebook`, `renameNotebook`, `renameDocByID`,
`listInvalidBlockRefs`) and the encrypted-notebook family
(`createEncryptedNotebook`, `getEncryptedNotebookStatus`,
`unlockAndOpenNotebook`; locking an encrypted box is `closeNotebook`'s job),
all shipped in 0.2.0–0.3.0 and gating Sprint 5b (its raw-helper list shrinks
accordingly). Any further gap is a deliberate, recorded change to that repo.
(Naming note: the client method is `exportMarkdown`, wrapping the kernel's
`exportMdContent` endpoint — both names appear below.)

Design references below are §-sections of DESIGN_v2.md. Every sprint ends green:
`npm test`, `npm run typecheck`, `npm run lint`.

---

## Sprint 1 — Session chassis (validation, scope resolution, resilience, envelope)

The machinery every tool call routes through. No tools registered yet.

1. **Startup validation pipeline (§5 validation order)** — steps 2–3; the
   core step-1 shape check incl. the global-file `defaultKBs`-against-`kbs`
   check already lives in `settings.ts` (M1 tests cover it); Sprint 1 adds
   only the project-file `defaultKBs`-vs-global-`kbs` composition named in
   item 4. Per §5 step 1, a shape-check failure **degrades** the session —
   every tool call is rejected with the problem named, not a crash (the
   tools-stay-registered half of the behavior is asserted in Sprint 3, the
   first sprint that registers tools; S1 asserts the degrade flag + rejection
   gate itself):
   - Kernel probe at `session_start` via `getVersion()`; extension-owned
     `PINNED_SIYUAN_VERSION = "3.8.3"`, strict full-version match; writes
     fail-closed on drift, reads warn-and-proceed; verdict cached for the session.
   - `listNotebooks()`: stale notebook ID → warn + drop from valid set;
     `encrypted: true` → reject the KB at startup, one branch for both lock
     states. Token failures here feed the breaker (below).
   - Unreachable kernel → degraded session: tools (once they exist) register,
     reads error per-call, every write first retries the probe per write
     attempt, still-failed → `refused`. Reads never gate on the cached
     unreachable verdict — each read attempts the kernel call and errors on
     failure — so once the kernel is reachable again the next read succeeds
     with no recovery step (§5's reads-recover-per-call rule; only `/kb`
     recovery clears the degraded flag, reads just stop erroring).
2. **Error envelope (§5)** — one shared helper:
   `{status: ok | near_matches | duplicate | error | refused, message, ...payload}`,
   with `truncated`/`post_filtered` as payload markers, never statuses; per
   §5's success-echo contract, every success result echoes the resolved KB
   name (single-KB calls) or names (multi-KB calls) — spelled out per tool in
   S3 items 2–3 here, and part of the S5 write-result contract.
3. **`kb` param contract (§5)** — required on every call; array on `query` and
   `search` (the multi-scope sweep tools), exactly one name on `read` and every
   write; unknown / not-in-scope / empty-array rejections with the pinned
   messages (empty array refused locally, no kernel call).
4. **Scope resolution (§5)** — latest `kb-scope` `appendEntry` wins, else
   `defaultKBs`; project file wins over global for `defaultKBs`; `kbs` +
   connection keys read from the global settings file only. Absent key = empty
   set, never activate-all. Composition with the existing single-object
   validator: the full `validateGnubrainSettings` run applies to the global file
   (the only file carrying `baseUrl`/`apiToken`/`kbs`); the project file supplies
   `defaultKBs` names only, checked against the global `kbs` set, with two
   failure classes matching §5's existing precedents (the project file is never
   run through the full validator):
   - **Shape failure → degrade**: `defaultKBs` present but not an array of
     strings → session degrades (§5 step 1's rule; identical to how the global
     file behaves), reusing the existing message verbatim
     ("defaultKBs must be an array of KB name strings"). Same class for a
     project `gnubrain` object containing any key other than `defaultKBs` —
     a stray `kbs`/`baseUrl` in a project file is rejected loudly, never
     silently ignored (message names the unexpected key). (`allowUnattendedWrites`
     and `writeConfirmTimeout` are also global-only, §5 — user-owned attention
     dials, not per-project defaults a project file may lower.)
   - **Unknown name → warn loudly, drop, keep the valid rest** (§5's
     stale-notebook precedent: warn and drop, never a crash): a project
     `defaultKBs` naming a KB absent from the global `kbs` set warns at
     startup and removes that name from the resolved set, keeping any valid
     siblings; it never falls back to the global `defaultKBs` — dropping
     names can only shrink scope, a fallback could silently expand it.
5. **Circuit breaker + 429 cooldown (§5)** — 3 consecutive 401/403 → degraded
   fail-fast, zero kernel calls from tool calls; 429 never counted, never
   retried, arms a local cooldown deadline (`now + Retry-After`, floor 60 s);
   recovery via the `/kb` re-check hook applies to the breaker only — the 429
   cooldown self-heals on expiry, §5 pins no `/kb` recovery for it
   (dispatch point in place now, subcommands land in Sprint 2).
6. **Status bar slot (§5)** — `ctx.ui.setStatus`, try/catch-guarded; severity-first
   precedence: unreachable/never-probed → red/grey, degraded config → yellow, healthy →
   dot color carries the tool capability (§5: writes on → success/green, else reads on →
   accent/blue, else `○ kb` hollow; slot text stays `● kb: <scope names>`, never changes
   with capability — the portal `fg(learn ? "success" : "accent", "●")` pattern). Sprint 1
   renders hollow — no toolsets registered yet; Sprint 3's read toolset brings the blue
   branch, Sprint 5's write toolset the green branch + repaint on
   `TOOLSET_EVENTS.changed`/`restored` (and after `session_tree` restore, §5). Glyph state reads live toolset state, so any
   disabler (our toggle, `toolsetDefaults` settings pins, allowlist mode, external
   managers) is reflected (§5). Cleared on `session_shutdown`. Degraded-config causes
   share the yellow glyph and branch a two-word cause tag in the slot text, first match
   wins in severity order: shape failure → `● kb: config`, tripped breaker →
   `● kb: breaker`, version drift → `● kb: version`; `/kb` names the full problem (§5).

### Acceptance criteria

- [ ] Unit: validation order shape → probe → notebooks, incl. encrypted-notebook
      rejection for both lock states (mocked `listNotebooks`; kernel endpoint
      `lsNotebooks`), stale-notebook drop, project/global read path, token-failure
      branch, shape-check failure degrading the session (degrade flag set, calls
      rejected with the problem named — not a crash; the tools-stay-registered
      clause is asserted in Sprint 3, S1 registers no tools),
      project-file validation — non-array `defaultKBs` and a stray non-`defaultKBs`
      key both degrade the session with the message naming the problem
      (pinned message reused verbatim for the shape case; unexpected key named
      for the key case), `writeConfirmTimeout` read from the global file only
      (classified global-only per item 4; §10 pins the validation order).
- [ ] Unit: version-gated write refusal fails closed; per-write-attempt probe
      retry; degraded-session read errors; post-recovery read succeeds with no
      recovery step (reads bypass the cached unreachable verdict, §5).
- [ ] Unit: breaker — 3 consecutive auth failures → degraded, request log shows
      zero further kernel calls; recovery clears it; 429 → no breaker increment,
      no retry, local cooldown refusal with zero kernel round-trips, post-expiry
      call succeeds (§10; the 429 branch is exercised with a genuine
      `SiYuanRateLimitError` instance, not a synthetic 429 shape; the 429
      never increments the consecutive count (§5's pin) and never resets it —
      an inferred consequence of §5's "any successful authenticated call resets
      the counter" rule, not a separately pinned property — both unit-only;
      Sprint 6's live checklist deliberately does not stage it (§10).
- [ ] Unit: `kb`-param rejections incl. empty array (no kernel call, activation
      path named); envelope shape (§10).
- [ ] Unit: scope resolution `persisted → defaultKBs`, incl. absent-key → empty
      set, and the project/global validator composition above — incl. project
      `defaultKBs` naming an unknown KB: loud startup warning, name dropped,
      valid siblings kept, no fallback to the global `defaultKBs`; status-slot
      rendering headless-safe, incl. the degraded-config glyph and the
      per-cause tag branch (shape → `config`, breaker → `breaker`, drift →
      `version`, first match in that order) and the healthy-state capability
      ladder (hollow in S1 — no toolsets yet; the blue/green branches land in
      Sprints 3 and 5) with degraded/beaten precedence over the healthy colors
      (§10).

---

## Sprint 2 — Scope state + `/kb` command

Scope persistence and the mid-session activation vehicle.

1. **Scope persistence (§5)** — `pi.appendEntry("kb-scope", ...)` writes a full
   snapshot of the active set; read on `session_start` (latest entry wins).
2. **`/kb` command (§5)** — bare `/kb` prints scope; `/kb <name> on|off`
   single-name idempotent toggle; `/kb all on|off` set-wide form (empty set on
   `all off`; zero-valid-KB no-op reported); reserved keyword `all` (§10 groups
   the name-level rejection under `/kb` toggle writes; we assert it at the
   settings layer instead — already covered by the pre-existing M1 tests in
   `settings.test.ts`, a deliberate relocation — so the S2 test exercises the
   `/kb` subcommand dispatch of `all` only); verbless `/kb <name>` prints
   usage.
3. **Recovery hook (§5)** — every `/kb` dispatch re-runs the full validation pass
   (settings re-read — both the global and project files, so corrected
   credentials and `defaultKBs` edits take effect mid-session — shape, probe,
   `lsNotebooks`) before subcommand dispatch;
   success clears degradation + breaker counter; failure re-engages
   all-or-nothing.
4. **Headless dispatch** — verified for real in Sprint 5b (`/kb all off` from
   `pi -p`); no handler-side headless check (§5 headless bound).

### Acceptance criteria

- [ ] Unit: toggle writes — bare `/kb`, verbless usage output, idempotent
      re-toggle, `/kb all on` activates the full valid set, `/kb all off`
      empty-scope write, zero-valid-KB no-op, `/kb all`
      subcommand dispatch, unknown-name toggle rejection (validates against
      the config array with the same rejection message as the tool param,
      §5). The settings-level `all`-name and name-grammar rejections are
      already covered by the pre-existing M1 tests in `settings.test.ts` —
      deliberate relocations: a KB whose name violates the grammar can never
      be configured, so no toggle-path leg exists for either.
- [ ] Unit: scope entry is a complete post-toggle snapshot; resume/fork read
      rule unchanged.
- [ ] Unit: recovery — corrected token + `/kb` dispatch re-runs validation,
      clears degraded flag; failed re-check re-engages degradation without
      looping (§10).
- [ ] Unit: the S1 `kb`-param validator reads the live post-toggle scope at
      call time (asserted against a stub tool here; tool-level composition
      deferred to Sprint 3, asserted with the real read tools).

---

## Sprint 3 — Result budgets + read tools (query / search / read)

Registered tool names per §2/§3 of DESIGN_v2: `kb_query`, `kb_search`, `kb_read`
(the flat pi tool namespace collides with the builtins `read`/`write` — a same-name
registration silently overrides the builtin — so every tool carries the `kb_` prefix;
short names below are internal labels). The write tool's registered name (`kb_write`)
lands with Sprint 4.

The discovery half of the loop. Adds the new runtime dependencies:
`node-sql-parser@5.4.0` and `pi-tool-masking@1.3.0` (both exact-pinned).

1. **Spill/budget helper (§3)** — the four constants (`SPILL_DIR`,
   `PREVIEW_CHARS` 8000, `OUTLINE_HEADINGS` 200, `RESULT_LIMIT` 64) and one
   helper: per-session temp dir `os.tmpdir()/gnubrain/<session-id>/`, SHA-256-16hex
   hash names, JSONL vs `.md` spill formats, newline-boundary preview +
   `… N more — full result in <path>`, no cleanup machinery.
2. **query tool (`kb_query`, §3)** — parser certification (single top-level SELECT, DML /
   multi-statement / FROM-allowlist / JOIN / subquery / CTE / UNION / bare
   `HAVING` rejection — §3 pins the bare-`HAVING` rule even though §10's unit
   list omits it; keyed on the executed spike findings: `Array.isArray` for
   multi-statement, `_next`/`set_op` for UNION); AST rebuild: splice `box IN (...)`, inject LIMIT
   64 iff AST shows none, serialize, **re-parse and verify**, execute the
   re-parsed statement through the client's readonly-only `query()` (the
   client hardcodes `mode: "readonly"` on the wire — 0.3.0 dropped the
   parameter, readonly is the contract); agent-supplied LIMIT passes
   through uncapped; post-filter backstop (box-less aggregate rows exempt);
   truncation marker counts post-filter rows; results echo resolved KB names +
   injected box IDs.
3. **search tool (`kb_search`, §3)** — per-KB fan-out (one kernel call per resolved KB,
   `paths: [<boxId>]`, `pageSize = RESULT_LIMIT`), merged results in per-KB
   kernel order, aggregated truncation marker; same post-filter backstop as
   query — merged rows dropped unless `box` ∈ resolved set → `post_filtered:
   true`, truncation marker counts post-filter rows (search rows always carry
   `box`, so no aggregate exemption; the drop path is unreachable against a
   well-behaved kernel, hence mocked-only testing per §10); `method: 0`
   tool-owned, agent
   `method`/`types`/`orderBy`/`groupBy` rejected at the tool schema (the client
   already hardcodes `method: 0` and exposes no aux params), aux params
   omitted entirely; echo contract per row (`id`, `root_id`, `hpath`, `box` →
   resolved KB name, `updated` — `root_id`/`hpath` are renamed from the
   client's `rootID`/`hPath` (client `SearchBlock`), never echoed raw).
4. **Tool descriptions (§5, §3)** — the **query** tool description carries the
   pinned content (§5 pins it there specifically): `refs`/`blocks` table schemas
   with the two semantics notes (`sort` is a type weight, `hpath` is
   display-only) and the include-`hpath` discovery pattern; the other read
   tools may carry a shorter pointer. Write-tool doctrine lines ("mint by title… consume by
   ID", search ownership constraints) are authored with the write tools in
   Sprints 4–5, not deferred.
5. **read tool (`kb_read`, §3)** — `exportMarkdown` (GFM only, never `getDoc`; kernel
   endpoint `exportMdContent`); ownership
   query doubles as scope check (`SELECT root_id FROM blocks WHERE id = ? AND
   box = ?`); outline ride-along via the documented `getChildBlocks` walk
   (heading filter for rendering only, full unfiltered ID set retained for write
   verification; extension-owned recursion depth bound); `OUTLINE_HEADINGS` cap
   with spill of the full outline.
6. **Read toolset (§5 tool-masking record)** — `defineToolset(pi, { id:
   "gnubrain.read", names: new Set(["kb_query", "kb_search", "kb_read"]),
   persistKey: "toolset-state:gnubrain.read", defaultEnabled: true })`
   (pi-tool-masking's `ToolsetSpec.names` is a `Set<string>`, not an array); no
   toggle subcommand
   (§5: nothing asks to hide reads yet) — the toolset exists so the surface is
   declared and maskable from day one, default behavior unchanged. Status bar:
   healthy dot turns accent/blue once this toolset is active (hollow before).

### Acceptance criteria

- [ ] Unit: parser certification matrix — DML, multi-statement, FROM-allowlist
      violation (plain wrong table incl. comma cross-join), CTE shadow
      (`WITH blocks AS …`), subquery, UNION, JOIN, bare
      `HAVING` (§10; the `HAVING` leg per §3's policy, which §10's list omits).
- [ ] Unit: injected-predicate re-parse — OR precedence, round-trip parity for
      escaped quotes / LIKE backslash escapes / clause keywords in strings /
      non-ASCII literals; LIMIT presence off the AST; `||`-containing statement
      keeps the injected LIMIT; agent LIMIT passthrough (§10).
- [ ] Unit: post-filter — box-less aggregate rows skip the backstop; truncation
      fires when `kept + dropped` reaches the limit (§10).
- [ ] Unit: search post-filter — out-of-scope rows dropped, `post_filtered:
      true`, truncation marker counts post-filter rows (§10: contaminated input
      is only constructible in the mocked suite; live integration pins the
      shape only — zero out-of-scope boxes, no flag).
- [ ] Unit: search rejects agent-supplied `method`/aux params (tool-schema
      assertion); fan-out issues N calls with per-call `pageSize`; single-KB
      degenerates to the single-call shape (the fan-out/degeneration policy is
      §3's record — §10's unit list only pins the method/aux rejection; §10's
      two-KB saturation case is the live pin for the fan-out only, degeneration
      stays unit-only).
- [ ] The query tool description contains the §5-pinned table schemas +
      semantics notes and the include-`hpath` discovery pattern.
- [ ] Unit: spill — inline-cut/preview/per-session-dir/no-cleanup; outline cap
      inlines first N lines + pointer while verification runs on the full walk
      set (§10).
- [ ] Unit: `read` on a `docId` from another KB returns no rows — the ownership
      query doubles as the scope check (§4; §5 tool shape).
- [ ] Unit: read toolset registered with the three `kb_` read tools as members,
      default-enabled, persist key `toolset-state:gnubrain.read` (§5).
- [ ] Read tools callable from a real pi session against the live kernel
      (manual smoke); tool `kb` validation composes with the live post-toggle
      scope mid-session (Sprint 1's `kb`-param validator fed by Sprint 2's
      scope, now asserted through real tools). Two separately-scoped
      assertions: (a) the S1 shape-check degradation clause deferred from
      Sprint 1 (degraded session → tools stay registered, calls rejected with
      the problem named) — needs only S3's own registered tools, runs with S3;
      (b) the live post-toggle-scope composition — **gated on Sprint 2**, it
      consumes S2's persisted scope and runs after S2 lands; the rest of
      Sprint 3 stays parallel with S2.

---

## Sprint 4 — Write-back part 1: confirmation + create flow

The highest-stakes path, split across two sprints. This sprint: the
confirmation gate and the `create` flow end to end. Registered name
`kb_write` (§4 schema table pins the param shape: `kb`, `mode`, `markdown` XOR
`markdownFile`, mode-specific targets).

1. **Write confirmation (§5)** — `pi.ui.confirm` always on for interactive;
   headless (`pi -p`) default-deny unless `allowUnattendedWrites: true` (the
   dialog is skipped; the write proceeds unattended);
   RPC is not headless; every confirm carries `writeConfirmTimeout` (default
   60 s, `0` = indefinite), every non-answer resolves to `refused`; timeout
   expiry = `confirm_timeout`, terminal for that write in that session (re-request
   → immediate refusal, no new dialog); explicit decline stays recoverable.
   Timeout mechanism: pi's `ui.confirm` resolves to a bare `boolean` and its
   native dialog auto-dismisses on timeout, making a timed-out dialog
   indistinguishable from a decline — so the extension owns the timeout clock
   (race an extension-side timer against the confirm promise; `confirm_timeout`
   only when the timer wins; the native `timeout` option may be passed for UI
   countdown only, and only omitted or set ≥ the extension timer — a shorter
   native timeout auto-dismisses the dialog and resolves `false` first, which
   would misclassify a real timeout as an explicit decline), never inferring
   timeout from a `false` resolution.
2. **File-path input (§4)** — `markdown` XOR `markdownFile`; file read once at
   call start, the captured string drives guard → confirm → kernel → verify;
   missing / not-a-regular-file / unreadable → structured error naming the
   path, no kernel call (§4 trust posture: "must exist, must be a regular
   file", no path allowlisting); both/neither → shape error.
3. **Title guard (§4 R3)** — exact leg (`LIKE`, pattern from HTML-escaped title,
   `%`/`_` LIKE-escaped) then near-match scan (space/hyphen/underscore prefix
   variants, capped at 20 rows with `truncated` marker); single-notebook scope.
4. **Mint policy (§4)** — trim; reject empty / `/` / >512 runes /
   tab-newline-control with structured rephrase-hint errors; HTML-special chars
   mint normally via escape parity; submission path built from ground truth
   (top-level `/<title>`; nested via stored parent hpath + `parentID`); no
   `confirmNew` in the declared schema.
5. **Verified-create (§4 R3)** — by-ID asserts on the kernel-returned root ID;
   nested asserts re-read the parent and compare child hpath against the
   read-back stored title (ground truth, never the submitted title); stale
   parent → fail-loud structured error.
6. **Guard stops (§4)** — one uniform `duplicate` stop for exact-leg rows,
   single- or multi-row alike (per §4 step 1 with step 3's fold — a single exact
   match is the same decision the agent faces, write into it or mint a
   conscious sibling):
   all rows with `updated` + budgeted outlines + per-row full-markdown spill
   paths (grep-able side-by-side candidates; a single-row response
   additionally echoes block IDs so the agent can go straight to `edit` by
   blockId) + `stagedPath` draft staging for inline bodies; the message names
   the docIds and the `confirmNew: true` exit. `near_matches` stays
   excerpt-only — name variants are already the clue and the 20-row cap
   bounds the count: candidates (docId, title, first paragraph, `updated`),
   `stagedPath` draft staging, and the `confirmNew` message;
   `confirmNew: true` bypasses both legs, confirmation + verified-create
   still apply.

### Acceptance criteria

- [ ] Unit: guard — exact leg matches ASCII-cased variants and HTML-special
      titles via escape parity; near-match legs incl. the underscore leg; 20-row
      cap + marker; `confirmNew` skip path; the unified exact-leg stop
      (single-row and multi-row both return all rows + per-row spill paths;
      single row adds the block-ID echo); param absent from the declared tool
      schema (assert on the schema object) (§10).
- [ ] Unit: mint-policy rejections — each with its message; verified-create
      asserts incl. simulated stale parent failing loud (§10; §10's
      guard→create race leg is deliberately folded here rather than given its
      own case — it is only reachable in the mocked suite and its duplicate
      lands in the accepted reconcilable class, §4 R3/R4, so verified-create's
      by-ID asserts are all that observes it).
- [ ] Unit: write-confirmation branches — allow/refuse; cancelled and timed-out
      confirms both refuse; `confirm_timeout` terminal (confirm mock fires
      exactly once across both calls); explicit decline recoverable; timeout 0
      issues an untimed confirm (§10).
- [ ] Unit: headless write default-deny (§5) — no-UI session with
      `allowUnattendedWrites` absent or false → `refused` naming the enabling
      setting, zero confirm calls and zero kernel calls on the request log;
      `allowUnattendedWrites: true` → the write proceeds unattended (dialog
      skipped per item 1).
- [ ] Unit: file-path input — missing file → error, zero kernel calls (request
      log); read-once capture under mid-flow file mutation; XOR shape
      validation (§10).
- [ ] Unit: guard-stop staging — `stagedPath` in the session spill dir,
      byte-equal content, `markdownFile` retry message; exact-leg stop spills
      each matching doc's markdown with per-row paths; near-match candidates
      stay excerpt-only (no candidate spill); no staging when the
      body already came from a file or on non-guard stops (§10).

---

## Sprint 5 — Write-back part 2: remaining modes + write-result contract

1. **Modes (§4)** — `edit` (`updateBlock` on agent-supplied `blockId` target),
   `append` (tool-derived `nextID = next heading` anchor; final section →
   `appendBlock` on doc root), `replace-section` (one call: walk-enumerated
   delete set via `getChildBlocks` document-order walk — never SQL;
   insert-before-delete with the same anchor rule as `append` (`insertBlock`
   `nextID` = next heading's ID, or `appendBlock` on the doc root for the
   final section — headings are leaves, bare `parentID` is rejected);
   same-or-shallower boundary; final section sweeps trailing content), `delete` (block or `doc: true` via `removeDocByID`;
   backlink check over the walk set in the confirmation), `move` (block-level
   with tool-derived destination anchor from the destination outline — last top-level
   node of the `toHeadingId` section (heading-recursed), end-of-section semantics
   identical to `append`; heading-anchored placement rejected as fold-state-dependent
   per §4 anchor rule; omitted `toHeadingId` → destination doc end
   (`appendBlock`-on-root fallback, same default as `append`); `doc: true` via
   `moveDocsByID`; self-descendant pre-check; intra-KB by
   construction; doc-level move also covers the un-nest case (`toDocId`
   omitted → `toID` = notebook ID). Anchors always tool-derived; targets
   agent-supplied from echoed data.
2. **Write-result contract (§4)** — every doc-targeting result carries root
   `docId`, stored title, real `hpath`, fresh `outline` (cap applies to inline
   rendering only), `anchor` where placement-bearing, `newBlockId` extracted
   from `data[0].doOperations[0].id`, `invalidRefs` on delete-bearing writes;
   cross-doc block `move` adds `destOutline` + `movedBlockId`.
3. **Stale-target verification (§4)** — verified, not trusted: `newBlockId` /
   `movedBlockId` must appear in the post-write unfiltered walk-set diff
   (multi-block bodies: diff-based; single-block: exactly one ID); `updateBlock`
   errors surface verbatim; `delete` no-op reports success with walk-set
   evidence; silent rollbacks → `{status: error}` with fresh outline attached.
4. **Fresh-content precondition (§4)** — baseline content hash per targeted
   block (served content, or confirmation-displayed current content when none
   served); re-check after confirmation approval, before the kernel call;
   mismatch → `stale_content` refusal with current content + fresh outline, no
   kernel write. Scope: `edit` and `replace-section` only.
5. **Write toolset + toggle (§5 tool-masking record)** — `defineToolset(pi, { id:
   "gnubrain.write", names: new Set(["kb_write"]),
   persistKey: "toolset-state:gnubrain.write",
   defaultEnabled: true, requires: ["gnubrain.read"] })` — the pi-tool-masking
   dependency cascade makes write-without-read unrepresentable (enabling writes
   auto-enables reads; disabling reads cascades to disable dependents; settings
   pins resolve through the cascade too). Extends Sprint 2's `/kb` dispatcher
   with the `writes` reserved keyword: `/kb writes on|off` toggles the toolset
   (idempotent no-ops reported, same semantics as KB toggles); bare `/kb` output
   gains the toolset state line; `settings.ts`'s `RESERVED_KB_NAMES` gains
   `writes` (M1 validator + test updated — a KB named `writes` becomes
   unconfigurable, same relocation as `all`). Status-bar integration: the
   healthy dot turns success/green when the write toolset is enabled and back
   to accent/blue (or hollow if the read toolset is also masked — e.g. a
   `toolsetDefaults` pin) on mask, repainting on `TOOLSET_EVENTS.changed`/
   `restored` so `/kb writes on|off` recolors mid-session (§5 status-bar
   record; text unchanged — `● kb: <scope names>`).

### Acceptance criteria

- [ ] Unit: move-anchor derivation — end-of-section anchor on a plain section,
      nested-heading recursion (section ending in a subheading → after the subsection,
      not inside it), trailing list/quote container anchor (placement at section level,
      never nested into the container); fold-state independence (folded destination
      heading does not change the anchor); same-doc move derives the anchor from the
      already-in-hand outline (no extra kernel call) (§10).
- [ ] Unit: replace-section call order — mocked suite asserts insert precedes
      delete; failed delete after successful insert leaves duplication, never
      loss (§10).
- [ ] Unit: stale-target verification — insert with `newBlockId` absent from the
      post-write walk set → `error`; edit kernel error verbatim; delete no-op
      success with walk-set evidence; cross-doc move missing from destination
      walk set → `error` (§10).
- [ ] Unit: fresh-content precondition — baseline from served content;
      no-baseline fallback reads + displays current content and approval
      establishes the baseline; post-approval change → `stale_content` refusal,
      zero kernel write calls on the request log; matching re-check proceeds;
      replace-section baselines the delete set and the confirmation displays
      it (§10).
- [ ] Unit: confirmation for a final-section replace displays the enumerated
      delete set's block count + the trailing blocks' current content + inbound-ref
      count and referring hpaths;
      delete-bearing results carry `invalidRefs` (§10).
- [ ] Unit: write-result shapes — doc-level `delete` carries only
      `invalidRefs`; doc-level `move` carries outline + title/hpath echo, no
      `anchor`/`newBlockId`/`destOutline`; same-doc move collapses to
      outline + anchor, with `movedBlockId` present (§10 pins it; §4 verifies
      every move via it).
- [ ] Write-tool descriptions carry the pinned doctrine lines ("mint by
      title… consume by ID", search ownership constraints) and the §4
      replace-first preference (prefer `edit`/`replace-section` over `append`;
      append is for genuinely new facts), completing the
      description work started in Sprint 3 item 4.
- [ ] Unit: write toolset declares `requires: ["gnubrain.read"]` — enabling
      writes cascades reads on; disabling reads cascades writes off; a
      `toolsetDefaults` write pin resolves through the cascade (write pin on +
      read unpinned → both active) (§5).
- [ ] Unit: status-bar capability colors — healthy + write toolset enabled →
      success/green, write masked + read active → accent/blue, both masked →
      `○ kb` hollow (incl. a masked read toolset — `toolsetDefaults` pin /
      allowlist mode — not only our toggle), text identical across healthy
      states; degraded (yellow) and unreachable (red) beat the healthy colors
      in the precedence ladder; glyph repaints on `TOOLSET_EVENTS.changed`/
      `restored` (§5).

---

## Sprint 5b — Integration suite (runs against live 3.8.3)

The §10 integration profile items M3's gate names, under the fixture policy
(two disposable notebooks per run, teardown via `removeNotebook`; never in CI;
execution order: search-shape first, throttle after all kernel cases, raw-DELETE
last). A test-only
raw-kernel-call helper (direct `fetch`) provides raw DELETE / the kernel
reindex trigger (raw-DELETE case) and the bogus-token arming requests. All
notebook/doc lifecycle calls (`createNotebook`, `removeNotebook`,
`renameDocByID` fixtures, `listInvalidBlockRefs`) **and the encrypted-notebook
machinery** (`createEncryptedNotebook`, `getEncryptedNotebookStatus`,
`unlockAndOpenNotebook`, lock-via-`closeNotebook`) ride the typed client
(`siyuan-kernel-api@0.3.0`, exact pin); the remaining helper calls — raw
DELETE, reindex trigger, bogus-token arming — stay raw: §10 deliberately keeps
those pins out of the client.

The encrypted-notebook case (item 12) runs on the **same kernel** as the rest
of the suite, gated behind the master password (opt-in via an env var such as
`SIYUAN_ENCRYPTED_PASSWORD`; the case self-skips when unset, same pattern as
`SIYUAN_INTEGRATION=1`). The workspace's key domain is already enabled — a
deliberate one-time user action taken through SiYuan's own UI — and the
extension never enables, disables, or manages encryption (that surface stays
out of the typed client by design, §10). Once enabled, encrypted and plain
notebooks coexist on one workspace (§4), so the case adds only disposable
fixture notebooks, not a second kernel: the typed client's
`getEncryptedNotebookStatus().enabled` is the precondition check,
`createEncryptedNotebook` mints the encrypted fixture (with one plain fixture
alongside it), and the ordinary typed `removeNotebook` tears both down — the
kernel's `RemoveBox` handles encrypted boxes directly (unmount + encrypted
index removal), so no workspace disposal or stray pre-registration is
involved. The case is not exempted as a special instance; it is a normal
kernel-dependent case, and the only ordering constraint is that it must not run
inside the throttle lock window (it needs the kernel), so it runs before the
raw-DELETE case like the rest.

1. **Title-guard kernel round-trip** — adversarial titles (tab rejected at
   mint; `A & B` / apostrophe titles mint and re-find via escape parity; clean
   titles store verbatim + expected hpath; kernel `renameDocByID` mid-test re-finds
   by new stored title).
2. **Nested-mint + duplicate-disambiguation cases** — nested create → echo →
   read → guard on re-create; stale-parent fail-loud; `duplicate` rows with
   outlines + per-row spilled markdown → `confirmNew: true` third mint →
   deletes → guard exact leg;
   guard-stop staging round-trip (§10): guard-stopped large-body create
   retried with `markdownFile: <stagedPath>` + `confirmNew: true` mints, and
   content read back matches the staged file.
3. **Tool-path verified-create** — pre-existing title → guard matches first, no
   create call fires, the existing doc's docId returned in the `duplicate`
   stop with the block-ID echo and its spilled markdown (§10).
4. **Version-refusal contract pin** — pin deliberately set to a version 3.8.3
   doesn't report → every write refused naming both versions, reads proceed;
   the override is per-test config, not a global constant mutation (§10), so
   it doesn't fight the setup's pin-equality assert.
5. **Stale-target contract pin** — kernel-deleted fixture block: edit error
   verbatim; append's walk-set assertion turns silent rollback into `error`;
   delete no-op with evidence; move synchronous `-1` surfaced (tree-level-miss
   branch mocked if no honest live route exists).
6. **Fresh-content live pin** — kernel-side content change between outline and
   edit → `stale_content` refusal, content untouched; control run applies.
7. **replace-section + delete-orphans end to end** — list/quote-ending section,
   final-section trailing sweep, heading ID survives, the §10 outline-ordering
   pin (headings in document order across a list/quote-ending section,
   re-asserted after the replace-section round-trip — the load-bearing
   freshness case where the superseded SQL outline provably broke), planted
   content-block ref
   orphans with `invalidRefs` echo; `updateBlock` preserves IDs
   (`listInvalidBlockRefs` zero, direct client call); doc-level `delete`
   backlink case (§10): confirmation
   surfaced the backlink count and referring hpaths, and ref reports come back
   invalid afterward; block-level `delete` orphan case (§10): planted ref to a
   single fixture block deleted via the tool → `invalidRefs` echo.
8. **move cases** — doc-level (`moveDocsByID`, IDs survive, echo, follow-up
   write by echoed docId, self-descendant rejected, depth-cap error verbatim,
   own-parent no-op), cross-doc block move (`movedBlockId` equality,
   `destOutline` freshness, provenance survives), same-doc shape pin.
9. **Search + query pins** — scoping shape, recall-loop echo assertion (a
   two-fixture search hit's row carries `root_id`, `box`, the per-row resolved
   KB name, and a non-empty `updated` matching `\d{14}`; `read` on that hit's
   `root_id` succeeds), two-KB saturation pin (fan-out),
   OR-precedence aggregate, `exportMarkdown` block-ID absence.
10. **Write-result freshness** — write-result `outline` matches a fresh
    post-write query; `refs` sync-flush pin; `newBlockId` response-shape pin;
    anchor-echo pin (§10): `append` onto a trailing-content-after-last-heading
    doc reports `anchor: appendBlock(root)`; anchor-placement pin (§10):
    `insertBlock` with `nextID=<next heading>` lands where the outline says —
    including a section ending in a list/quote (the AST-sibling nesting trap,
    §4) and the final-section `appendBlock`-on-root case; multi-block walk-set
    diff pin (§10): multi-block `append` → post-write walk-set diff contains
    every new ID with `newBlockId` among them, single-block → diff of exactly
    one ID.
11. **Headless `/kb` dispatch** — `/kb all off` from `pi -p` (converts the §5
    source-read claim into evidence before M4's harness depends on it).
12. **Throttle / raw-DELETE / encrypted-notebook cases** —
    ordered per §10 (read-consistency is covered by item 10's pins); throttle
    arming (6 bogus-token requests arm the lock — 6th still 401, 7th surfaces
    the distinct 429 — with `Retry-After`) reuses the
    client's opt-in profile (`SIYUAN_INTEGRATION_THROTTLE=1`), referenced not
    re-implemented; the extension-side cooldown leg rides the same armed lock:
    one kb read during the lock → 429 envelope, a second kb call inside the
    cooldown → local `refused` with zero kernel round-trips, then wait out the
    lock (bounded by the last served `Retry-After`, ~4 min — any call during an
    active lock extends it, §5; same profile as the client's throttle test) and
    assert the post-expiry call succeeds with no recovery step (§5
    self-healing expiry); the raw-DELETE case then runs on the expired backoff
    (§10 execution order) and follows the deletes with a kernel reindex to
    bound `siyuan.db` desync (§10). The encrypted-notebook case runs on the
    shared kernel, gated behind `SIYUAN_ENCRYPTED_PASSWORD` (see preamble):
    create the encrypted fixture (typed `createEncryptedNotebook`, which comes
    back mounted/unlocked) plus one plain fixture, then `lsNotebooks` reports
    the encrypted box `encrypted: true` → startup rejection names the KB for
    **both lock states** (unlocked as created; locked via typed `closeNotebook`
    — on an encrypted box it clears the cached key and closes the per-box db,
    re-openable with typed `unlockAndOpenNotebook` + the password — the §5
    one-rejection pin), the plain fixture validates clean alongside, and no
    kernel call from the encrypted KB's tools ever fires. Teardown is the typed
    `removeNotebook` for both fixtures, like every other case.
    The 429-does-not-count-toward-the-breaker property remains unit-only
    (Sprint 1).

### Acceptance criteria

- [ ] Setup asserts kernel version exactly equals the pin (accidental upgrade →
      red suite).
- [ ] All cases above green against live 3.8.3 under the fixture policy; the
      teardown itself is asserted (post-teardown notebook count back to
      baseline — zero strays).
- [ ] Execution order enforced (search-shape → others → throttle → raw-DELETE;
      encrypted case runs before raw-DELETE, never inside the throttle lock).
- [ ] Encrypted case: `lsNotebooks` on the shared kernel reports the encrypted
      fixture `encrypted: true` in both lock states → startup rejection names
      the KB while the plain fixture validates clean, zero tool kernel calls
      (§5 one-rejection pin, pinned live); the case self-skips with
      `SIYUAN_ENCRYPTED_PASSWORD` unset or the workspace not encryption-enabled.

---

## Sprint 6 — Gate checklist + residual manual items

Polish and the M3 gate (§11).

- [ ] Tools callable from pi (all four — `kb_query` / `kb_search` / `kb_read` /
      `kb_write` — in a real session; assert none shadows a pi builtin). Both
      toolsets registered default-enabled; `/kb writes off` removes `kb_write`
      from the active tool list (masked ≠ refused — no envelope, tool absent),
      `/kb writes on` restores it; state survives session resume (§5).
- [ ] Scope survives session restart (resume reads the persisted entry).
- [ ] `/kb <name> on` and `/kb all off` land mid-session.
- [ ] Write confirmation refuse/allow verified interactively.
- [ ] Auth breaker degrades after 3 consecutive auth failures (live): set a
      bogus token, issue 3 read calls (each errors), then a 4th — assert it
      returns `{status: refused}` with the breaker message, not an auth error
      (the observable signature of a local refusal vs a kernel round-trip; the
      zero-further-kernel-calls property itself stays pinned by Sprint 1's unit
      AC on the counting-fetch request log — no extension request log exists in
      a live interactive session), and that `/kb` recovery with the corrected
      token restores reads immediately (kernel-side leakage bound: a post-trip
      leak of ≥3 further failures would have armed the kernel's 6-failure lock
      and killed recovery too). The 429-count leg is
      unit-only (Sprint 1's 429 AC) — 5b item 12's throttle leg does wait out
      the kernel's per-IP lock and asserts post-expiry self-healing, but no
      live leg observes the breaker counter itself, so the count behavior
      (never incremented — §5's pin; never reset by 429s — inferred from §5's
      successful-call-reset rule) stays pinned by Sprint 1's unit
      AC (§5 breaker rule).
- [ ] Write-path integration suite green (Sprint 5b).
- [ ] Manual residual checklist started: write-confirmation allow/refuse in a
      TTY, status-slot visibility, RPC confirm sub-protocol check at first real
      RPC use (§10 residual list).
- [ ] README of `gnubrain` updated to describe the tool surface; DESIGN
      doc §11 M3 row marked done.
- [ ] If M3 code was split into new files: `package.json` `files` updated to
      include them (currently only `index.ts` / `settings.ts`; anything absent
      is dropped from `npm publish` in `scripts/release.mjs`).

Milestone 3 gate (from §11): all of the above; explicitly incl. the
title-guard kernel round-trip pin, the version-refusal contract pin, the
stale-target contract pin, and real headless `/kb` dispatch.

---

## Dependencies & ordering

```text
Sprint 1 (chassis) ──► Sprint 2 (scope + /kb) ─────────────┐
Sprint 1 (chassis) ──► Sprint 3 (read tools) ──────────────┼──► Sprint 5b (integration)
Sprint 1 (chassis) ──► Sprint 4 (confirm + create)
Sprint 2 (scope + /kb) ┄┄► Sprint 3 (final AC only: live post-toggle scope)
Sprint 2 (scope + /kb) ┄┄► Sprint 6 (gate: /kb mid-session, breaker recovery)
Sprint 3 (spill + outline helpers) ──► Sprint 4
Sprint 4 (confirmation gate, timeouts, file capture, confirmNew) ──► Sprint 5 (write modes)
Sprint 5 (write modes) ──► Sprint 5b (integration)
Sprint 5b ──► Sprint 6 (gate)
siyuan-kernel-api 0.3.0 (notebook lifecycle + encrypted family) ──► Sprint 5b
```

Sprints 2 and 3 can proceed in parallel once Sprint 1 lands (independent
surfaces; both touch the dispatch point, so the breaker/cooldown gate lands in
Sprint 1 and everything else inherits it), with one exception: S3's final AC
(tool `kb` validation composing with the live post-toggle scope mid-session)
is gated on Sprint 2 — it consumes S2's persisted scope and runs after S2
lands; the parallel split covers S3's build work itself. Sprint 5b also requires Sprint 2
(item 11's headless `/kb` dispatch) and Sprint 3 (items 9–10's read pins, on
top of the transitive S3 → S4 → S5 path), and the Sprint 6 gate needs Sprint 2
for the `/kb` mid-session and live-breaker-recovery checks. Sprint 4 needs Sprint 1's chassis
plus the spill helper **and the outline walk helper** from Sprint 3 (the
`duplicate` guard stop returns budgeted outlines per §4, and guard-stop draft
staging writes into the session spill dir) — sequencing S3's helpers first
keeps the parallel split clean. Sprint 5 is **not** parallel with Sprint 4:
every mode rides Sprint 4's confirmation gate, `writeConfirmTimeout`, file-path
read-once capture, and `confirmNew` handling.
