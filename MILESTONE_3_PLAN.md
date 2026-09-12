# Milestone 3 Plan — KB Extension

Implements the M3 row of DESIGN_v2.md §11: *KB extension — tool set, `kb` param
validation, `/kb` command (on/off toggles incl. `all`, scope, chat state via
`appendEntry`), interactive write confirmation.*

Everything here is extension-side (`pi-kb`). The client (`siyuan-kernel-api@0.1.0`)
already exposes every kernel method M3 needs — `getVersion`, `listNotebooks`,
`query`, `search`, `exportMarkdown`, `getChildBlocks`, `createDocWithMarkdown`,
`insertBlock`/`appendBlock`/`updateBlock`/`deleteBlock`/`moveBlock`,
`removeDocByID`, `moveDocsByID` — so no client work is planned; if a gap shows up
mid-sprint it is a deliberate, recorded change to that repo. (Naming note: the
client method is `exportMarkdown`, wrapping the kernel's `exportMdContent`
endpoint — both names appear below.)

Design references below are §-sections of DESIGN_v2.md. Every sprint ends green:
`npm test`, `npm run typecheck`, `npm run lint`.

---

## Sprint 1 — Session chassis (validation, scope resolution, resilience, envelope)

The machinery every tool call routes through. No tools registered yet.

1. **Startup validation pipeline (§5 validation order)** — steps 2–3; step 1
   (shape) is already done in `settings.ts`:
   - Kernel probe at `session_start` via `getVersion()`; extension-owned
     `PINNED_SIYUAN_VERSION = "3.8.3"`, strict full-version match; writes
     fail-closed on drift, reads warn-and-proceed; verdict cached for the session.
   - `listNotebooks()`: stale notebook ID → warn + drop from valid set;
     `encrypted: true` → reject the KB at startup, one branch for both lock
     states. Token failures here feed the breaker (below).
   - Unreachable kernel → degraded session: tools (once they exist) register,
     reads error per-call, every write first retries the probe per write
     attempt, still-failed → `refused`.
2. **Error envelope (§5)** — one shared helper:
   `{status: ok | near_matches | duplicate | error | refused, message, ...payload}`,
   with `truncated`/`post_filtered` as payload markers, never statuses.
3. **`kb` param contract (§5)** — required on every call; array on read tools,
   exactly one name on writes; unknown / not-in-scope / empty-array rejections
   with the pinned messages (empty array refused locally, no kernel call).
4. **Scope resolution (§5)** — latest `kb-scope` `appendEntry` wins, else
   `defaultKBs`; project file wins over global for `defaultKBs`; `kbs` +
   connection keys read from the global settings file only. Absent key = empty
   set, never activate-all. Composition with the existing single-object
   validator: the full `validatePiKbSettings` run applies to the global file
   (the only file carrying `baseUrl`/`apiToken`/`kbs`); the project file
   supplies `defaultKBs` names only, each checked for existence against the
   global `kbs` set — the project file is never run through the full
   validator.
5. **Circuit breaker + 429 cooldown (§5)** — 3 consecutive 401/403 → degraded
   fail-fast, zero kernel calls from tool calls; 429 never counted, never
   retried, arms a local cooldown deadline (`now + Retry-After`, floor 60 s);
   recovery via the `/kb` re-check hook (dispatch point in place now, subcommands
   land in Sprint 2).
6. **Status bar slot (§5)** — `ctx.ui.setStatus`, try/catch-guarded; glyphs per
   probe state; cleared on `session_shutdown`.

### Acceptance criteria

- [ ] Unit: validation order shape → probe → notebooks, incl. encrypted-notebook
      rejection for both lock states (mocked `lsNotebooks`), stale-notebook drop,
      project/global read path, token-failure branch (§10 unit list).
- [ ] Unit: version-gated write refusal fails closed; per-write-attempt probe
      retry; degraded-session read errors.
- [ ] Unit: breaker — 3 consecutive auth failures → degraded, request log shows
      zero further kernel calls; recovery clears it; 429 → no breaker increment,
      no retry, local cooldown refusal with zero kernel round-trips, post-expiry
      call succeeds (§10; the 429 branch is exercised with a genuine
      `SiYuanRateLimitError` instance, not a synthetic 429 shape).
