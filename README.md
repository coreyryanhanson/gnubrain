# GNUbrain

**GNUbrain's Not Unopinionated gBrain.**

Open-source agent memory for the [pi coding agent](https://pi.dev) — built on
[SiYuan](https://siyuan.b3log.org) as the storage engine. Free as in freedom:
no vendor, no closed-source note app, no model lock-in.

GNUbrain turns a SiYuan workspace into a knowledge base your coding agent can
query, search, read, and — with your approval — write to. Your notes stay
in SiYuan, in standard notebooks, readable by any other tool.

> [!WARNING]
> This is the first release of the plugin and is not yet stable. Expect
> breaking changes to settings and behavior between versions.

## How it works

The extension registers four tools with pi:

| Tool | What it does |
|---|---|
| `kb_read` | Read a document (markdown + heading outline) from an active KB |
| `kb_search` | Full-text search across active KBs |
| `kb_query` | Read-only SQL against the KB index (scoped and safety-checked) |
| `kb_write` | Create, edit, append, replace-section, move, or delete — approved once per KB per interaction |

Writes are approved once per KB per interaction: the first `kb_write` targeting a
KB opens a dialog naming that KB (writes may include deletes). **Yes** approves
writes to it for the interaction, **Always this session** for the whole session,
any other answer denies that KB until the interaction ends. Every landed write is
itemized in its result afterward and verified against the kernel; delete-bearing
writes also carry a receipt of the removed blocks (ids + content), so a Data
History lookup has something to search for.

> [!WARNING]
> **Back up your data. Agents are non-deterministic.**
> SiYuan's Data History (SiYuan → Data History) offers searchable document history
> with one-click whole-doc rollback, within the retention window (default 30 days),
> where the last snapshot is at most 10 minutes old. **It is not a backup**: content
> written after the last snapshot, by you or by the agent, exists in no snapshot
> and cannot be recovered, and a whole-doc rollback also discards your own edits
> made after the snapshot. Perform your own backups of KB notebooks to ensure data
> integrity.

## Setup

1. Install the extension:

   ```sh
   pi install npm:gnubrain
   ```

2. Run [SiYuan](https://siyuan.b3log.org) and enable its API.
   GNUbrain requires SiYuan **3.8.4 exactly** — a different kernel version
   refuses every write and warns on reads.
3. Add your connection and notebooks to `~/.pi/agent/settings.json`:

   ```json
   {
     "gnubrain": {
       "baseUrl": "http://127.0.0.1:6806",
       "apiToken": "<your API token>",
       "kbs": [
         { "name": "notes", "notebook": "20240101120000-abcdefg" }
       ],
       "defaultKBs": ["notes"]
     }
   }
   ```

   `notebook` is the SiYuan notebook ID, found in SiYuan via the notebook's
   ⋮ (kebab) menu → **Settings**. You can register multiple notebooks under
   different names. The `apiToken` is found
   in SiYuan under **Settings → Authentication → API token**. Project-level
   settings (`.pi/settings.json`) may also set `defaultKBs`.
4. Start pi. GNUbrain validates the connection at startup and shows a status
   indicator while you work.

## The `/kb` command

| Command | Effect |
|---|---|
| `/kb` | Show current KB scope and tool state |
| `/kb <name> on` / `off` | Toggle a KB in/out of scope (idempotent) |
| `/kb all on` / `off` | Toggle every KB at once |
| `/kb tools read` | Read-only mode (write tools masked out) |
| `/kb tools write` | Read + write mode |
| `/kb tools off` | Disable the extension's tools |

Scope changes persist across sessions.

## Options

| Setting | Default | Meaning |
|---|---|---|
| `defaultKBs` | — | KBs active without any `/kb` toggle (project file may also set this) |
| `allowUnattendedWrites` | `false` | Skip the approval dialog and allow writes unattended; headless (`pi -p`) runs deny writes unless this is set |
| `writeConfirmTimeout` | `60` | Seconds the per-KB approval dialog waits before dismissing (`0` = wait forever); a dismissal denies that KB for the interaction |

> [!NOTE]
> Requires SiYuan 3.8.4 exactly. Any other kernel version refuses writes and
> warns on reads (see the status indicator for the reported version).

## Architecture

GNUbrain is the top layer of a three-layer stack, each an independent repo:

| Layer | Package | Owns |
|---|---|---|
| 1 | [`siyuan-kernel-api`](https://www.npmjs.com/package/siyuan-kernel-api) | Typed thin HTTP client — version agnostic |
| 2 | [`siyuan-kb-primitives`](https://www.npmjs.com/package/siyuan-kb-primitives) | Version-pinned kernel primitives: block-tree walk, by-ID reads, title guard, guarded create, verify loops, the SiYuan version pin and probe |
| 3 | `gnubrain` (this repo) | The four kb tools, `/kb`, write flows, session state, spill and envelope shaping |

Everything that can lie because of a kernel version — the walk, the write
verifications, the pin itself — lives in layer 2 and is falsified by its own
test suites; this repo consumes it through the primitives' entry points and
owns only tool-surface policy (approval gates, breaker, scopes, result
shaping).

## Development

```sh
npm test          # unit tests
npm run typecheck
npm run lint
```

The live integration suite (opt-in, runs against a real SiYuan 3.8.4 kernel,
never in CI):

```sh
SIYUAN_INTEGRATION=1 SIYUAN_API_TOKEN=<token> SIYUAN_BASE_URL=<origin> \
  npx vitest run --project integration
```

## License

[AGPL-3.0-or-later](LICENSE)
