# GNUbrain

Pi extension (`gnubrain`) that exposes a SiYuan kernel as a knowledge base:
four tools (`kb_read`, `kb_search`, `kb_query`, `kb_write`) plus the `/kb`
command. Published to npm as a `pi-package`.

## Commands

```sh
npm ci                 # Node 22 in CI; repo runs on v24 here
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint --deny-warnings
npm run fmt            # oxfmt (format in place)
npm run fmt:check
npm test               # vitest run — unit + integration (integration self-skips)

# focused unit runs (integration project needs a live kernel, see below)
npx vitest run --project unit __tests__/unit/gate.test.ts
npx vitest run --project unit -t "some test name"
```

Live integration (opt-in, never in CI):

```sh
SIYUAN_INTEGRATION=1 SIYUAN_API_TOKEN=<token> SIYUAN_BASE_URL=<origin> \
  npx vitest run --project integration
# SIYUAN_BASE_URL is required — the harness bakes in no default
```

## Hard constraints

- **No build step.** `package.json` is `"type": "module"` and `pi.extensions`
  points straight at `./index.ts`; pi runs the TypeScript directly. `tsc` is
  `--noEmit` only. Do not add a bundler, `dist/`, or a compile step.
- **NodeNext ESM: import local modules with a `.js` extension even though the
  files are `.ts`** — `import { guardCall } from "./gate.js"`, and in tests
  `"../../kernel.js"`. Getting this wrong is the most common breakage.
- **Flat layout.** Every module lives at the repo root (no `src/`); npm
  publishes `*.ts` at the root. Put new modules at the root and keep them flat.
- TypeScript is strict plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`.
- **Formatting is not cosmetic here:** oxfmt uses tabs and 80 columns; oxlint
  must pass with zero warnings. Husky pre-commit runs lint-staged →
  `oxfmt` + `oxlint --fix --deny-warnings` on staged `*.ts`.

## Architecture

`index.ts` is the entry (`register(pi, deps)`): session lifecycle, `/kb`
command, status slot, and both toolsets. `deps` is the injectable test seam
(`readFile`, `homeDir`, `createClient`, `pinnedVersion`) — unit and integration
tests drive the extension through it instead of touching real files.

- **Every kb tool call routes through `gate.ts`.** Reads use `runKbCall`;
  writes run `gateWriteAttempt` then a flow. The gate order is pinned (shape →
  breaker → 429 cooldown → `kb` param) and refuses locally with zero kernel
  calls before the op runs. Never call the kernel client outside this path.
- **Toolsets** via `pi-tool-masking`: `gnubrain.read` (registered in
  `tools.ts`, three read tools) and `gnubrain.write` (`write.ts`, one
  `kb_write`). Write `requires` read — enabling writes cascades reads on.
  `/kb tools read|write|off` toggles them live.
- **Write flows:** `writeModes.ts` dispatches edit / append / replace-section /
  delete / move; create is `writeCreate.ts`. Schema/shape in `writeSchema.ts`,
  confirmation gate in `writeConfirm.ts`, guard SQL in `writeGuard.ts`.
- **SQL handling is pure and testable** in `sqlScope.ts` (node-sql-parser):
  only single-table `SELECT` from `blocks`/`refs`; scope is spliced into the
  AST and re-parsed for verification.
- Every tool result is an envelope `{status: ok | near_matches | duplicate |
  error | refused, message, ...}` (`envelope.ts`) — use its factory helpers,
  don't invent statuses. Large payloads spill to session temp files.

## SiYuan version pin

`PINNED_SIYUAN_VERSION` lives in `validation.ts` (`"3.8.4"`). Version drift
fails writes closed and warns on reads. Change the pin only deliberately — the
live harness asserts the kernel reports it exactly. Tests override per-run via
`deps.pinnedVersion` / `runSessionValidation({ pinnedVersion })`.

## Settings

- Global `~/.pi/agent/settings.json` carries `baseUrl`, `apiToken`, `kbs`, and
  the interaction dials.
- Project `<cwd>/.pi/settings.json` may contain **only**
  `gnubrain.defaultKBs`; any other key degrades the whole session.
- Build paths with `globalSettingsPath()` / `projectSettingsPath()` from
  `settings.ts`, never by hand-joining.
- `all`, `tools`, and `kbs` are reserved KB names and cannot be registered.

## Testing notes

- `__tests__/unit` runs with default parallelism; `__tests__/integration` sets
  `fileParallelism: false` and an explicit `INTEGRATION_ORDER` in
  `vitest.config.ts`. **That order is load-bearing:** `throttleLive.live.test.ts`
  must stay last — its throttle case arms the kernel's per-IP lock.
- Unit tests use `__tests__/helpers/fakePi.ts` and SQL-routed kernel stubs
  (`__tests__/unit/writeHarness.ts` is the one `kb_write` setup). **Stubs route
  on the exported `*_STMT_HEAD` constants** (`GUARD_STMT_HEAD`,
  `OWNERSHIP_STMT_HEAD`, `BLOCK_IN_DOC_STMT_HEAD`, …). If you reword a SQL
  statement, update its head constant in the same change or the stub silently
  stops matching.
- The integration suite needs a live SiYuan 3.8.4 kernel and self-skips
  (`describe.skipIf`) unless `SIYUAN_INTEGRATION=1`. It mints two disposable
  notebooks per run and asserts teardown leaves no strays — point it at a
  kernel you can safely mutate, never CI.

## Release

`npm run release:{patch,minor,major}` (or an explicit `x.y.z`) runs
`scripts/release.mjs`: tests → version bump → promotes the CHANGELOG
`[Unreleased]` section → commit/tag → `npm publish` → reinstate `[Unreleased]`
→ push. Draft CHANGELOG entries before releasing. `prepublishOnly` also runs
tests + typecheck.