- [ ] Unit: `kb`-param rejections incl. empty array (no kernel call, activation
      path named); envelope shape (§10).
- [ ] Unit: scope resolution `persisted → defaultKBs`, incl. absent-key → empty
      set, and the project/global validator composition above; status-slot
      rendering headless-safe (§10).

---

## Sprint 2 — Scope state + `/kb` command

Scope persistence and the mid-session activation vehicle.

1. **Scope persistence (§5)** — `pi.appendEntry("kb-scope", ...)` writes a full
   snapshot of the active set; read on `session_start` (latest entry wins).
2. **`/kb` command (§5)** — bare `/kb` prints scope; `/kb <name> on|off`
   single-name idempotent toggle; `/kb all on|off` set-wide form (empty set on
   `all off`; zero-valid-KB no-op reported); reserved keyword `all` (names
   already rejected in `settings.ts`, so the S2 test exercises the `/kb`
   subcommand dispatch of `all` only); verbless `/kb <name>` prints usage.
3. **Recovery hook (§5)** — every `/kb` dispatch re-runs the full validation pass
   (settings re-read, shape, probe, `lsNotebooks`) before subcommand dispatch;
   success clears degradation + breaker counter; failure re-engages
   all-or-nothing.
4. **Headless dispatch** — verified for real in Sprint 5b (`/kb all off` from
   `pi -p`); no handler-side headless check (§5 headless bound).

### Acceptance criteria

