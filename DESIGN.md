# DESIGN — gnubrain (slim successor to DESIGN_v2.md)

Status: Milestones 0–3 complete. The full design doc (v2, with decision records
R1–R6, milestone history, and M3 deviation ledger) is archived on the
`design-v2-archive` branch — consult it for rationale; this file is the
operating record. Milestone 4 (automated recall harness) was **dropped**:
tool-level behavior is fully pinned by the integration suite; model-in-the-loop
recall behavior is untested by construction (accepted concession, see below).
The full v2 doc (decision records R1–R6, milestone history, M3 deviation
ledger) stays recoverable from git history — branch or tag `design-v2-archive`
before removing `DESIGN_v2.md` from the working tree.

**Where truth lives:** behavior is pinned by tests — the test files
(`__tests__/`) are the authoritative case inventory. Code comments and test
names carry the contracts; this doc does not restate them. Kernel behaviors
verified against the live 3.8.4 kernel are pinned in the integration suite
(`SIYUAN_INTEGRATION=1`, opt-in; `INTEGRATION_ORDER` in `vitest.config.ts` is
load-bearing — throttle-last).

## Invariants (do not break)

1. **Kernel API only.** All reads and writes go through the kernel HTTP API.
   Never write `.sy` files. (Structural: the agent runs in a jailed microVM;
   host files are invisible. Also avoids torn-write hazards.)
2. **Every kb tool call routes through `gate.ts`.** Gate order is pinned:
   shape → breaker → 429 cooldown → `kb` param — refused locally with zero
   kernel calls before any op runs. Never call the kernel client outside this
   path.
3. **Strict full-version write gate.** `PINNED_SIYUAN_VERSION` (validation.ts).
   Writes refuse on *any* drift (behavior drift lands in minor releases);
   reads warn and proceed. The client (`siyuan-kernel-api`) fetches versions
   and owns no pin — the extension owns the pin + policy.
4. **Upgrade checklist.** On any SiYuan upgrade: run the full integration suite
   against the new kernel *before* re-pinning — a red suite means re-verify the
   affected behaviors, never a version-number bump. Same discipline for
   `node-sql-parser` (exact-pinned; re-run the parser certification matrix) and
   `pi-tool-masking`.
5. **Query certification is parser-based.** Single-table SELECT over
   `blocks`/`refs` only; scoping rides the extension-owned `box IN (...)`
   spliced into the AST and re-parsed for verification. DML is rejected at the
   parser; kernel-side, DML through `/api/query/sql` is a silent no-op in every
   mode (3.8.4 hardening), so a certification bug cannot write siyuan.db.
6. **Never silently wrong.** Kernel results that can lie (silently-rolled-back
   inserts, silent no-op DML, silent path-shape drops, hpath-as-address) are
   verified against the live block tree / by-ID asserts, never trusted from the
   HTTP result. When adding a write mode, keep this: verify post-write with
   `getChildBlocks` walk evidence.
7. **Soft scope, tool-surface-only guards.** The API token is a workspace-admin
   credential; the threat model is model accident, not a hostile agent. All
   guards (parser certification, `method: 0`, scoping, write grant) are
   tool-surface-only — an agent holding the token can bypass them. Hard
   isolation = separate SiYuan instances, if ever needed.
8. **Zero model calls.** The extension makes no model/provider calls. The agent
   is the intelligence; SiYuan is the memory.
9. **No build step.** Raw `.ts` at the repo root (flat layout, NodeNext —
   import local modules with `.js` extensions). No bundler, no `dist/`.

## Key kernel facts (3.8.4, pinned by integration tests)

- Doc identity is the docId; hpath is a derived display label — never an
  address. Mint by title, discover by query/search, consume by ID.
- Doc titles store **verbatim** in `blocks.content` (HTML-escaped form lives
  only in the title IAL). `blocks.sort` is a type weight, not document order —
  never enumerate live-doc structure via SQL; use `getChildBlocks`.
- Doc nesting is the hpath chain (`parent_id` empty on `'d'` rows); ancestor/
  self-subtree moves are rejected synchronously.
- Post-write index convergence is asynchronous: `content` ~1.5–3 s, `refs`
  ~2–3 s, `hpath` after doc-level moves only on the next index pass. Tree
  endpoints (`getChildBlocks`, `exportMarkdown`) are synchronous.
- DML through `/api/query/sql` is a silent no-op in every mode (3.8.4
  hardening).
- Auth throttle: 6th consecutive auth failure within 15 min locks the IP
  (60 s → exponential, 15 min cap); any request during a lock extends it. 429
  is never counted toward the extension breaker and never retried.

## Deferred roadmap (next steps)

- **RAG / vector sidecar (v2 primary)** — external sidecar fed by
  `exportMdContent`/`query/sql`, never a second writer. Vectors are derived
  data over the same storage; store the embedding model id per-vector (no
  dimension columns in durable storage) so model swaps are re-embeds, not
  migrations.
- **Embedding-assisted dedup → primary identity mechanism.** The title guard
  (exact + space/hyphen/underscore legs) stays as the zero-dep fallback
  (`near_matches` → `degraded_dedup`).
- Smaller parked items (upgrade paths from the archived doc's ceiling table):
  spill-file cleanup pass if /tmp usage ever matters; named KB groups for
  subset scope switching; per-mode `kb_write` allowlist; cross-KB moves;
  host-side asset fetch if image-bearing docs need distilling.

## Concessions (named, not hidden)

- **Model-in-the-loop recall is untested.** The integration suite drives the
  extension through the deps seam; no automated test asks a real model to
  choose to write or to recall. The full loop (remember X → restart → ask for
  X) has manual click-through as its only available check.
- **Soft scope.** See invariant 7. Token in settings.json is readable by the
  agent's own tools — accepted deployment posture.

## Reference

- `siyuan-kernel-api` repo: client design constraints live in its AGENTS.md
  (policy-free surface, transport contract, error classes).
- Archived design rationale: the full `DESIGN_v2.md` (recoverable from git
  history once removed from the working tree — see header), incl.
  kernel-behavior findings worth re-reading before sidecar work (derived-index
  convergence timings, 429 lock-extension behavior).
