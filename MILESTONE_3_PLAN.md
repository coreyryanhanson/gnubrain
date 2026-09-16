# Milestone 3 Plan — KB Extension

Implements the M3 row of DESIGN_v2.md §11: *KB extension — tool set, `kb` param
validation, `/kb` command (on/off toggles incl. `all`, scope, chat state via
`appendEntry`), interactive write confirmation.*

Everything here is extension-side (`gnubrain`). The client (`siyuan-kernel-api@0.3.1`,
exact pin) exposes every kernel method M3's runtime paths need — `getVersion`,
`listNotebooks`, `query` (readonly-only; the client hardcodes `mode:
"readonly"` on the wire), `search`, `exportMarkdown`, `getChildBlocks`,
`createDocWithMarkdown`, `insertBlock`/`appendBlock`/`updateBlock`/`deleteBlock`/`moveBlock`,
`removeDocByID`, `moveDocsByID` — plus the notebook/doc lifecycle methods
(`createNotebook`, `removeNotebook`, `renameNotebook`, `openNotebook`,
`closeNotebook`, `renameDocByID`, `listInvalidBlockRefs`) and the encrypted-notebook family
(`createEncryptedNotebook`, `getEncryptedNotebookStatus`,
`unlockAndOpenNotebook`; locking an encrypted box is `closeNotebook`'s job),
all shipped in 0.2.0–0.3.1 and gating Sprint 5b (its raw-helper list shrinks
accordingly). Any further gap is a deliberate, recorded change to that repo.
(Naming note: the client method is `exportMarkdown`, wrapping the kernel's
`exportMdContent` endpoint; likewise `createDocWithMarkdown` wraps the kernel's
`createDocWithMd` endpoint — both names appear below. The method list was
verified against the client's installed exported types before Sprint 3 landed,
the same way Sprint 3's preamble smoke-verified pi-tool-masking. Reference
checkouts for both dependencies live locally: `~/pi-tool-masking/` (S3/S5's
toolset API surface) and `~/siyuan-kernel-api/` (every kernel method named
above).)

Design references below are §-sections of DESIGN_v2.md. Every sprint ends green:
`npm test`, `npm run typecheck`, `npm run lint`.

---

## Landed — Sprints 1–3

Sprints 1–3 are complete (all unit ACs green: `npm test`, `npm run typecheck`,
`npm run lint`; S3's final live-session AC executed successfully against the
live kernel). This section records what landed and the deviations from the
original plan; the sprints below reference these deliverables by their
original item numbers.

| Item | Delivered |
|---|---|
| S1.1 Startup validation pipeline | Shape check → `getVersion()` probe (pinned `3.8.3`, strict match, per-test override seam) → `listNotebooks()`; shape failure degrades the session (rejection gate, not a crash); stale notebook warn-and-drop; encrypted-KB rejection (one branch, both lock states); call-level auth failure → empty valid set + breaker, network drop never counts; unreachable kernel → reads error per-call (bypass the cached verdict), writes probe-retry per attempt |
| S1.2 Error envelope | Shared helper `{status: ok \| near_matches \| duplicate \| error \| refused, message, ...payload}`; `truncated`/`post_filtered` payload markers; success results echo resolved KB name(s) |
| S1.3 `kb` param contract | Required everywhere; arrays on `kb_query`/`kb_search`, single name on `kb_read`/writes; unknown/not-in-scope/empty-array rejections with pinned messages |
| S1.4 Scope resolution | Latest `kb-scope` `appendEntry` wins, else `defaultKBs` (project over global); absent key = empty set; full validator on global file, project file supplies `defaultKBs` only (stray key or non-array → degrade; unknown name → warn-and-drop (either file, at scope resolution), no fallback to global `defaultKBs`); injectable settings-load seam |
| S1.5 Circuit breaker + 429 cooldown | 3 consecutive 401/403 → degraded fail-fast (zero kernel calls); 429 never counted/retried, local cooldown (`Retry-After`, 60 s floor) with pinned message content; `/kb` recovery for the breaker only, cooldown self-heals |
| S1.6 Status bar slot | Severity-first: unreachable red → never-probed grey → degraded yellow (`config`/`breaker`/`version` cause tags) → healthy capability dot (hollow/blue/green); cleared on `session_shutdown` |
| S1 seam | Single `register(pi, deps)` entry in `index.ts` |
| S2.1 Scope persistence | `pi.appendEntry("kb-scope", ...)` full post-toggle snapshot |
| S2.2 `/kb` command | Bare prints scope; `<name> on\|off` idempotent; `all on\|off`; reserved `all` + `tools` (`writes` deliberately un-reserved — see deviations); verbless prints usage |
| S2.3 Recovery hook | Every `/kb` dispatch re-runs full validation (both settings files, shape, probe, `lsNotebooks`) before dispatch; success clears degradation + breaker; failed re-check re-engages |
| S3.1 Spill/budget helper | `SPILL_DIR`/`PREVIEW_CHARS` 8000/`OUTLINE_HEADINGS` 200/`RESULT_LIMIT` 64; per-session temp dir, `{tool}-{sha256-16hex}` file template, JSONL vs `.md`, newline-boundary preview + pointer |
| S3.2 `kb_query` | Parser certification (DML/multi-statement/FROM-allowlist/CTE/subquery/UNION/JOIN/bare-`HAVING` rejected); AST `box IN (...)` splice with parenthesization (OR precedence), LIMIT 64 injection iff absent, re-parse-and-verify, readonly client `query()`; agent LIMIT passthrough; post-filter backstop (aggregate-exempt) |
| S3.3 `kb_search` | Per-KB fan-out (`pageSize = RESULT_LIMIT`), merged in per-KB kernel order, post-filter backstop, `method: 0` tool-owned with aux params schema-rejected, row echo contract (`root_id`/`hpath` renamed from client) |
| S3.4 Tool descriptions | Query description carries pinned `refs`/`blocks` schemas + semantics notes + include-`hpath` discovery pattern |
| S3.5 `kb_read` | `exportMarkdown` (GFM only), ownership query doubles as scope check, `getChildBlocks` outline walk (depth-bounded, `OUTLINE_HEADINGS` cap with spill) |
| S3.6 Read toolset + `/kb tools` | `defineToolset` with `persistKey: "toolset-state:gnubrain.read"`, default-enabled; `/kb tools` dispatcher (state-setter semantics: bare prints, `read` sets read-only, `off` disables; `write` verb falls through to usage until S5); bare `/kb` output carries the toolset-state line; status bar turns accent/blue |
| S3.7 `kbs` discovery name | `RESERVED_KB_NAMES` = `all` + `tools` + `kbs`, name-agnostic reservation message; `kb_read` with `kb: "kbs"` returns the active set with zero kernel calls (short-circuit ahead of breaker/cooldown, shape-refusal still applies); `docId` optional in `kb_read` schema, valid-`kb`/missing-`docId` refused with three-exit guidance; only `kb_read` carries the discovery form — `kb_query`/`kb_search` reject `kb: ["kbs"]` via the unknown-KB rejection |

**Deviations from the plan as originally written** (all recorded, design +
plan updated in the same changes):

1. `/kb writes` (S5 item 5's planned top-level toggle verb) was replaced by
   the `/kb tools` dispatcher (S3 item 6), following pi-lean-portal's `/web`
   state-setter pattern. Consequence: `RESERVED_KB_NAMES` = `all` + `tools`
   + `kbs`; `writes` is a legal KB name again.
2. The `kbs` discovery name (S3 item 7) was added post-S3: `kb_read` with
   `kb: "kbs"` lists active KBs without touching the kernel, so the model
   never has to guess KB names. The reservation error became name-agnostic.
3. Implementation decisions worth keeping: `never-probed` is distinct from
   `unreachable` in probe-verdict caching; `/kb` dispatch logic is a pure
   function (`kbCommand.ts`) with side effects in the `index.ts` handler;
   idempotent toggles report no-op and skip the `appendEntry` write;
   `siyuan-kernel-api/errors.ts` optional-property widening (compat with
   `exactOptionalPropertyTypes`) — recorded as a deliberate change to that
   repo.

## Sprint 4 — Write-back part 1: confirmation + create flow

The highest-stakes path, split across two sprints. This sprint: the
confirmation gate and the `create` flow end to end. Registered name
`kb_write` (§4 schema table pins the param shape: `kb`, `mode`, `markdown` XOR
`markdownFile`, mode-specific targets).

1. **Write confirmation (§5)** — `ctx.ui.confirm` always on for interactive;
   headless (`pi -p`) default-deny unless `allowUnattendedWrites: true` (the
   dialog is skipped; the write proceeds unattended);
   RPC is not headless; every confirm carries `writeConfirmTimeout` (default
   60 s, `0` = indefinite), every non-answer resolves to `refused`; timeout
   expiry = `confirm_timeout`, terminal for that write in that session (re-request
   → immediate refusal, no new dialog); explicit decline stays recoverable.
   Timeout mechanism: the extension owns the timeout clock via `AbortSignal` —
   `setTimeout(() => controller.abort(), writeConfirmTimeout * 1000)` (no timer when `0`),
   passed as `ctx.ui.confirm(title, msg, { signal: controller.signal })`; the native dialog
   auto-dismisses on abort, and `controller.signal.aborted` distinguishes a real timeout
   from an explicit decline (pi's documented pattern — `examples/extensions/timed-confirm.ts`);
   that `signal` options-bag is load-bearing for the terminal-timeout rule, so
   smoke-verify `ctx.ui.confirm`'s signature against the installed pi types
   before Sprint 4 starts (same posture as S3's pi-tool-masking verification):
   `confirm_timeout` only when the signal fired, never inferring timeout from a `false`
   resolution.
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

+ [ ] Unit: guard — exact leg matches ASCII-cased variants and HTML-special
      titles via escape parity; near-match legs incl. the underscore leg; 20-row
      cap + marker; `confirmNew` skip path; the unified exact-leg stop
      (single-row and multi-row both return all rows + per-row spill paths;
      single row adds the block-ID echo); param absent from the declared tool
      schema (assert on the schema object) (§10).
+ [ ] Unit: `kb_write` rejects `kbs` via the existing unknown-KB rejection
      (no special case in the write path — the discovery name is never a
      write target).
+ [ ] Unit: mint-policy rejections — each with its message; verified-create
      asserts incl. simulated stale parent failing loud (§10; §10's
      guard→create race leg is deliberately folded here rather than given its
      own case — it is only reachable in the mocked suite and its duplicate
      lands in the accepted reconcilable class, §4 R3/R4, so verified-create's
      by-ID asserts are all that observes it).
+ [ ] Unit: write-confirmation branches — allow/refuse; cancelled and timed-out
      confirms both refuse; `confirm_timeout` terminal (confirm mock fires
      exactly once across both calls); explicit decline recoverable; timeout 0
      issues an untimed confirm (§10).
+ [ ] Unit: headless write default-deny (§5) — no-UI session with
      `allowUnattendedWrites` absent or false → `refused` naming the enabling
      setting, zero confirm calls and zero kernel calls on the request log;
      `allowUnattendedWrites: true` → the write proceeds unattended (dialog
      skipped per item 1).
+ [ ] Unit: file-path input — missing file → error, zero kernel calls (request
      log); read-once capture under mid-flow file mutation; XOR shape
      validation on a content-bearing mode (create here; the
      edit/replace-section/append legs land with Sprint 5's modes —
      body-less `delete`/`move` carry neither and are valid) (§10).
+ [ ] Unit: create-success echo — doc-level create results carry root `docId`,
      stored title, real `hpath`, fresh `outline` (§4 R3 step 5; the full
      write-result contract generalizes this in Sprint 5 item 2).
+ [ ] Unit: guard-stop staging — `stagedPath` in the session spill dir,
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
   agent-supplied from echoed data. Replace-section and delete-bearing
   confirmations display the §4 delete-set payload (block count, the trailing
   blocks' current content, inbound-ref count + referring hpaths), sharing the
   fresh-content baseline read of item 4.
2. **Write-result contract (§4)** — every doc-targeting result carries root
   `docId`, stored title, real `hpath`, fresh `outline` (cap applies to inline
   rendering only), `anchor` where placement-bearing, `newBlockId` extracted
   from `data[0].doOperations[0].id`, `invalidRefs` on delete-bearing writes;
   cross-doc block `move` adds `destOutline` + `movedBlockId`.
3. **Stale-target verification (§4)** — verified, not trusted: `newBlockId` /
   `movedBlockId` must appear in the post-write unfiltered walk-set diff
   (membership only at runtime — the tool accepts arbitrary markdown it does not
   parse, so the single-block diff-of-exactly-one pin is the live suite's,
   5b item 10); `updateBlock`
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
   dependency cascade makes live write-without-read toggling unrepresentable
   (enabling writes auto-enables reads; disabling reads cascades to disable
   dependents). Settings pins do **not** cascade: pi-tool-masking's restore
   applies each `toolsetDefaults` pin per-toolset without re-running the
   `requires` cascade, so a hand-pinned write-on + read-off is a reachable
   write-without-read state — accepted by design; masking is the outer layer
   and confirmation + headless default-deny still backstop every write (§5).
   Extends Sprint 3's `/kb tools` dispatcher
   with the `write` verb: `/kb tools write` sets the read+write state
   (enabling write cascades reads on via `requires`); `/kb tools read` —
   already landed in Sprint 3 — gains its write-disable leg, so from the
   read+write state it lands read-only (the portal `/web on` precedent:
   enable one, explicitly disable the other); `/kb tools off` disables both
   via read's disable + cascade. All tool toggling stays under `/kb tools`
   (supersedes DESIGN §5's `/kb writes` verb — recorded as a deliberate M3
   change); bare `/kb` output's
   toolset-state line (landed with Sprint 3's read toolset) extends to the write
   toolset. Status-bar integration: the
   healthy dot turns success/green when the write toolset is enabled and back
   to accent/blue (or hollow if the read toolset is also masked — e.g. a
   `toolsetDefaults` pin) on mask, repainting on `TOOLSET_EVENTS.changed`/
   `restored` so `/kb tools` verbs recolor mid-session, and repainting
   again after `session_tree` restore (§5 status-bar record; text unchanged —
   `● kb: <scope names>`).

### Acceptance criteria

+ [ ] Unit: move-anchor derivation — end-of-section anchor on a plain section,
      nested-heading recursion (section ending in a subheading → after the subsection,
      not inside it), trailing list/quote container anchor (placement at section level,
      never nested into the container); fold-state independence (folded destination
      heading does not change the anchor); same-doc move derives the anchor from the
      already-in-hand outline (no extra kernel call) (§4).
+ [ ] Unit: replace-section call order — mocked suite asserts insert precedes
      delete; failed delete after successful insert leaves duplication, never
      loss (§10).
+ [ ] Unit: stale-target verification — insert with `newBlockId` absent from the
      post-write walk set → `error`; edit kernel error verbatim; delete no-op
      success with walk-set evidence; cross-doc move missing from destination
      walk set → `error` (§10).
+ [ ] Unit: fresh-content precondition — baseline from served content;
      no-baseline fallback reads + displays current content and approval
      establishes the baseline; post-approval change → `stale_content` refusal,
      zero kernel write calls on the request log; matching re-check proceeds;
      replace-section baselines the delete set and the confirmation displays
      it (§10).
+ [ ] Unit: confirmation for a final-section replace displays the enumerated
      delete set's block count + the trailing blocks' current content + inbound-ref
      count and referring hpaths;
      delete-bearing results carry `invalidRefs` (§10).
+ [ ] Unit: write-result shapes — doc-level `delete` carries only
      `invalidRefs`; doc-level `move` carries outline + title/hpath echo, no
      `anchor`/`newBlockId`/`destOutline`; same-doc move collapses to
      outline + anchor, with `movedBlockId` present (§10 pins it; §4 verifies
      every move via it).
+ [ ] Write-tool descriptions carry the pinned doctrine lines ("mint by
      title… consume by ID", search ownership constraints), the §4
      replace-first preference (prefer `edit`/`replace-section` over `append`;
      append is for genuinely new facts), and the `kbs` mirror line ("the
      discovery name `kbs` is read-only; writes always target a real KB by
      name"), completing the description work started in Sprint 3 item 7.
+ [ ] Unit: `/kb tools write` dispatch — sets the read+write state (write on
      cascades reads on); `/kb tools read` from the read+write state lands
      read-only (explicit write disable, portal `/web on` precedent);
      `/kb tools off` disables both; each verb reports a no-op when already in
      the target state; bare `/kb` output's toolset-state line covers both
      toolsets (§10's `/kb`-toggle unit list, extended with the `tools` verbs
      per item 5).
+ [ ] Unit: write toolset declares `requires: ["gnubrain.read"]` — live-toggle
      cascade legs: enabling writes cascades reads on; disabling reads cascades
      writes off. Settings-pin boundary (no cascade at restore, pinned
      behavior): a `toolsetDefaults` write-on pin with read unpinned leaves
      both active via read's `defaultEnabled: true` (no cascade involved), and
      a write-on + read-off pin pair produces the reachable write-without-read
      state — asserted as the documented boundary, backstopped by
      confirmation + headless default-deny (§5).
+ [ ] Unit: status-bar capability colors — healthy + write toolset enabled →
      success/green, write masked + read active → accent/blue, both masked →
      `○ kb` hollow (incl. a masked read toolset — `toolsetDefaults` pin /
      allowlist mode — not only our toggle), text identical across healthy
      states; degraded (yellow) and unreachable (red) beat the healthy colors
      in the precedence ladder; glyph repaints on `TOOLSET_EVENTS.changed`/
      `restored` and after `session_tree` restore (§5).

---

## Sprint 5b — Integration suite (runs against live 3.8.3)

The §10 integration profile items M3's gate names, under the fixture policy
(two disposable notebooks per run, teardown via `removeNotebook`; never in CI;
execution order: search-shape first, throttle after all kernel cases, raw-DELETE
last). **Fixture→settings wiring**: the minted notebook IDs don't exist until
setup runs, so the suite injects fixture settings in memory through S1's
settings-load seam — `{baseUrl, apiToken, kbs: [{name: "fixture-a", notebook:
<minted id>}, {name: "fixture-b", ...}], defaultKBs: [...]}` — with `defaultKBs`
covering both fixtures wherever a case needs both active (items 9–10's
saturation/recall pins); the user's settings files are never read or written.
Item 11 is the exception: `pi -p` is a separate process that reads the pinned
global path, so it runs under a temp `HOME` seeded with `.pi/agent/settings.json`
carrying the same fixture settings — the extension runs unmodified, still
reads its fixed path by construction (§5), and no product-side settings
override mechanism is added. A test-only
raw-kernel-call helper (direct `fetch`) provides raw DELETE / the kernel
reindex trigger (raw-DELETE case) and the bogus-token arming requests. All
notebook/doc lifecycle calls (`createNotebook`, `removeNotebook`,
`renameDocByID` fixtures, `listInvalidBlockRefs`) **and the encrypted-notebook
machinery** (`createEncryptedNotebook`, `getEncryptedNotebookStatus`,
`unlockAndOpenNotebook`, lock-via-`closeNotebook`) ride the typed client
(`siyuan-kernel-api@0.3.1`, exact pin); the remaining helper calls — raw
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
   mint; `A & B` / `say "hi"` / apostrophe titles mint and re-find via escape
   parity — the pin that caught the stored-form mapping: `"`→`&quot;` and
   `'` verbatim, never `&#30;`/`&#39;`; clean
   titles — leading/trailing-space-trimmed, Unicode, and the exactly-512-rune
   boundary — store verbatim + expected hpath (the live pin for §4's superset
   claim); kernel `renameDocByID` mid-test re-finds
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
    the distinct 429 — with `Retry-After`) arms the lock via this suite's own
    raw-kernel-call helper under the same env-flag name
    (`SIYUAN_INTEGRATION_THROTTLE=1`); the client's throttle profile lives in
    the client repo's own suite and is not part of the published npm package,
    so the extension suite re-implements the arming, reusing only the flag
    name and the arming shape; the extension-side cooldown leg rides the same armed lock:
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

+ [ ] Setup asserts kernel version exactly equals the pin (accidental upgrade →
      red suite).
+ [ ] All cases above green against live 3.8.3 under the fixture policy; the
      teardown itself is asserted (post-teardown notebook count back to
      baseline — zero strays).
+ [ ] Execution order enforced (search-shape → others → throttle → raw-DELETE;
      encrypted case runs before raw-DELETE, never inside the throttle lock).
+ [ ] Encrypted case: `lsNotebooks` on the shared kernel reports the encrypted
      fixture `encrypted: true` in both lock states → startup rejection names
      the KB while the plain fixture validates clean, zero tool kernel calls
      (§5 one-rejection pin, pinned live); the case self-skips with
      `SIYUAN_ENCRYPTED_PASSWORD` unset or the workspace not encryption-enabled.

---

## Sprint 6 — Gate checklist + residual manual items

Polish and the M3 gate (§11).

+ [ ] Tools callable from pi (all four — `kb_query` / `kb_search` / `kb_read` /
      `kb_write` — in a real session; assert none shadows a pi builtin —
      mechanically asserted, not eyeballed: enumerate `pi.getAllTools()` and
      assert the builtins `read` and `write` still appear unshadowed alongside
      all four `kb_` names — the collision check is that the builtins survive,
      not that the `kb_` names aren't builtins, which the prefix alone already
      guarantees). Both
      toolsets registered default-enabled; `/kb tools read` removes `kb_write`
      from the active tool list (masked ≠ refused — no envelope, tool absent),
      `/kb tools write` restores it; state survives session resume (§5).
+ [ ] Scope survives session restart (resume reads the persisted entry).
+ [ ] `/kb <name> on` and `/kb all off` land mid-session.
+ [ ] Write confirmation refuse/allow verified interactively (manual by design
      — §10's residual list; the live gate checks here are scripted procedures,
      the rest is automated or covered by the suites above).
+ [ ] Auth breaker degrades after 3 consecutive auth failures (live): set a
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
+ [ ] Write-path integration suite green (Sprint 5b).
+ [ ] Manual residual checklist started: write-confirmation allow/refuse in a
      TTY, status-slot visibility, RPC confirm sub-protocol check at first real
      RPC use (§10 residual list).
+ [ ] README of `gnubrain` updated to describe the tool surface; DESIGN
      doc §11 M3 row marked done.
+ [ ] If M3 code was split into new files: `package.json` `files` updated to
      include them (`*.ts` already covers the flat root layout; npm publish's
      `files` allowlist itself drops anything absent — `scripts/release.mjs`
      only stages git changes, the enforcement is npm's).

Milestone 3 gate (from §11): all of the above; explicitly incl. the
title-guard kernel round-trip pin, the version-refusal contract pin, the
stale-target contract pin, and real headless `/kb` dispatch.

---

## Dependencies & ordering

```text
Sprints 1–3 (LANDED) ──► Sprint 4 (confirm + create) ──► Sprint 5 (write modes)
Sprints 1–3 (LANDED) ─────────────────────────────────────┼──► Sprint 5b (integration)
Sprint 5 (write modes) ───────────────────────────────────┘
Sprint 5b ──► Sprint 6 (gate)
(siyuan-kernel-api 0.3.1 already exact-pinned as of M1; its notebook-lifecycle
and encrypted-notebook methods are exercised first by Sprint 5b's suite)
```

Sprints 1–3 landed in sequence: the chassis first (breaker/cooldown gate —
everything else inherits it), then `/kb` + scope persistence and the read
tools extending the single `register(pi, deps)` seam in `index.ts`, with S3
item 6's `/kb`-command additions and S3's final live-scope AC gated on S2
(both since run). Sprint 4 rides the landed chassis plus the spill helper
**and the outline walk helper** from S3 (the `duplicate` guard stop returns
budgeted outlines per §4, and guard-stop draft staging writes into the
session spill dir). Sprint 5 is **not** parallel with Sprint 4: every mode
rides Sprint 4's confirmation gate, `writeConfirmTimeout`, file-path
read-once capture, and `confirmNew` handling. Sprint 5b additionally
consumes S2's `/kb` dispatch (item 11's headless run) and S3's read pins
(items 9–10), and Sprint 6's gate consumes the `/kb` mid-session and
live-breaker-recovery paths.
