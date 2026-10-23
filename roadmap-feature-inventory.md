# GNUbrain feature inventory (internal working reference)

> **Internal working reference.** This is not the public roadmap — that is
> [`roadmap.md`](./roadmap.md). This document records what `gbrain` does, how each
> capability maps onto SiYuan/GNUbrain, and its verdict. The assumptions ledger at the top
> is the decision reference: read it before proposing a feature.

Reference project: `garrytan/gbrain`, read at **0.60.207.0**.

## How verdicts are derived

Classify by **contradiction with a stated assumption**, not by predicted future cost:

- Contradicts a **firm** assumption → **Never** (revisable only by changing the assumption).
- Gated by an **on-the-table** assumption → **Ajar** ("not planned; don't preclude").
- Contradicts nothing → **Backlog**, additive by default, with a priority (now/next/later).
- **Recipe** — the agent can already compose it from existing tools; a convention, not a
  capability, so it needs no architectural bin.
- **Shipped** — already exists today.

Verdict vocabulary: `Never` · `Ajar` · `Backlog (now|next|later)` · `Recipe` · `Shipped`.

## Assumptions ledger (ratified)

| # | Assumption | Status | Gates |
| --- | --- | --- | --- |
| L1 | **Scope:** memory + retrieval substrate over the user's own SiYuan notes; analysis/advice/ontology/chronicle are recipes, not engines; not an ingestion, decision-support, or multi-user product | **firm** | decision-model engines, code-intel → Never; recipes → Recipe |
| L2 | The extension makes no model calls (current state) | **firm** | baseline |
| L3 | An optional provider/LLM seam may be added later (the door) | **on the table** | model-call features → Ajar |
| L4 | Single writer; no daemon / background worker | **firm** | cron/Minions, dream, facts-drain, connector sync → Never |
| L5 | Local single-user; no network server surface; not reachable by other harnesses | **firm** | multiuser/remote/OAuth/visibility, MCP/non-pi → Never |
| L6 | Address by block/doc ID; `hpath` is a label, never an address | **firm** | baseline |
| L7 | An entity/claim identity spine may be added later | **on the table** | identity/claim features → Ajar |
| L8 | Content is text today; other modalities may come | **on the table** | non-text retrieval → Ajar (storage already native) |
| L9 | Tool contract: closed schemas, additive-only envelopes | **firm** | makes backlog additive-by-default |
| L10 | SiYuan kernel version pinned exactly | **firm** | baseline |

L2 describes *now*; L3 is the *door*. A model-call feature is judged against the door
(Ajar), never killed by L2.

## Feature verdicts

