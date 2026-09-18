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
    behind the write confirmation gate (below) with verified results: minted
    and moved blocks are asserted against the post-write tree, edits carry a
    fresh-content precondition (`stale_content` refusal instead of a silent
    clobber), and delete-bearing writes echo `invalidRefs`.

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

- **Write confirmation gate.** Interactive sessions confirm every write
  through pi's native dialog (`ctx.ui.confirm`); headless runs (`pi -p`)
  default-deny unless `allowUnattendedWrites: true` is set in settings. Each
  confirm is bounded by `writeConfirmTimeout` (default 60 s, `0` = wait
  indefinitely); a timeout is terminal for that write in that session, an
  explicit decline is recoverable by re-requesting. Delete-bearing and
  replace-section confirmations display the delete set (block count, trailing
  content, inbound-ref count with referring hpaths) before anything is
  removed.

- **Startup validation and degradation.** Sessions validate on startup —
  kernel version must match the pinned `3.8.4` exactly, `listNotebooks` must
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

- **Settings keys** (global or project `.json`): `baseUrl`, `apiToken`,
  `kbs: [{name, notebook}]`, `defaultKBs` (project wins over global),
  `allowUnattendedWrites`, `writeConfirmTimeout`. See the README for a full
  example.

- **Kernel dependency: SiYuan 3.8.4 exactly.** A different kernel version is
  refused at startup with both versions named (pinned version vs. reported).
