# Changelog

## [0.1.0] - 2026-10-26

### Added

- **Initial release: SiYuan-backed knowledge-base tools for pi.** Four tools
  against a SiYuan kernel, in two toolsets — `gnubrain.read` and
  `gnubrain.write` (requires read), both on by default:

  - `kb_read` — a doc's stored body as round-trip-safe markdown (no
    frontmatter, no title H1) plus its heading→block-ID outline; `kb: "kbs"`
    lists active KBs without touching the kernel.
  - `kb_search` — full-text search fanned out across the active KBs.
  - `kb_query` — read-only SQL over the kernel's index, parser-certified (DML,
    multi-statement, and non-allowlisted tables rejected), KB scope spliced
    into the AST, `LIMIT 64` injected when absent.
  - `kb_write` — create / edit / append / replace-section / delete /
    delete-section / move, each judged against the post-write block tree, so a
    rolled-back insert, a no-op delete, or a lost move reads as an error or
    refusal, never as ok. Edit, block-delete, delete-section, and
    replace-section refuse with `stale_content` when the target changed since
    this session was served it (doc deletes are exempt — the receipt is the
    contract). Delete-bearing writes echo `invalidRefs` plus a receipt of the
    removed blocks. A heading `blockId` moves the whole section in one
    all-or-nothing transaction; a heading-scoped plain delete reports the
    members the kernel orphaned.

- **`/kb` command:** `/kb <name> on|off` (or `all on|off`) for KB scope,
  persisted per session; `/kb tools read|write|off` toggles the toolsets at
  runtime (masked, not refused). `all`, `tools`, and `kbs` are reserved
  names — `kbs` is the discovery form, so the model never guesses KB names.

- **Per-KB write grant:** the first `kb_write` to a KB opens a tri-state dialog
  naming the KB — **Yes** (this interaction), **Always this session**, and any
  other answer (decline, dismissal, timeout, failed dialog) denies with reason
  `write_denied`. `allowUnattendedWrites: true` skips the dialog; headless runs
  default-deny. `writeConfirmTimeout` (default 60 s, `0` = forever) bounds the
  dialog.

- **Startup validation and degradation:** the kernel version must match the
  pinned SiYuan release exactly, `listNotebooks` must succeed, encrypted
  notebooks are rejected in both lock states, unknown KB names are
  warn-and-dropped. Failures degrade rather than crash — a status-bar slot
  shows the severity ladder. Three consecutive auth failures trip a local
  breaker that fails fast with zero kernel calls until `/kb` re-validates; a
  429 never counts toward it and instead cools down for the served
  `Retry-After` (60 s floor), self-healing on expiry.

- **Config and envelopes:** `baseUrl`, `apiToken`, `kbs`, `defaultKBs` (project
  file wins), `allowUnattendedWrites`, `writeConfirmTimeout`. Every tool answer
  is `{status: ok | near_matches | duplicate | error | refused, message, …}`
  and large payloads spill to session temp files (previews 8000 chars, outlines
  200 headings, result sets 64 rows). See the README for a full example.

Requires a SiYuan **3.8.8** kernel — other versions degrade the session.