| Family | gbrain | GNUBrain mapping | Verdict |
| --- | --- | --- | --- |
| A1 Per-block attribute read | dedicated DB columns | expose the kernel `attributes` table to `kb_query` | `Backlog (now)` |
| A2 Per-block attribute write | columns + migrations | add `setBlockAttrs` to the write surface, verified | `Backlog (now)` |
| A3 Entity identity & aliases | slug + resolution ladder (`page_aliases`) | name→docId resolution; native `blocks.alias` | `Ajar` (L7) |
| A4 Block/doc address model | slug is the address | block/doc IDs, `hpath` a label (as-is) | `Shipped` (L6) |
| A5 Tags | `tags` table + ops | SiYuan native tags (`blocks.tag`), unused today | `Backlog (next)` |
| A6 Typed links (write) | zero-LLM edge extraction | `refs` (untyped) or attribute-view relations | `Ajar` (L7) |
| B1 Claim/fact record | `facts` row: kind/provenance/ttl/confidence/lifecycle | a block (or attribute-view row) carrying typed attributes | `Ajar` (L7) |
| B2 Dedup & supersession | embedding cosine ≥ 0.95, zero LLM | kernel-native semantic index | `Ajar` (L7) |
| B3 Trust tiers / confirmation | `confirm_memory` | the write grant already is the trust interaction | `Shipped` (via grant) |
| B4 Batch remember | `remember { items[] }` ≤20 | write-envelope batching | `Ajar` (L7) |
| C1 Keyword search | keyword arm | `kb_search` per-KB fan-out | `Shipped` |
| C2 Hybrid RAG | vector + BM25 + RRF, rerank, boosts | kernel-native hybrid, RRF in the tool layer, `mode` param | `Backlog (next)` |
| C3 `recall` (facts arm) | protocol verb | needs B1 | `Ajar` (L7) |
| C4 `entity` card | protocol verb (p99 < 100ms) | composes existing reads + refs; needs A3 | `Ajar` (L7) |
| C5 Session/core memory | `always_load: true` pages render into every session | pi `session_start` prompt injection (verified feasible) | `Backlog (now)` |
| C6 `delta` change feed | keyset-cursor change feed | agent polls `updated` via `kb_query` | `Backlog (later)` |
| C7 `forget` / purge | expire (never delete); owner-only purge | needs B1; the user can edit/delete in the UI | `Ajar` (L7) |
| C8 Evidence delivery (`return_unit`) | chunk/window/section/page, token-budgeted | section aggregation on the block tree | `Backlog (now)` |
| D1 Refs/backlinks arm | `get_backlinks`/`traverse_graph` | `refs` reachable via SQL; no primitive | `Backlog (next)` |
| D2 Typed traversal / multi-hop | relational planner over typed edges | native attribute-view relations | `Ajar` (L7) |
| D3 Section / contextual retrieval | section units; synopsis-wrapped embeddings | section cheap on a block tree; contextual needs a sidecar | `Backlog (next→later)` |
| D4 Relevance scores / autocut / CRAG | scores available | the kernel returns none | `Backlog (later)` |
| D5 Vector sidecar / ANN | Postgres+pgvector, ANN build | kernel-native brute-force cosine | `Backlog (later)` |
| E1 Takes (typed weighted claims) | `takes_*`, fence, resolve | a `kind`/`weight` attribute; calibration is an engine | `Recipe` |
| E2 Timeline | `timeline_entries`, write-through | a date attribute on blocks | `Recipe` |
| E3 Ontology (dimensions/asof/conflicts) | `ontology_*` | application semantics over claims | `Recipe` |
| E4 Open loops | `open_loops` engine fed by connectors | needs ingestion | `Never` (L1/L4) |
| E5 Chronicle | `chronicle_*`, auto event extraction | manual log is a recipe; auto needs ingestion + judgment | `Recipe` / `Never` as engine |
| E6 Trajectory / calibration | `find_trajectory`, `takes_calibration` | trajectory = recipe; calibration = engine | `Recipe` / `Never` (calibration) |
| E7 Schema packs / typed page kinds | `schema_*` pack enforcement | native typed blocks + attribute views; redundant | `Never` (L1) |
| E8 Attribute-view schema conventions | schema packs | documented convention over native attribute views | `Backlog (next)` |
| F1 `synthesize` / `think` | LLM answer verb, cost block | forbidden by L2; the door is L3 | `Ajar` (L3) |
| F2 Pinned questions | `questions_*`; paid refresh | the agent maintains standing answers via `kb_write`/`kb_search` | `Ajar` (L3) |
| F3 Retrieval feedback / rating | `rate_answer` (zero LLM) | needs an answer surface + telemetry | `Backlog (later)` |
| F4 Decision-model class | System One: decision slots backed by a hosted decision model — gbrain's own reference implementation is a closed-weight vendor (TypeSafe Jev), alongside an `llm:` provider option | the agent's job; the plugin ships no judgment engine. If ever built it would be a **decision-model class** using an **open-weight** model (e.g. Laya, Clef) — never a closed-weight vendor | `Never` (L1) |
| F5 Insights (anomalies/experts/salience) | `find_*` analytics | recipes via `kb_query` | `Recipe` |
| F6 Advisor | `advisor` | recipes / conventions | `Recipe` |
| G1 Connectors (chat/GitHub/Google/media/voice/PDF) | connector suite + sync lifecycle | ceded; the user's SiYuan is the source | `Never` (L1/L4) |
| G2 Agent-driven ingestion | `capture`, `put_page` | `kb_write` | `Shipped` |
| G3 Always-on daemon / cron / Minions | Minions queue + cron | pi `/command` the user starts/stops | `Never` (L4) |
| G4 Background enrichment / dream / facts-drain | cycle phases, auto-extraction | the agent does enrichment on request | `Never` (L4) |
| G5 Multi-source / multi-brain / federation | two axes + remote federation | multiple KBs in one kernel | `Never` (L1/L5) |
| H1 Multiuser / remote / OAuth / visibility | `mcp expose`, OAuth, scopes | local pi extension, one user, workspace-admin token | `Never` (L5) |
| H2 MCP / non-pi harness + conformance | MCP server, certified protocol | pi-only | `Never` (L5) |
| H3 Agent-facing error/consent contract | `AGENT_OPERATOR_v1` | status envelope + refusal wording | `Backlog (later)` |
| H4 Admin SPA / gbrain-scale doctor | admin SPA + deep doctor | status slot + startup validation | `Never` (L1); a minimal `/kb doctor` is `Backlog (later)` |
| H5 Evals / benchmark | BrainBench, capture/replay | a small local eval harness (R9) | `Backlog (next)` |
| H6 Skills / conventions layer | 26+/306 markdown skills | pi skills / prompt templates | `Backlog (now)` |
| H7 Code intelligence | `code_*` ops + code edges | the agent already has code tooling | `Never` (L1) |
| H8 Multimodal (image/audio) | image embeddings, image-as-query | assets are stored natively; retrieval is not | `Ajar` (L8) |

