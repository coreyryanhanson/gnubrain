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

## Landed — Sprints 1–5

Sprints 1–5 are complete (all unit ACs green: `npm test`, `npm run typecheck`,
`npm run lint`; the landed live pins — the smoke suite and the nine write-mode
pins — also ran green against the live 3.8.4 kernel in the pre-5b verification).
This section records what landed and the deviations from the
original plan; the sprints below reference these deliverables by their
original item numbers.

| Item | Delivered |
|---|---|
| S1.1 Startup validation pipeline | Shape check → `getVersion()` probe (strict match, per-test override seam; pinned `3.8.4` — originally `3.8.3`, re-pinned per deviation 5) → `listNotebooks()`; shape failure degrades the session (rejection gate, not a crash); stale notebook warn-and-drop; encrypted-KB rejection (one branch, both lock states); call-level auth failure → empty valid set + breaker, network drop never counts; unreachable kernel → reads error per-call (bypass the cached verdict), writes probe-retry per attempt |
| S1.2 Error envelope | Shared helper `{status: ok \| near_matches \| duplicate \| error \| refused, message, ...payload}`; `truncated`/`post_filtered` payload markers; success results echo resolved KB name(s) |
| S1.3 `kb` param contract | Required everywhere; arrays on `kb_query`/`kb_search`, single name on `kb_read`/writes; unknown/not-in-scope/empty-array rejections with pinned messages |
| S1.4 Scope resolution | Latest `kb-scope` `appendEntry` wins, else `defaultKBs` (project over global); absent key = empty set; full validator on global file, project file supplies `defaultKBs` only (stray key or non-array → degrade; unknown name → warn-and-drop (either file, at scope resolution), no fallback to global `defaultKBs`); injectable settings-load seam |
| S1.5 Circuit breaker + 429 cooldown | 3 consecutive 401/403 → degraded fail-fast (zero kernel calls); 429 never counted/retried, local cooldown (`Retry-After`, 60 s floor) with pinned message content; `/kb` recovery for the breaker only, cooldown self-heals |
| S1.6 Status bar slot | Severity-first: unreachable red → degraded yellow (`config`/`breaker`/`version` cause tags — beats never-probed, since a shape failure is always also never-probed) → never-probed grey → healthy capability dot (hollow/blue/green); cleared on `session_shutdown` |
| S1 seam | Single `register(pi, deps)` entry in `index.ts` |
| S2.1 Scope persistence | `pi.appendEntry("kb-scope", ...)` full post-toggle snapshot |
| S2.2 `/kb` command | Bare prints scope; `<name> on\|off` idempotent; `all on\|off`; reserved `all` + `tools` (`writes` deliberately un-reserved — see deviations); verbless prints usage |
| S2.3 Recovery hook | Every `/kb` dispatch re-runs full validation (both settings files, shape, probe, `lsNotebooks`) before dispatch; success clears degradation + breaker; failed re-check re-engages |
| S3.1 Spill/budget helper | `PREVIEW_CHARS` 8000/`OUTLINE_HEADINGS` 200/`RESULT_LIMIT` 64; per-session temp dir (`os.tmpdir()/gnubrain/<session-id>/`), `{tool}-{sha256-16hex}` file template, JSONL vs `.md`, newline-boundary preview + pointer |
| S3.2 `kb_query` | Parser certification (DML/multi-statement/FROM-allowlist/CTE/subquery/UNION/JOIN/bare-`HAVING` rejected); AST `box IN (...)` splice with parenthesization (OR precedence), LIMIT 64 injection iff absent, re-parse-and-verify, readonly client `query()`; agent LIMIT passthrough; post-filter backstop (aggregate-exempt) |
| S3.3 `kb_search` | Per-KB fan-out (`pageSize = RESULT_LIMIT`), merged in per-KB kernel order, post-filter backstop, `method: 0` tool-owned with aux params schema-rejected, row echo contract (`root_id`/`hpath` renamed from client) |
| S3.4 Tool descriptions | Query description carries pinned `refs`/`blocks` schemas + semantics notes + include-`hpath` discovery pattern |
| S3.5 `kb_read` | `exportMarkdown` (GFM only), ownership query doubles as scope check, `getChildBlocks` outline walk (depth-bounded, `OUTLINE_HEADINGS` cap with spill) |
| S3.6 Read toolset + `/kb tools` | `defineToolset` with `persistKey: "toolset-state:gnubrain.read"`, default-enabled; `/kb tools` dispatcher (state-setter semantics: bare prints, `read` sets read-only, `off` disables; the `write` verb fell through to usage until the write toolset landed, S5.5); bare `/kb` output carries the toolset-state line; status bar turns accent/blue |
| S3.7 `kbs` discovery name | `RESERVED_KB_NAMES` = `all` + `tools` + `kbs`, name-agnostic reservation message; `kb_read` with `kb: "kbs"` returns the active set with zero kernel calls (short-circuit ahead of breaker/cooldown, shape-refusal still applies); `docId` optional in `kb_read` schema, valid-`kb`/missing-`docId` refused with three-exit guidance; only `kb_read` carries the discovery form — `kb_query`/`kb_search` reject `kb: ["kbs"]` via the unknown-KB rejection |
| S4.1 Write confirmation (§5) | `ctx.ui.confirm` always on for interactive sessions; headless (`pi -p`) default-deny unless `allowUnattendedWrites: true` (dialog skipped, write proceeds unattended); every confirm carries `writeConfirmTimeout` (default 60 s, `0` = indefinite) — the extension owns the timeout clock via `AbortSignal`, the native dialog auto-dismisses on abort, and `signal.aborted` distinguishes a real timeout from an explicit decline; `confirm_timeout` terminal for that write in that session (re-request → immediate refusal), explicit decline recoverable; every non-answer resolves to `refused` |
| S4.2 File-path input (§4) | `markdown` XOR `markdownFile`; file read once at call start, the captured string drives guard → confirm → kernel → verify; missing / not-a-regular-file / unreadable → structured error naming the path, no kernel call; both/neither → shape error |
| S4.3 Title guard (§4 R3) | Exact leg (`LIKE`, pattern from HTML-escaped title, `%`/`_` LIKE-escaped) then near-match scan (space/hyphen/underscore prefix variants, capped at 20 rows with `truncated` marker); single-notebook scope |
| S4.4 Mint policy (§4) | Trim; structured rephrase-hint rejections (empty, `/`, >512 runes, tab/newline-control); HTML-special chars mint normally via escape parity; submission path built from ground truth (top-level `/<title>`, nested via stored parent hpath + `parentID`); no `confirmNew` in the declared schema |
| S4.5 Verified-create (§4 R3) | By-ID asserts on the kernel-returned root ID; nested asserts re-read the parent and compare child hpath against the read-back stored title (ground truth, never the submitted title); stale parent → fail-loud structured error |
| S4.6 Guard stops (§4) | One uniform `duplicate` stop for exact-leg rows, single- or multi-row alike: rows with `updated` + budgeted outlines + per-row full-markdown spill paths (single-row adds the block-ID echo for a straight `edit`) + `stagedPath` draft staging for inline bodies; message names the docIds and the `confirmNew: true` exit; `near_matches` stays excerpt-only (name variants are the clue, 20-row cap bounds the count); `confirmNew: true` bypasses both legs — confirmation + verified-create still apply |
| S5.1 Modes (§4) | `edit` (`updateBlock` on agent-supplied `blockId`); `append` (boundary anchor: `insertBlock` `nextID` = first same-or-shallower sibling heading, else `appendBlock` to the section's container — the doc root for a doc-level heading; optional `placement: "section-start"` before the section's first deeper sibling heading, falling through to the section-end landing when every subsection sits inside a container); `replace-section` (one call: the section via the `getChildBlocks` document-order walk — never SQL; the sweep deletes the members; the closure (members + descendants) drives the confirmation display, fresh-content baselines and `invalidRefs`; insert-before-delete with the same anchor rule as `append`); `delete` (block or `doc: true` via `removeDocByID`; backlink check over the walk set in the confirmation); `move` (block-level with tool-derived destination anchor from the destination outline — end-of-section placement from the same section rule `append` reads, heading-anchored placement rejected as fold-state-dependent; omitted `toHeadingId` → destination doc end (`parentID` prepends — the defect — so `appendBlock`-on-root only when the destination is empty); `doc: true` via `moveDocsByID`; self-descendant pre-check; doc-level move also covers the un-nest case, omitted `toDocId` → `toID` = notebook ID). Anchors always tool-derived; targets agent-supplied from echoed data; replace-section and delete-bearing confirmations display the §4 delete-set payload (block count, trailing blocks' current content, inbound-ref count + referring hpaths), sharing the fresh-content baseline read |
| S5.2 Write-result contract (§4) | Every doc-targeting result carries root `docId`, stored title, real `hpath`, fresh `outline` (cap applies to inline rendering only), `anchor` where placement-bearing, `newBlockId` extracted from `data[0].doOperations[0].id`, `invalidRefs` on delete-bearing writes; cross-doc block `move` adds `destOutline` + `movedBlockId` |
| S5.3 Stale-target verification (§4) | Verified, not trusted: `newBlockId`/`movedBlockId` must appear in the post-write unfiltered walk-set diff (membership only at runtime — the single-block diff-of-exactly-one pin is 5b item 10's); `updateBlock` errors surface verbatim; delete of a missing block answers per kernel generation — 3.8.3 a success no-op with walk-set evidence, 3.8.4 a synchronous "tree not found" error surfaced verbatim with the fresh outline (unit-pinned both); same-doc doc-end move verifies *position* (the last top-level block), not walk-set presence — membership is trivially satisfied by a block already in the walk; silent rollbacks → `error` with fresh outline attached |
| S5.4 Fresh-content precondition (§4) | Baseline content hash per targeted block (served content, or confirmation-displayed current content when none served); re-check after confirmation approval, before the kernel call; mismatch → `stale_content` refusal with current content + fresh outline, zero kernel write calls. Scope: `edit` and `replace-section` only |
| S5.5 Write toolset + toggle (§5) | `defineToolset` `gnubrain.write` (`requires: ["gnubrain.read"]`, `defaultEnabled: true`, `persistKey: "toolset-state:gnubrain.write"`) — the dependency cascade makes live write-without-read toggling unrepresentable; settings pins do **not** cascade (pi-tool-masking restore applies each pin per-toolset, so a hand-pinned write-on + read-off is a reachable write-without-read state — accepted, backstopped by confirmation + headless default-deny); `/kb tools write\|read\|off` state-setter verbs (`write` sets read+write with reads cascading on; `read` from read+write lands read-only; `off` disables both; each verb no-ops when already in the target state); bare `/kb` output's toolset-state line covers both toolsets; status-bar healthy dot turns success/green with write enabled → accent/blue (or hollow if read is also masked, e.g. a `toolsetDefaults` pin) on mask, repainting on `TOOLSET_EVENTS.changed`/`restored` and after `session_tree` restore (text unchanged) |

**Deviations from the plan as originally written** (all recorded, design +
plan updated in the same changes):

1. `/kb writes` (S5's originally planned top-level toggle verb) was replaced by
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
4. **Walk scope correction (pre-5b)**: `walk.ts` recurses only into the
   kernel's container types (`d/b/l/i/s/callout`, plus lute's `tabs`/`tab`; a
   type the kernel's abbreviation map does not name nests too). Heading ids are
   never recursed into: the kernel answers `getChildBlocks(headingId)` with the
   heading's *section* (`treenode.HeadingChildren` — its following siblings up
   to the next sibling heading of same-or-shallower level; that branch runs before the
   kernel's container check), and every one of those blocks is already returned
   by the loop over the container that owns the heading. Recursing into `h`
   re-emitted each section block at the heading's depth and out of document
   order: duplicate walk entries, duplicated `kb_read` outline lines for any
   doc with subheadings, a doubled replace-section delete set (with repeated
   `deleteBlock` calls), and corrupted move anchors (`nextID` search and
   `landingId` read the first duplicate). The §3 walk contract is unchanged —
   every block visited once, in document order — and the fix also drops the
   walk to one `getChildBlocks` call per container instead of one per block.
   The `walk.ts`/`DESIGN_v2.md` "headings are leaves" phrasing was a
   *mutation-parent* claim (the kernel's `CheckContainerParent` rejects
   `parentID=<heading id>`) wrongly carried onto the read path. Confirmed against
   the live 3.8.4 kernel and pinned by the heading-section fixtures in
   `writeModes.test.ts` and the never-walk-a-heading pin in `tools.test.ts`.
5. **Kernel re-pin to 3.8.4 (pre-5b)**: the workspace moved to 3.8.4 and the pin
   followed (`validation.ts`). 3.8.4 executes block writes synchronously
   (`PerformBlockOperation` drains the tx queue and holds the flush lock), which
   closes the post-delete staleness the 3.8.3 queue ticker had (live-verified 0/3
   stale immediate reads, was 5/5) and changes the delete contract the S4/S5 flows
   were written against: a delete of a missing block is now a synchronous
   "tree not found" error where 3.8.3 answered a success no-op — the delete flow
   surfaces it verbatim with the fresh outline attached, the same stale-target
   treatment edit/move already get (unit-pinned both kernel generations); an
   insert/append whose anchor does not resolve now errors instead of rolling back
   behind a success, so the verified-insert machinery is a backstop rather than the
   only line. The design's §4 stale-target record and §10 stale-target/version-refusal
   pins describe both generations.
6. **Replace-section sweep targets the section's members (superseded by the
   section primitive)**: the kernel's delete cascade removes a container's
   tree descendants from the index with it (`transaction.go`'s
   `RemoveBlockTreesByIDs`), so sweeping the slice's descendants explicitly
   would error (synchronous "tree not found") behind a fully-successful
   replace and false-report a partial apply. The interim forest-root filter
   (`sweepTargets`) and the anchor-inside-swept-container refusal guard are
   gone: membership is exact parentage (`sectionOf`'s members — the heading's
   following siblings inside its own container), so every member is already a
   forest root, and the insert anchor is the boundary (a sibling of the
   target) or the container (the members' ancestor) — it can never land
   inside a swept member, so the guard has nothing left to catch. The
   closure (members plus descendants) still drives the confirmation display,
   the fresh-content baselines and the invalidRefs check, and the sweep
   verifies the replacement still stands in the post-write walk before
   reporting ok. The mock kernel's cascade-faithful delete mode
   (`cascadeDelete`) stays: the suite still pins the contract against the
   kernel's actual delete semantics.
7. **Stored-title form correction (5b)**: the guard's patterns were built
   from the HTML-escaped title on the recorded premise that the kernel
   stores the title IAL entity-escaped in `blocks.content`. The 5b title
   round-trip probe showed the live 3.8.4 kernel stores doc titles
   **verbatim** in `blocks.content` (`A & B`, `say "hi"`, `a < b > c` all
   unescaped) — the escaped form lives only in the title IAL
   (`blocks.ial`), which the guard does not query. Consequence: the escaped
   exact/near legs never matched adversarial titles live (re-create minted
   a silent second doc). `writeGuard.ts` now builds both legs from the
   verbatim title (LIKE-escaping only `%`/`_`/`\`); DESIGN §4's stored-form
   record and the unit pins updated in the same change. The apostrophe's
   verbatim storage (the old parity trap) and the §4 superset claim are
   unchanged — the 512-rune boundary and HTML-special titles mint and
   re-find as before, now for the simpler reason.
8. **Derived-index convergence + doc-move echo correction (5b-c)**: the
   live probes behind the write-side cases pinned the kernel's actual
   post-write index behavior, which the design's sync-flush phrasing
   overstated for two columns. (a) The SQL `blocks` columns converge
   **asynchronously** after block writes — `content` ~1.5–3 s, the derived
   `refs` index ~2–3 s, `hpath` on doc-level `moveDocsByID` only after the
   next index pass/reindex — while the tree endpoints (`getChildBlocks`,
   `exportMarkdown`'s hPath) are synchronous. The fresh-content
   precondition and the advisory backlink checks read the SQL surface, so
   their protection window is bounded by that convergence, exactly the
   TOCTOU class the §4 record already accepts; the pins assert bounded
   convergence, not literal immediacy. (b) The doc-level move echo's
   "real hpath" cannot ride the SQL column synchronously, so
   `writeMove.ts` now sources the doc-level move echo's hpath from
   `exportMarkdown` (live tree, immediate); (c) the doc-level
   self-descendant pre-check's `parent_id` chain is a backstop only — live
   `d` rows carry no `parent_id` (nesting is the hpath chain), and the
   live kernel rejects ancestor moves synchronously ("Cannot move to this
   location"), which the live pin asserts verbatim. (d) The kernel's
   creation depth cap bites at hpath depth 8 both at creation and at
   move-under-a-depth-7-destination; the 8b case builds a 7-chain and pins
   the move-time rejection.
9. **Raw-DML hardening + execution-order enforcement (5b-d)**: two live
   findings re-shaped item 12. (a) The §10 raw-DELETE case's premise — a raw
   DELETE via `/api/query/sql` without `mode` mutates `siyuan.db`, requiring
   the reindex to bound the desync — died at 3.8.4: live probes show DML
   through the query endpoint is a **silent no-op in every mode** (single
   statement, `mode: "multiple"`; UPDATE included — `code: 0`, row
   untouched, even a same-request DELETE-then-COUNT sees the row). The
   endpoint is no longer a mutation vector, so the desync/reindex machinery
   has no live trigger; the case now pins the hardening (code-0-but-no-mutation
   in both modes) plus the tool-side rejection that still holds, and the
   reindex trigger stays in the raw helper's surface for the upgrade
   checklist. (b) The cross-file §10 execution order is enforced
   mechanically: vitest's default sort is cache-driven (unknown files by
   size, then previous-run duration, longest first), so the ~8-minute
   throttle file would drift to the front of the queue and arm the lock
   over the whole suite — `vitest.config.ts` now carries an ordered
   sequencer pinning the §10 order (smoke → harness → headless → read →
   write-modes → write-pins → throttle-last). The throttle wait itself was
   corrected against the observed 3.8.4 ladder (lock starts at the 6th
   fail, `30 << (FailCount - 5)` seconds, cap 15 min; the arming sequence
   ends at FailCount 9 → 480s, with each served Retry-After understating
   the final lock by one generation), and one bounded recovery wait covers
   an external auth-fail source on the same IP re-arming the shared per-IP
   lock during the blind wait (observed live once; the environment was
   transiently noisy — the same run passed clean after the noise stopped).

---

## Sprint 5b — Integration suite (runs against live 3.8.4)

The §10 integration profile items M3's gate names, under the fixture policy
(two disposable notebooks per run, teardown via `removeNotebook`; never in CI;
execution order: search-shape first, throttle after all kernel cases, the
raw-DML hardening pin last — enforced mechanically by an ordered vitest
sequencer, since the default cache-driven sort would otherwise drift the
~8-minute throttle file to the front of the queue). **Fixture→settings wiring**: the minted notebook IDs don't exist until
setup runs, so the suite injects fixture settings in memory through S1's
settings-load seam — `{baseUrl, apiToken, kbs: [{name: "fixture-a", notebook:
<minted id>}, {name: "fixture-b", ...}], defaultKBs: [...],
allowUnattendedWrites: true}` — with `defaultKBs` covering both fixtures
wherever a case needs both active (items 9–10's saturation/recall pins);
`allowUnattendedWrites: true` is required in the fixture shape because the
suite runs UI-less (vitest), and an absent/false value would make
writeConfirm default-deny every write case before any kernel call (§5's
headless default-deny); the user's settings files are never read or written.
Item 11 is the exception: `pi -p` is a separate process that reads the pinned
global path, so it runs under a temp `HOME` seeded with `.pi/agent/settings.json`
carrying the same fixture settings — the extension runs unmodified, still
reads its fixed path by construction (§5), and no product-side settings
override mechanism is added. A test-only
raw-kernel-call helper (direct `fetch`) provides raw DML probes (raw-DML
hardening pin) and the bogus-token arming requests. All
notebook/doc lifecycle calls (`createNotebook`, `removeNotebook`,
`renameDocByID` fixtures, `listInvalidBlockRefs`) **and the encrypted-notebook
machinery** (`createEncryptedNotebook`, `getEncryptedNotebookStatus`,
`unlockAndOpenNotebook`, lock-via-`closeNotebook`) ride the typed client
(`siyuan-kernel-api@0.3.1`, exact pin); the remaining helper calls — raw
DML probes, bogus-token arming — stay raw: §10 deliberately keeps
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
throttle case like the rest.

1. **Title-guard kernel round-trip** — adversarial titles (tab rejected at
   mint; `A & B` / `say "hi"` / apostrophe titles mint and re-find verbatim —
   the live pin for the stored-form record: `blocks.content` stores doc
   titles unescaped (the HTML-escaped form lives only in the title IAL,
   `blocks.ial`, which the guard does not query — see deviation 7); clean
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
4. **Version-refusal contract pin** — pin deliberately set to a version 3.8.4
   doesn't report → every write refused naming both versions, reads proceed;
   the override is per-test config, not a global constant mutation (§10), so
   it doesn't fight the setup's pin-equality assert.
5. **Stale-target contract pin** — kernel-deleted fixture block: edit error
   verbatim; append's walk-set assertion turns silent rollback into `error`;
   delete: 3.8.4 answers a synchronous "tree not found" — surfaced verbatim
   with fresh outline (unit-pinned; the live pin asserts the error shape);
   move synchronous `-1` surfaced (tree-level-miss
   branch mocked if no honest live route exists).
6. **Fresh-content live pin** — kernel-side content change between outline and
   edit → `stale_content` refusal, content untouched; control run applies.
7. **replace-section + delete-orphans end to end** — list/quote-ending section,
   a container-nested target (the sweep is exactly the sibling run — `[p2]`,
   never `[p2, l2]` — the replacement lands inside the container, and the
   container's following siblings survive),
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
   `destOutline` freshness, provenance survives), same-doc shape pin, a
   container-nested target (the block lands inside its container, §4), and
   the doc-end move (no `toHeadingId`): a populated destination anchors
   `previousID=<last root-level block>` and the block lands as the
   destination's last root-level block; the `appendBlock(root) — doc end` leg for
   an empty destination is unit-pinned (the live kernel never leaves a doc
   childless — a blank doc carries one empty paragraph, and the tool anchors
   `previousID` after it, landing at the doc's end all the same).
9. **Search + query pins** — scoping shape, recall-loop echo assertion (a
   two-fixture search hit's row carries `root_id`, `box`, the per-row resolved
   KB name, and a non-empty `updated` matching `\d{14}`; `read` on that hit's
   `root_id` succeeds), two-KB saturation pin (fan-out),
   OR-precedence aggregate, `exportMarkdown` block-ID absence.
10. **Write-result freshness** — write-result `outline` matches a fresh
    post-write query; `refs` sync-flush pin; `newBlockId` response-shape pin;
    anchor-echo pin (§10): `append` onto a trailing-content-after-last-heading
    doc reports `anchor: appendBlock(root) — doc end`; anchor-placement pin (§10):
    `insertBlock` with `nextID=<boundary>` lands where the outline says —
    including a section ending in a list/quote (the AST-sibling nesting trap,
    §4), a container-nested target (the body lands inside the container), and
    the final-section `appendBlock`-to-container / doc-root cases; multi-block walk-set
    diff pin (§10): multi-block `append` → post-write walk-set diff contains
    every new ID with `newBlockId` among them, single-block → diff of exactly
    one ID.
11. **Headless `/kb` dispatch** — `/kb all off` from `pi -p` (converts the §5
    source-read claim into evidence before M4's harness depends on it).
12. **Throttle / raw-DML-hardening / encrypted-notebook cases** —
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
lock (bounded by the last served `Retry-After` plus the extension generation
it understates — 3.8.4's ladder ends at FailCount 9 → 480s, any call during
an active lock extends it, §5; one bounded recovery wait covers an external
auth-fail source on the same IP re-arming the shared lock mid-wait) and
assert the post-expiry call succeeds with no recovery step (§5
self-healing expiry); the raw-DML hardening pin then runs last
(§10 execution order). The encrypted-notebook case runs on the
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
+ [ ] All cases above green against live 3.8.4 under the fixture policy; the
      teardown itself is asserted (post-teardown notebook count back to
      baseline — zero strays).
+ [ ] Execution order enforced (search-shape → others → throttle → raw-DML
      hardening pin; encrypted case runs before the throttle, never inside the
      throttle lock window) — mechanically, by the ordered vitest sequencer.
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
Sprints 1–5 (LANDED) ─────────────────────────────────────► Sprint 5b (integration)
Sprint 5b ──► Sprint 6 (gate)
(siyuan-kernel-api 0.3.1 already exact-pinned as of M1; its notebook-lifecycle
and encrypted-notebook methods are exercised first by Sprint 5b's suite)
```

Sprints 1–5 landed in sequence: the chassis first (breaker/cooldown gate —
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
