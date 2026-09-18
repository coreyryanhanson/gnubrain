# GNUbrain

**GNUbrain's Not Unopinionated gBrain.**

Open-source agent memory for the [pi coding agent](https://pi.dev) — built on
[SiYuan](https://siyuan.b3log.org) as the storage engine. Free as in freedom:
no vendor, no closed-source note app, no model lock-in.

GNUbrain turns a SiYuan workspace into a knowledge base your coding agent can
query, search, read, and — with your confirmation — write to. Your notes stay
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
| `kb_write` | Create, edit, append, replace-section, move, or delete — always behind your confirmation |

Writes go through an interactive confirmation dialog before anything touches
your workspace, and every write is verified against the kernel afterward.

## Setup

1. Install the extension:

   ```sh
   pi install npm:gnubrain
   ```

2. Run [SiYuan](https://siyuan.b3log.org) and enable its API.
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
| `allowUnattendedWrites` | `false` | In headless (`pi -p`) runs, skip the confirmation dialog and allow writes unattended |
| `writeConfirmTimeout` | `60` | Seconds to wait for a write confirmation (`0` = wait forever) |

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