## Substrate facts GNUbrain inherits (verified in SiYuan 3.8.8 source)

- `blocks` carries `ial`, **`alias`**, `name`, `memo`, `tag`, `subtype`.
- **`attributes`** table (`id, name, value, type, block_id, root_id, box, path`) plus
  `getBlockAttrs` / `batchGetBlockAttrs` / `setBlockAttrs` — per-block typed metadata.
- **`refs`** (with `type`), maintained by the single writer; no extraction pass needed.
- **Attribute-view "databases"** — native typed fields, relations, rollups.
- **`block_embeddings`** + `semanticSearchBlock` — a native embedding index.
- `spans`, `assets` — inline spans and stored files (so non-text storage is native).
- One store, one writer, **no fence↔DB reconcile**; human-in-the-loop by construction;
  a block is a stable sub-document identity.

Advantages this buys over the reference project: no second store and no reconciliation
cycle (gbrain's page-lock/`.tmp`/quarantine machinery exists only because it lacks this);
identity is already stable, so only name→ID resolution is missing; typed metadata is native;
refs/backlinks are maintained by the writer; memory is inspectable and correctable in the
same editor the human uses.

**Enabler (currently locked):** `kb_query` allowlists only `blocks`/`refs`, and there is no
attribute read/write in the tool surface. A1/A2 unlock the rest of the metadata path.

## Recipes (agent-composable — conventions, no architectural bin)

Insights, advisor, ontology, chronicle, trajectory, takes, timeline. These are jobs the
agent composes from `kb_query`/`kb_read`/`kb_write`/`kb_search`; the risk is claiming them
as capabilities before the conventions layer (H6) exists to encode how they are done.

## Related documents

- [`roadmap.md`](./roadmap.md) — the public roadmap (benefit-framed; no ledger/risks/seams).
- [`rag-integration.md`](./rag-integration.md), [`rag-seam-plan.md`](./rag-seam-plan.md) —
  the decided RAG shape.
