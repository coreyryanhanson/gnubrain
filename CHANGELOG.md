# Changelog

## [Unreleased]

### Added

- **SiYuan-backed knowledge-base tools for pi.** GNUbrain registers four tools
  against a SiYuan kernel, organized in two toolsets — `gnubrain.read`
  (default-enabled) and `gnubrain.write` (default-enabled, requires
  `gnubrain.read`):

  - `kb_read` — export a document as GFM markdown, or walk its outline
    (`getChildBlocks`); `kb: "kbs"` lists the active knowledge bases without
    touching the kernel.
  - `kb_search` — full-text search fanned out across the active KBs, merged in
    per-KB kernel order.
  - `kb_query` — read-only SQL over the kernel's SQLite index, parser-certified
    (DML, multi-statement, and non-allowlisted `FROM` tables rejected), with
    per-KB scoping spliced into the AST and a LIMIT 64 injected when absent.
  - `kb_write` — create / edit / append / replace-section / delete / move, all
    behind the per-KB write grant and all verified: every mutation's landing is
    judged against the post-write block tree, so a silently rolled-back insert,
    a no-op delete, or a lost move reads as a refusal, never as ok; minted and
    moved blocks are asserted against that tree; edits carry a fresh-content
    precondition (`stale_content` refusal instead of a silent clobber); and
    delete-bearing writes echo `invalidRefs` plus a receipt of the removed
    blocks (ids + content; overflow spills to a file pointer).

- **`/kb` command** for session-scoped control:

  - `kb on|off` scope toggles per KB name, `all on|off` for everything; the
    post-toggle snapshot persists via a `kb-scope` session entry and survives
    restart/resume.
  - `tools read|write|off` toggles the toolsets at runtime (masked tools
    disappear from the active list — masked ≠ refused; state persists with the
    session).
  - `kbs` is reserved as a discovery name (`kb_read` with `kb: "kbs"`), so the
    model never has to guess KB names.
  - Every `/kb` dispatch re-runs full validation (settings, kernel probe,
    notebook listing) before acting — a successful dispatch also recovers the
    auth breaker; the 429 cooldown self-heals on its own.

- **Write grant.** Writes are approved once per KB per interaction, not once per
  write: the first `kb_write` targeting a KB opens a tri-state dialog naming the KB
  (writes may include deletes). **Yes** approves for the interaction, **Always this
  session** for the session, and every other answer (decline, dismissal, timeout,
  failed dialog) denies that KB until the interaction ends. The refusal reason code
  is `write_denied`. `writeConfirmTimeout` (default 60 s, `0` = wait indefinitely)
  bounds pi's native dialog timeout. `allowUnattendedWrites: true` skips the dialog
  in any session; headless runs (`pi -p`) default-deny unless it is set.

- **Startup validation and degradation.** Sessions validate on startup —
  kernel version must match the pinned version exactly, `listNotebooks` must
  succeed, encrypted notebooks are rejected in both lock states, unknown KB
  names in settings are warn-and-dropped. Failures degrade the session rather
  than crash it: a status-bar slot shows the severity ladder (unreachable red
  → degraded yellow → never-probed grey → healthy capability dot) and clears
  on session shutdown.

- **Circuit breaker and 429 cooldown.** Three consecutive auth failures
  (401/403) trip a breaker that fails fast locally — zero kernel calls until
  `/kb` recovery re-validates. HTTP 429 never counts toward the breaker;
  instead the extension cools down locally for the kernel's served
  `Retry-After` (60 s floor) and self-heals when it expires.

- **Structured error envelope.** Every tool answer carries
  `{status: ok | near_matches | duplicate | error | refused, message, ...}`.
  Large results spill to per-session temp files with pointers instead of
  flooding the context: previews cap at 8000 chars, outlines at 200 headings,
  result sets at 64 rows.

- **Settings keys** (global file; only `defaultKBs` may also live in the
  project `.json`): `baseUrl`, `apiToken`, `kbs: [{name, notebook}]`,
  `defaultKBs` (project wins over global), `allowUnattendedWrites`,
  `writeConfirmTimeout`. See the README for a full example.

- **Kernel coupling lives in `siyuan-kb-primitives`.** Block-tree walks,
  title-guard reads, placement, and every write verdict — `createVerifiedDoc`,
  `editVerified`, `insertVerified`, `moveBlockVerified` / `moveDocVerified`,
  `deleteBlockVerified` / `deleteDocVerified`, `sweepSectionMembers` — ride
  that package, whose SiYuan version pin this package consumes — writes fail
  closed on kernel drift, reads warn.
