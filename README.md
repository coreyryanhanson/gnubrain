# GNUbrain

**GNUbrain's Not Unopinionated gBrain.**

A knowledge base for the [pi coding agent](https://pi.dev), stored in
[SiYuan](https://github.com/siyuan-note/siyuan): your notes, your disk, your
software.

Agent memory add-ons usually mean adopting a note app you cannot inspect, or a
hosted service you cannot leave. GNUbrain is for people who would rather not.
The store is SiYuan: AGPL-3.0, Markdown WYSIWYG, block refs, graph view,
local-first, and self-hosted (sync and backup are optional premium cloud
services). No account, no lock-in, no model vendor. If you already keep notes
in SiYuan, your notebooks become agent-readable as-is; if you don't, SiYuan is
a good place to start.

> [!WARNING]
> Pre-1.0 software: settings and behavior may still change between releases,
> and there is no automatic settings migration.

## What your agent can do

Four tools, registered with pi:

| Tool | What it does |
| --- | --- |
| `kb_read` | A document's Markdown body plus a heading outline, or the list of KBs in scope |
| `kb_search` | Full-text search across the KBs in scope |
| `kb_query` | Read-only SQL over the workspace index, scoped to your KBs |
| `kb_write` | Creates, edits, appends, replaces a section, moves, and deletes |

The tools describe themselves to the agent, so there is nothing to memorize.
Ask in plain language:

> "What do my notes say about the auth lockout bug?"
> "Write today's findings into the `engineering` notebook under 'Kernel work'."
> "Move the 'Release checklist' section into the `release` doc."

The agent picks the tool and the arguments. You see the result, and you see
the approval dialog before anything is written.

## Write approval

Writes are granted per KB per interaction. The first write to a KB opens a
dialog naming it (writes can include deletes):

- **Yes** — approve writes to that KB for this interaction
- **Always this session** — approve for the rest of the session
- anything else — deny that KB until the interaction ends

Every landed write is verified against the kernel and itemized in its result;
delete-bearing writes also come back with the id and content of each removed
block, which is what you want when you go looking in Data History.

Headless runs (`pi -p`, `pi --mode json`) have no UI to ask, so writes are
denied by default. See [Options](#options) if you really want unattended
writes.

## Read this before writing: history is not backup

> [!WARNING]
> **Agents are non-deterministic. Back up your notebooks.**

SiYuan's Data History (right-click a document in the file tree → **Data
History**) keeps searchable document snapshots with one-click rollback.
Snapshots are taken while SiYuan runs, roughly every 10 minutes by default;
the snapshot interval and the 30-day retention window are set in
**Settings → Documents → File Management** (an interval of `0` disables
history entirely).

History is a safety net, not a backup:

- Content written after the last snapshot, by you or by the agent, is in
  no snapshot and cannot be recovered.
- Rolling a document back also discards your own edits made after that
  snapshot.

Do your own backups of the notebooks you expose to the agent.

## Setup

### 1. SiYuan

Install SiYuan 3.8.8 ([downloads](https://github.com/siyuan-note/siyuan/releases):
desktop app or self-hosted) and open or create the notebook you want to expose.
Then, in SiYuan:

- **API token:** Settings → Authentication → **API token**.
- **Notebook ID:** right-click the notebook in the file tree → **Settings**
  → **Copy ID**.
- **Lock screen password:** Settings → Authentication. SiYuan refuses
  non-127.0.0.1 API access until one is set. Never expose a kernel without
  it.

GNUbrain requires an exact kernel version match; other versions refuse writes and
warn on reads. Encrypted notebooks are not supported (register a normal one).
Leave SiYuan running while you work — GNUbrain talks to its live HTTP API and
never touches the files on disk.

### 2. The extension

```sh
pi install npm:gnubrain
```

### 3. Settings

Add a `gnubrain` entry to `~/.pi/agent/settings.json` (the file already exists
after the install; merge, don't replace):

```json
{
  "gnubrain": {
    "baseUrl": "http://127.0.0.1:6806",
    "apiToken": "<your API token>",
    "kbs": [{ "name": "notes", "notebook": "20240101120000-abcdefg" }],
    "defaultKBs": ["notes"]
  }
}
```

`name` is what you and the agent call the KB (no spaces or `/`; `all`,
`tools`, and `kbs` are reserved). `defaultKBs` is what is in scope when a
session starts; with it absent, nothing is in scope until you run
`/kb all on`. Register as many notebooks as you like.

A project may narrow the default set in `<cwd>/.pi/settings.json`; that is the
only `gnubrain` key a project file may carry. Any other key there (connection
keys included) degrades the whole session, so keep tokens in the global file:

```json
{ "gnubrain": { "defaultKBs": ["notes"] } }
```

### 4. Start pi

GNUbrain validates the connection at startup and puts a `kb:` indicator in the
status bar. The dot color carries the state: green with writes enabled, blue
when read-only, hollow when the tools are off, grey before the first probe,
yellow for a config, version, or lockout problem, red when the kernel is
unreachable.

Then prove it end to end: ask the agent to list the notebooks it can see, or
what your notes say about something you know is in one. If the `kb:` dot is
green and an answer cites your own notes, you're done.

## The `/kb` command

| Command | Effect |
| --- | --- |
| `/kb` | Show current scope and tool state |
| `/kb <name> on` / `off` | Toggle one KB in or out of scope |
| `/kb all on` / `off` | Toggle every valid KB |
| `/kb tools` | Print the tool state |
| `/kb tools read` | Read-only: write tool masked out |
| `/kb tools write` | Read + write |
| `/kb tools off` | Disable GNUbrain's tools for this session |

Scope changes survive restart and resume. Tool toggles are session state: a
fresh session starts with both toolsets enabled, and `/kb tools write` turns
reads on too, since writes require reads.

## Options

All of these live under `gnubrain` in the global settings file, alongside the
connection keys above.

| Setting | Default | Meaning |
| --- | --- | --- |
| `allowUnattendedWrites` | `false` | Skip the approval dialog and permit writes with no UI (`pi -p`, `--mode json`) |
| `writeConfirmTimeout` | `60` | Seconds the approval dialog waits before dismissing (`0` waits forever); a dismissal is a denial |

`allowUnattendedWrites` is a blanket permission grant, not a headless-only
switch: it skips the dialog in interactive sessions too. Set it only when you
mean for the agent to write while you are not looking.

## Good to know

- **The kernel is a single writer.** Point one GNUbrain install at one SiYuan
  workspace; two writers means torn state. Run separate kernels for separate
  workspaces.
- **Editor markdown settings shape what the agent reads.** SiYuan's Settings →
  Editor → Markdown Inline Syntax decides how inline syntax (`*em*`,
  `==mark==`, `$math$`, `#tag#`, …) is parsed into the block tree, so it
  decides the form `kb_read` serves for those blocks. Round-trips are stable
  under fixed settings; change them mid-life and literal ↔ markup can flip in
  served bytes (stored content is untouched). Leave them at the defaults on a
  KB kernel.

## How it's built

GNUbrain is the top of a three-layer stack, each an independent repo:

| Layer | Package | Owns |
| --- | --- | --- |
| 1 | [`siyuan-kernel-api`](https://www.npmjs.com/package/siyuan-kernel-api) | Typed, dependency-free HTTP client for the kernel API |
| 2 | [`siyuan-kernel-primitives`](https://www.npmjs.com/package/siyuan-kernel-primitives) | Version-pinned kernel primitives: block-tree walks, by-ID reads, the title guard, the guarded create, the post-write verification loops, the version pin and probe |
| 3 | `gnubrain` | The four kb tools, `/kb`, write flows, session state, spill and envelope shaping |

Anything whose correctness depends on the kernel version lives in layer 2 and is
falsified against a real 3.8.8 kernel by that repo's own suites. This repo owns
tool-surface policy: approval gates, scopes, breaker and cooldown, result
shaping.

There are no model calls anywhere in the stack. The agent is the intelligence;
SiYuan is the memory. Nor is GNUbrain an MCP server: SiYuan can front its kernel
with MCP tools, and this deliberately doesn't. Four tools are cheaper for an
agent to choose between than a block-level CRUD surface, and the guards that
make writes safe (per-KB grants, fresh-content refusals, walk-verified
landings) have nowhere to live in a generic block API.

## Development

```sh
npm ci
npm test          # unit tests (integration self-skips)
npm run typecheck
npm run lint
```

The live integration suite runs against a real SiYuan 3.8.8 kernel and is never
part of CI. Point it at a kernel you can safely mutate:

```sh
SIYUAN_INTEGRATION=1 SIYUAN_API_TOKEN=<token> SIYUAN_BASE_URL=<origin> \
  npx vitest run --project integration
```

## License

[AGPL-3.0-or-later](LICENSE)

Found a bug? [Open an issue](https://github.com/coreyryanhanson/gnubrain/issues).
Before upgrading, read the
[CHANGELOG](https://github.com/coreyryanhanson/gnubrain/blob/main/CHANGELOG.md).