- [ ] Unit: toggle writes — bare `/kb`, verbless usage output, idempotent
      re-toggle, `/kb all off` empty-scope write, zero-valid-KB no-op, `/kb all`
      subcommand dispatch (the settings-level `all`-name rejection is already
      covered in Sprint 1's settings tests), name-grammar rejection (§10).
- [ ] Unit: scope entry is a complete post-toggle snapshot; resume/fork read
      rule unchanged.
- [ ] Unit: recovery — corrected token + `/kb` dispatch re-runs validation,
      clears degraded flag; failed re-check re-engages degradation without
      looping (§10).
- [ ] Unit: the S1 `kb`-param validator consumes the live post-toggle scope
      (tool-level composition is asserted with the read tools in Sprint 3).

---

## Sprint 3 — Result budgets + read tools (query / search / read)

The discovery half of the loop. Adds the one new runtime dependency:
`node-sql-parser@5.4.0` (exact-pinned).

1. **Spill/budget helper (§3)** — the four constants (`SPILL_DIR`,
   `PREVIEW_CHARS` 8000, `OUTLINE_HEADINGS` 200, `RESULT_LIMIT` 64) and one
   helper: per-session temp dir `os.tmpdir()/pi-kb/<session-id>/`, SHA-256-16hex
   hash names, JSONL vs `.md` spill formats, newline-boundary preview +
   `… N more — full result in <path>`, no cleanup machinery.
2. **query tool (§3)** — parser certification (single top-level SELECT, DML /
   multi-statement / FROM-allowlist / JOIN / subquery / CTE / UNION rejection —
   keyed on the executed spike findings: `Array.isArray` for multi-statement,
   `_next`/`set_op` for UNION); AST rebuild: splice `box IN (...)`, inject LIMIT
   64 iff AST shows none, serialize, **re-parse and verify**, execute the
   re-parsed statement with `mode: "readonly"`; agent-supplied LIMIT passes
   through uncapped; post-filter backstop (box-less aggregate rows exempt);
   truncation marker counts post-filter rows; results echo resolved KB names +
   injected box IDs.
3. **search tool (§3)** — per-KB fan-out (one kernel call per resolved KB,
   `paths: [<boxId>]`, `pageSize = RESULT_LIMIT`), merged results in per-KB
   kernel order, aggregated truncation marker; `method: 0` tool-owned, agent
   `method`/`types`/`orderBy`/`groupBy` rejected at the tool schema (the client
   already hardcodes `method: 0` and exposes no aux params), aux params
   omitted entirely; echo contract per row (`id`, `root_id`, `hpath`, `box` →
   resolved KB name, `updated`).
4. **Tool descriptions (§5, §3)** — read-tool descriptions carry the pinned
   content: `refs`/`blocks` table schemas with the two semantics notes (`sort`
   is a type weight, `hpath` is display-only) and the include-`hpath`
   discovery pattern. Write-tool doctrine lines ("mint by title… consume by
   ID", search ownership constraints) are authored with the write tools in
   Sprints 4–5, not deferred.
5. **read tool (§3)** — `exportMdContent` (GFM only, never `getDoc`); ownership
   query doubles as scope check (`SELECT root_id FROM blocks WHERE id = ? AND
   box = ?`); outline ride-along via the documented `getChildBlocks` walk
   (heading filter for rendering only, full unfiltered ID set retained for write
   verification; extension-owned recursion depth bound); `OUTLINE_HEADINGS` cap
   with spill of the full outline.

### Acceptance criteria

- [ ] Unit: parser certification matrix — DML, multi-statement, comma
      cross-join, CTE shadow (`WITH blocks AS …`), subquery, UNION, JOIN
      (§10).
- [ ] Unit: injected-predicate re-parse — OR precedence, round-trip parity for
      escaped quotes / LIKE backslash escapes / clause keywords in strings /
      non-ASCII literals; LIMIT presence off the AST; `||`-containing statement
      keeps the injected LIMIT; agent LIMIT passthrough (§10).
- [ ] Unit: post-filter — box-less aggregate rows skip the backstop; truncation
      fires when `kept + dropped` reaches the limit (§10).
- [ ] Unit: search rejects agent-supplied `method`/aux params (tool-schema
      assertion); fan-out issues N calls with per-call `pageSize`; single-KB
      degenerates to the single-call shape (§10).
- [ ] Read-tool descriptions contain the §5-pinned table schemas + semantics
      notes and the include-`hpath` discovery pattern.
- [ ] Unit: spill — inline-cut/preview/per-session-dir/no-cleanup; outline cap
      inlines first N lines + pointer while verification runs on the full walk
      set (§10).
- [ ] Read tools callable from a real pi session against the live kernel
      (manual smoke); tool `kb` validation composes with the live post-toggle
      scope mid-session (Sprint 1's `kb`-param validator fed by Sprint 2's
      scope, now asserted through real tools).

---

## Sprint 4 — Write-back part 1: confirmation + create flow

The highest-stakes path, split across two sprints. This sprint: the
confirmation gate and the `create` flow end to end.

1. **Write confirmation (§5)** — `pi.ui.confirm` always on for interactive;
   headless (`pi -p`) default-deny unless `allowUnattendedWrites: true`;
   RPC is not headless; every confirm carries `writeConfirmTimeout` (default
   60 s, `0` = indefinite), every non-answer resolves to `refused`; timeout
   expiry = `confirm_timeout`, terminal for that write in that session (re-request
   → immediate refusal, no new dialog); explicit decline stays recoverable.
2. **File-path input (§4)** — `markdown` XOR `markdownFile`; file read once at
   call start, the captured string drives guard → confirm → kernel → verify;
   missing/unreadable → structured error, no kernel call; both/neither → shape
   error.
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
6. **Guard stops (§4)** — `duplicate` returns all rows with `updated` +
   budgeted outlines + `stagedPath` draft staging for inline bodies;
   `near_matches` returns candidates (docId, title, first paragraph,
   `updated`) with the `confirmNew` message; `confirmNew: true` bypasses both
   legs, confirmation + verified-create still apply.

### Acceptance criteria

- [ ] Unit: guard — exact leg matches ASCII-cased variants and HTML-special
      titles via escape parity; near-match legs incl. the underscore leg; 20-row
      cap + marker; `confirmNew` skip path; param absent from the declared tool
      schema (assert on the schema object) (§10).
- [ ] Unit: mint-policy rejections — each with its message; verified-create
      asserts incl. simulated stale parent failing loud (§10).
- [ ] Unit: write-confirmation branches — allow/refuse; cancelled and timed-out
      confirms both refuse; `confirm_timeout` terminal (confirm mock fires
      exactly once across both calls); explicit decline recoverable; timeout 0
      issues an untimed confirm (§10).
- [ ] Unit: file-path input — missing file → error, zero kernel calls (request
      log); read-once capture under mid-flow file mutation; XOR shape
      validation (§10).
- [ ] Unit: guard-stop staging — `stagedPath` in the session spill dir,
      byte-equal content, `markdownFile` retry message; no staging when the
      body already came from a file or on non-guard stops (§10).

---

## Sprint 5 — Write-back part 2: remaining modes + write-result contract

1. **Modes (§4)** — `edit` (`updateBlock` on agent-supplied `blockId` target),
   `append` (tool-derived `nextID = next heading` anchor; final section →
   `appendBlock` on doc root), `replace-section` (one call: walk-enumerated
   delete set via `getChildBlocks` document-order walk — never SQL;
   insert-before-delete; same-or-shallower boundary; final section sweeps
   trailing content), `delete` (block or `doc: true` via `removeDocByID`;
   backlink check over the walk set in the confirmation), `move` (block-level
   with tool-derived destination anchor from the destination outline — last top-level
   node of the `toHeadingId` section (heading-recursed), end-of-section semantics
   identical to `append`; heading-anchored placement rejected as fold-state-dependent
   per §4 anchor rule; `doc: true` via `moveDocsByID`; self-descendant pre-check; intra-KB by
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
- [ ] Unit: confirmation for a final-section replace displays the trailing
      blocks' current content + inbound-ref count and referring hpaths;
      delete-bearing results carry `invalidRefs` (§10).
- [ ] Unit: write-result shapes — doc-level `delete` carries only
      `invalidRefs`; doc-level `move` carries outline + title/hpath echo, no
      `anchor`/`newBlockId`/`destOutline`; same-doc move collapses to
      outline + anchor (§10).
- [ ] Write-tool descriptions carry the pinned doctrine lines ("mint by
      title… consume by ID", search ownership constraints), completing the
      description work started in Sprint 3 item 4.

---

## Sprint 5b — Integration suite (runs against live 3.8.3)

The §10 integration profile items M3's gate names, under the fixture policy
(two disposable notebooks per run, teardown via `removeNotebook`; never in CI;
execution order: search-shape first, throttle after all kernel cases, raw-DELETE
last, encrypted case on its own disposable workspace).

1. **Title-guard kernel round-trip** — adversarial titles (tab rejected at
   mint; `A & B` / apostrophe titles mint and re-find via escape parity; clean
   titles store verbatim + expected hpath; kernel `renameDoc` mid-test re-finds
   by new stored title).
2. **Nested-mint + duplicate-disambiguation cases** — nested create → echo →
   read → guard on re-create; stale-parent fail-loud; `duplicate` rows with
   outlines → `confirmNew: true` third mint → deletes → guard exact leg;
   guard-stop staging round-trip (§10): guard-stopped large-body create
   retried with `markdownFile: <stagedPath>` + `confirmNew: true` mints, and
   content read back matches the staged file.
3. **Tool-path verified-create** — pre-existing title → guard matches first, no
   create call fires.
4. **Version-refusal contract pin** — pin deliberately set to a version 3.8.3
   doesn't report → every write refused naming both versions, reads proceed.
5. **Stale-target contract pin** — kernel-deleted fixture block: edit error
   verbatim; append's walk-set assertion turns silent rollback into `error`;
   delete no-op with evidence; move synchronous `-1` surfaced (tree-level-miss
   branch mocked if no honest live route exists).
6. **Fresh-content live pin** — kernel-side content change between outline and
   edit → `stale_content` refusal, content untouched; control run applies.
7. **replace-section end to end** — list/quote-ending section, final-section
   trailing sweep, heading ID survives, planted content-block ref orphans with
   `invalidRefs` echo; `updateBlock` preserves IDs (`listInvalidBlockRefs`
   zero, direct kernel call — test-only exception to documented-endpoints);
   doc-level `delete` backlink case (§10): confirmation surfaced the backlink
   count and referring hpaths, and ref reports come back invalid afterward.
8. **move cases** — doc-level (`moveDocsByID`, IDs survive, echo, follow-up
   write by echoed docId, self-descendant rejected, depth-cap error verbatim,
   own-parent no-op), cross-doc block move (`movedBlockId` equality,
   `destOutline` freshness, provenance survives), same-doc shape pin.
9. **Search + query pins** — scoping shape, recall-loop echo assertion (`read`
   on a search hit's `root_id` succeeds), two-KB saturation pin (fan-out),
   OR-precedence aggregate, `exportMdContent` block-ID absence.
10. **Write-result freshness** — write-result `outline` matches a fresh
    post-write query; `refs` sync-flush pin; `newBlockId` response-shape pin;
    multi-block walk-set diff pin (§10): multi-block `append` → post-write
    walk-set diff contains every new ID with `newBlockId` among them,
    single-block → diff of exactly one ID.
11. **Headless `/kb` dispatch** — `/kb all off` from `pi -p` (converts the §5
    source-read claim into evidence before M4's harness depends on it).
12. **Read-consistency / throttle / raw-DELETE / encrypted-notebook cases** —
    ordered per §10; throttle implemented in the client's profile already
    (`SIYUAN_INTEGRATION_THROTTLE=1`), referenced not re-implemented; the
    extension-side cooldown refusal (local `refused`, zero kernel round-trips)
    is deliberately pinned unit-only in Sprint 1 — no live 429 case here, since
    arming the real per-IP lock costs ~4 min per run (§10).

### Acceptance criteria

- [ ] Setup asserts kernel version exactly equals the pin (accidental upgrade →
      red suite).
- [ ] All cases above green against live 3.8.3 under the fixture policy; the
      teardown itself is asserted (post-teardown notebook count back to
      baseline — zero strays, or exactly the pre-registered known strays).
- [ ] Execution order enforced (search-shape → others → throttle → raw-DELETE;
      encrypted case isolated).

---

## Sprint 6 — Gate checklist + residual manual items

Polish and the M3 gate (§11).

- [ ] Tools callable from pi (all four, in a real session).
- [ ] Scope survives session restart (resume reads the persisted entry).
- [ ] `/kb <name> on` and `/kb all off` land mid-session.
- [ ] Write confirmation refuse/allow verified interactively.
- [ ] Auth breaker degrades after 3 consecutive auth failures (live): set a
      bogus token, issue 3 read calls (each errors), then a 4th — assert it
      returns `refused` with zero kernel requests (request-log evidence), and
      that `/kb` recovery with the corrected token restores reads. 429s in
      between do not reset the consecutive count (§5 breaker rule).
- [ ] Write-path integration suite green (Sprint 5b).
- [ ] Manual residual checklist started: write-confirmation allow/refuse in a
      TTY, status-slot visibility, RPC confirm sub-protocol check at first real
      RPC use (§10 residual list).
- [ ] README/AGENTS.md of `pi-kb` updated to describe the tool surface; DESIGN
      doc §11 M3 row marked done.

Milestone 3 gate (from §11): all of the above; explicitly incl. the
title-guard kernel round-trip pin, the version-refusal contract pin, the
stale-target contract pin, and real headless `/kb` dispatch.

---

## Dependencies & ordering

```text
Sprint 1 (chassis) ──► Sprint 2 (scope + /kb)    ┐
Sprint 1 (chassis) ──► Sprint 3 (read tools)     ├──► Sprint 5 (write modes; needs
Sprint 1 (chassis) ──► Sprint 4 (confirm + create)┘      outline helper + spill from S3;
Sprint 4 ──► Sprint 5                            confirmation gate, timeouts, file
                                                 capture, confirmNew from S4)
Sprint 4 + 5 ──► Sprint 5b (integration)
Sprint 5b ──► Sprint 6 (gate)
```

Sprints 2 and 3 can proceed in parallel once Sprint 1 lands (independent
surfaces; both touch the dispatch point, so the breaker/cooldown gate lands in
Sprint 1 and everything else inherits it). Sprint 4 needs Sprint 1's chassis
plus the spill helper **and the outline walk helper** from Sprint 3 (the
`duplicate` guard stop returns budgeted outlines per §4, and guard-stop draft
staging writes into the session spill dir) — sequencing S3's helpers first
keeps the parallel split clean. Sprint 5 is **not** parallel with Sprint 4:
every mode rides Sprint 4's confirmation gate, `writeConfirmTimeout`, file-path
read-once capture, and `confirmNew` handling.
