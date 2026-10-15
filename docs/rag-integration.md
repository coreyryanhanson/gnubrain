# RAG integration — design

Status: decided, not implemented. v1 ships without RAG; the seam lands in the first
post-v1 release.

> **Version note.** Kernel facts below were read from SiYuan **3.8.6** source. The pin
> is now **3.8.7** (`siyuan-kb-primitives/version.ts`); these substrate facts —
> `kernel/api/search.go`, `kernel/model/embedding.go`, `kernel/conf/ai.go` — have **not**
> been re-verified against 3.8.7. Re-verify (AGENTS.md upgrade checklist) before issue 1
> lands.

Scope: how retrieval-augmented search enters the GNUbrain stack (`gnubrain` →
`siyuan-kb-primitives` → `siyuan-kernel-api`), what it costs, and what would justify
building an external vector store later.

## 1. Summary

SiYuan 3.8.6 already contains a complete retrieval substrate: a block-level embedding
indexer, a semantic search endpoint, an optional cross-encoder rerank, and readiness
probes. The kernel is the vector store. It is written by the single writer that owns the
content, it keys every vector to a block ID (the identity space the other three kb tools
already use), and our extension makes no model call to use it — SiYuan calls the embedding
provider.

That makes "build a vector sidecar" the wrong first move. The plan is instead:

- **v1:** ship clean, RAG-free — the search vocabulary (`kb` / `docId` / `blockId`,
  `keywordSearchBoxes`, layer-1 `fullTextSearch`) is already in its final shape.
- **First post-v1 release:** land the seam — a layer-1 `semanticSearch` method, layer-2
  `semanticSearchBoxes` and `embeddingReadiness` primitives, and (in `gnubrain`) the
  `KbHit` record plus the RRF fusion function, pure and unwired.
- **After that:** wire `kb_search { mode }` to run keyword + semantic and fuse them.

Retrieval stays inside the project's existing invariants: kernel HTTP API only, no second
writer, zero model calls by the extension, kernel-coupled behaviour falsified in layer 2.

## 2. Goal

Decide the target architecture for RAG and prepare the seam so the feature itself is a
small follow-up. Specifically:

- Pick a retrieval substrate and write down the conditions that would change the choice.
- Fix the shape of a search hit so every arm can feed one fusion path.
- Keep the seam additive and small enough to land without risking the first release.

## 3. Non-goals

Explicitly out of scope, now or for the first RAG cut:

- No RAG in v1.
- No external vector store or sidecar unless the revisit trigger fires (§10).
- No refs-graph arm and no ranking boosts in the first cut.
- No relevance score field on results.
- No sub-document chunking or contextual wrapping.
- No typed-edge, link, or code graph retrieval.
- No multimodal (image) retrieval.
- No multi-source federation across workspaces.
- No private-visibility filtering for untrusted callers (the threat model is model
  accident under a workspace-admin token; hard isolation is separate instances).
- No evaluation harness or scored retrieval benchmark.

## 4. What the kernel provides (SiYuan 3.8.6, read from source)

### 4.1 Embedding index

`kernel/model/embedding.go` and `embedding_store.go` run a background indexer over
`block_embeddings`:

```text
id, root_id, box, path, embedding (float32 BLOB), model, content_len,
updated, fail_count, last_tried, ignored_type
```

- One embedding per **block**. Content under 7 bytes or over 12,000 bytes is skipped and
  recorded as ignored rather than embedded (`embeddingMinTextLen`, `embeddingMaxContentLen`).
- `.siyuan/embeddingignore` excludes paths by gitignore-style glob.
- Failed blocks back off (30 s doubling to 30 min) and stop being scheduled after 8
  consecutive failures.
- Encrypted notebooks are excluded — the table does not exist in the encrypted database.
- Requests are batched **10 inputs per call**; a response that returns fewer vectors than
  inputs is treated as a whole-batch failure.

### 4.2 Configuration

One flat, user-owned record (`Conf.AI.Embedding`):

```text
{ id, enabled, apiKey, baseURL, name, timeout, dimensions }
```

- The request is the standard OpenAI embeddings call: `POST {baseURL}/embeddings` with
  `{ input, model, dimensions? }`.
- `dimensions: 0` (the default) omits the parameter, so the provider's native width is
  used; a positive value is passed through as OpenAI's `dimensions`.
- There is **no provider registry and no forced default** (`defaultEmbedding()` is
  `{ Timeout: 30 }`). The user picks the endpoint, the model, and the width.
- Storage is a `float32` BLOB, so the kernel is dimension-agnostic — there is no
  `vector(N)` column to migrate.
- `isEmbeddingEnabled()` requires `apiKey` to be non-empty, so a keyless local server
  (llama.cpp) needs a placeholder key.
- Compatibility: any server speaking `POST /v1/embeddings` that returns one vector per
  input in order. OpenAI-compatible hosted endpoints work; `llama-server --embeddings`
  works.

Two traps worth stating plainly:

- **Changing the model or width does not re-embed.** The pending query only selects rows
  that were never embedded or that failed. Existing vectors keep their old width, and
  `cosineSimilarity` returns `0` on a length mismatch — so after a model change, older
  content silently stops matching until **Rebuild embedding index**
  (`/api/ai/reindexEmbedding`) is run.
- With an unconfigured embedder, the semantic endpoint returns an **empty result set**,
  wire-identical to "no matches". That is the silent-wrongness case the tool layer must
  refuse around (§8).

### 4.3 Search endpoints

`POST /api/search/semanticSearchBlock` takes the same request shape as
`fullTextSearchBlock` (`query`, `paths`, `types`, `subTypes`, `page`, `pageSize`) and
returns the same `SearchBlock` / `SearchBlocksData` shape. Internals:

- Embeds the query with the configured model, then scans `block_embeddings` by rowid in
  4096-row pages, scoring cosine similarity in parallel across workers.
- Keeps a bounded heap of the top `page * pageSize` candidates — or a fixed
  `rerankCandidateCount()` (5–100, default 30) when rerank is enabled.
- Optionally reranks those candidates with a configured cross-encoder. The reranker is an
  intra-semantic-arm reorder, not a keyword/semantic fusion.
- Applies `boxes`/`paths`/`types` filters. Scoping was broken in 3.7.0 and is fixed in
  the pinned version.
- Returns **no relevance score** — no cosine, no rerank score. Only ordering.

Probes, all authenticated:

| Endpoint | Returns |
| --- | --- |
| `/api/ai/embeddingStat` | `enabled`, `total`, `indexed`, `pending`, `failed`, `ignoredByLen`, `ignoredByConfig` |
| `/api/ai/testEmbeddingModel` | connectivity + the provider's actual returned width |
| `/api/ai/reindexEmbedding` | clears and re-embeds (async) |
| `/api/ai/retryFailedEmbedding` | re-queues failed blocks (async) |

### 4.4 Roadmap

The embedding/semantic wave was milestone 3.8.0 (epic #17788: "AI capability
enhancement"). 3.8.1 added nested rerank request/response formats. 3.8.4 fixed embedding
indexing scheduling and connection-error recovery, including a llama.cpp local-endpoint
`EOF` failure — local embedding servers are a supported, maintained path.

The maintainer's stated posture (#18039) is OpenAI-spec request parameters only; the
`dimensions` configuration did land, but per-role parameters such as Voyage's `input_type`
stay out of scope.

There is **no** roadmap item for relevance scores, an ANN index, sub-block chunking, a
contextual wrapper, a typed graph, or multimodal embeddings. Upcoming milestones are
unrelated (3.9.0: encrypted notebooks and flashcards; 4.0.0: global attributes).

Conclusion: the kernel's retrieval feature is recent and actively maintained but
deliberately narrow. Waiting for it to close the gaps below is not a plan.

## 5. Options considered

**A. Kernel-native hybrid (chosen).** Keyword + semantic through the kernel, fused with
RRF in the tool layer. One identity space, one writer, no new dependency, no model call by
the extension, and the embedding provider stays the user's choice.

**B. External vector sidecar.** A separate package with its own store (PGLite + pgvector,
sqlite-vec, LanceDB, usearch), its own chunker, and its own embedding calls. This buys the
capabilities in §6 that the kernel cannot supply — at the cost of a second store, a second
identity space, a sync lifecycle, a native/WASM dependency, and an extension that must
call an embedding provider. That last one is an invariant break, and it is the same
architecture that made gbrain's embedding configuration something to fight rather than
configure.

**C. Two-tier.** Kernel-native by default, sidecar for one named gap. Maximum capability,
maximum surface: two indexes, two lifecycles, one query path.

The decision is A. B is not rejected as a permanent answer — it is gated by §10.

### 5.1 Why not vector-only, and what the reference implementation proves

`gbrain` (the upstream personal-brain project this design borrows lessons from) layers
vector search, BM25 keyword search, RRF fusion, and a typed knowledge graph, with a
cross-encoder reranker, source/alias/title boosts, per-page pooling, an evidence contract,
autocut, intent classification, query expansion, and CRAG-style confidence grading.

Its own benchmark is the useful part: vector-only ≈ keyword-only ≈ hybrid ≈ **18 P@5**;
adding the graph takes it to **49.1**. Two lessons follow. First, hybrid fusion is worth
having but is not where the large gains live. Second, the largest gain came from an
explicit graph — which SiYuan already maintains (`refs`, backlinks), and which we
deliberately deferred to the second RAG iteration.

## 6. The give-up ledger

What kernel-native costs, and whether it is recoverable.

### Not recoverable (the kernel has no primitive)

| Capability | Why |
| --- | --- |
| Relevance scores | The search response carries none, so threshold filtering, score-grounded evidence, autocut, and score-based confidence grading are all unavailable. |
| Rerank control | The kernel reranks by global configuration; there is no per-call model, candidate-window, or on/off control, and no audit. |
| Sub-document chunking | One vector per block, no overlap, no merge of small blocks, no split of blocks over 12,000 bytes. |
| Contextual retrieval wrapper | Embeddings are computed over raw block content; there is no way to prepend document or section context, and no synopsis generation. |
| Embedding provenance and auto re-embed | No drift detection or signature stamping; a model change needs a manual rebuild (§4.2). |
| ANN index | Semantic recall is a brute-force cosine scan of the whole table per query. |
| Autocut / CRAG | Both need scores. |
| Typed-edge, link, and code graphs | Only raw block refs exist, untyped and not integrated into ranking. |
| Multimodal retrieval | Text blocks only. |
| Code-aware chunking | Not a kernel concept. |
| LLM query expansion, LLM intent classification | Excluded by the zero-model-calls invariant, not by the kernel. |

### Recoverable in the tool layer

Evidence by arm membership; path boosts and exclusions; recency decay from `updated`;
title matching and an exact-title probe; dedup, per-page pooling, and type diversity;
adaptive result sizing; token-budget enforcement; a query cache; a coarse index-lag
signal; and an untyped refs-neighbor arm.

### Kept, and worth stating

One identity space (block IDs); a single writer, so no torn dual-write; a
dimension-agnostic store with no `vector(N)` migration; no provider registry and no model
lock-in; zero model calls by the extension; a kernel-maintained index (dirty events,
backoff, retry, ignore file); and notebook/type filters, pagination, and rerank for free.

## 7. Decisions

| ID | Decision |
| --- | --- |
| **Root** | Decide the target architecture and prepare the seam now; ship RAG just after the first release. v1 stays RAG-free. |
| **B1** | Kernel-native is the target, with the documented revisit trigger in §10. `KbHit` stays substrate-agnostic so a future sidecar could feed the same path. |
| **B2** | Two arms — keyword (`fullTextSearchBlock`) and semantic (`semanticSearchBlock`) — fused by RRF in the tool layer. Evidence is arm membership (`keyword` / `semantic` / `both`). No refs arm, no ranking boosts in the first cut. |
| **B3** | `kb_search` gains `mode: "keyword" \| "semantic" \| "hybrid"`, defaulting to `keyword`. Backwards compatible; the agent opts in explicitly; the envelope names the arms that ran. |
| **B4** | `semantic`/`hybrid` with embeddings unconfigured → `status: refused`, naming the fix. Embeddings configured but the index behind (`embeddingStat.pending > 0`) → run anyway, with an index-pending caveat on the envelope. |
| **B5** | Pre-seam delivery: layer-1 `semanticSearch` + `embeddingStat`; layer-2 `semanticSearchBoxes` + `embeddingReadiness`; `KbHit` and RRF in `gnubrain`, pure and unwired. The `mode` param, the two-arm flow, and the wiring follow. |
| **B5a** | `KbHit = { blockId, docId, hpath, kb, updated, arms }`. No `score`, no `rank`, no per-hit `stale`. `kb_search` rows echo the tool vocabulary (`blockId`/`docId`/`hpath`/`kb`/`updated`) rather than raw kernel names (`id`/`root_id`/`box`). |
| **B6** | Layered falsification (§9). No retrieval-quality benchmark yet. |
| **B7** | Revisit thresholds deferred; the trigger is block-grain context loss and the response ladder is recorded (§10). Numbers are not invented. |
| **B8** | v1 ships clean; the seam lands in the first post-v1 release, bottom-up. Non-goals as in §3. |

### Rationale notes

- **Fusion belongs to the tool layer.** Only the consumer of a merged list needs a merged
  shape. Arms have to agree on exactly two things: identity (block ID) and their own
  ordering. So `KbHit` lives where fusion lives, and a future sidecar emits its own rows
  for the tool to adapt. Putting the record in layer 2 would put result vocabulary and
  tool-surface policy into a package whose job is version-pinned kernel primitives, and
  would couple every hit-shape change to the primitives' release cadence.
- **RRF is the right fusion here** precisely because it consumes only ranks, and ranks are
  the one thing the kernel does give us. A weighted blend would be impossible without
  scores and would be misleading anyway.
- **No score field.** Adding an optional field later is backward compatible, so reserving
  it now buys nothing and costs a field that is always undefined. A single numeric score
  would also be incoherent across arms (cosine similarity and cross-encoder logits live on
  different scales), and agents are known to misread blended scores as calibrated
  confidence — the failure mode that motivated the reference implementation's evidence
  contract. If a grounded signal ever arrives, the right addition is a named evidence
  label, not a bare float.
- **`kb` vs `box`.** `kb_search` rows echo `kb` — the resolved KB name, matching the tool
  parameter the agent already passes to `kb_read` and `kb_write` — and `box` keeps exactly
  one meaning: the raw kernel box ID in `kb_query`'s SQL rows.

## 8. Availability and honesty

`kb_search` is the discovery tool; a wrong-but-quiet answer is worse than a refusal.

| Situation | Behaviour |
| --- | --- |
| `mode: "keyword"` | Always available; current behaviour. |
| `mode: "semantic"` / `"hybrid"`, embeddings unconfigured | `status: refused`, with a message naming the fix (configure an embedding model in SiYuan). Never an empty ok. |
| `mode: "semantic"` / `"hybrid"`, embeddings configured, `embeddingStat.pending > 0` | Run anyway; stamp an index-pending caveat on the envelope, because results are ranked from an index that is behind the content. |
| `mode: "semantic"` / `"hybrid"`, embeddings configured, index idle | Normal path. |
| `mode: "keyword"` with embeddings unconfigured | Normal keyword path; the embedder is irrelevant to this arm. |

The readiness probe is `/api/ai/embeddingStat`. The tool layer owns the refusal wording
and the policy; the primitive reports the facts.

## 9. Validation

Layered falsification, matching the existing discipline (layer 2 falsifies version-pinned
kernel behaviour in its own suites; the tool layer pins its own wording and policy).

**Layer 1 — `siyuan-kernel-api`**
- Unit tests for the `semanticSearch` request mapping (query, paths, page, pageSize) and
  for token attachment.
- Updated `census.test.ts`: the two new names join the pinned public surface and the
  signature-checked `ARGS` map, which makes an unpinned method a compile error.

**Layer 2 — `siyuan-kb-primitives`**
- Unit tests for `semanticSearchBoxes` mirroring the keyword fan-out: one scoped call per
  box, the contamination backstop, and the window evidence that the semantic arm *can*
  honestly report (see §11).
- Unit tests for `embeddingReadiness` mapping.
- One live case that **self-skips when `embeddingStat.enabled === false`**, because CI has
  no embedding-configured kernel.

**Layer 3 — `gnubrain`**
- Pure unit tests for the `KbHit` mapping.
- Pure unit tests for RRF: empty arm, both arms, deduplication of a block present in both
  arms, deterministic tie-breaking, single-arm passthrough.

**Later (post-v1, with the feature)**
- Tool-flow tests through the existing harness, with the kernel stubbed per arm.
- One live end-to-end case with an embedding-configured kernel.

No retrieval-quality benchmark. Without scores from the kernel, and with no labelled
corpus, a scored benchmark would measure our own judgement of our own rankings.

## 10. Revisit trigger and escalation ladder

The design is kernel-native until one of these is true. The first is the real one.

1. **Block-grain context loss (the likely trigger).** A real miss whose answer needs
   cross-block or section context, or content that lives inside blocks the indexer ignored
   (under 7 or over 12,000 bytes).
2. Score-grounded evidence is needed — threshold filtering, autocut, or a confidence grade.
3. Semantic latency becomes unacceptable at a real corpus size (no invented ceiling;
   measure once at ship time and record it).
4. Encrypted-notebook recall is needed.

**Escalation ladder before building a sidecar:**

1. **Refs arm.** SiYuan already maintains `refs`/backlinks; an untyped neighbor arm is
   kernel-native, free of model calls, and the largest known retrieval lever (§5.1).
2. **Section aggregation and section context on hits.** Group block hits by heading and
   surface the heading chain, so the agent receives the context the per-block embedding
   lacked.
3. **Contextual retrieval / late chunking** (sidecar tier). Both require embedding text
   *with* context, which the kernel's per-block indexer cannot do.

Why the ordering: the research is consistent that the deficiency is context, not size.
Naive chunking embeds chunks independently, so taking text out of context can render it
ineffective; long-context compression dilutes meaning, so small chunks *with* context beat
larger chunks. Prepending chunk context before embedding cut top-20 retrieval failures by
49% (67% with reranking). Pooling independently-embedded block vectors produces a
legitimate coarse section vector but adds no cross-block context — it is the very
construction late chunking criticizes, and is useful only as a cheap coarse index. Vector
arithmetic for relationships is not dependable for modern contrastive embeddings; the
dependable relationship signal is an explicit graph.

If a sidecar is ever built, **PGLite + pgvector** is the first candidate: real HNSW ANN,
WASM rather than a native build, published with provenance, and already proven in the
reference implementation. `sqlite-vec` is the lightweight alternative but is brute-force
only. `@lancedb/lancedb` and `usearch` offer ANN with prebuilt natives at the cost of
native surface; `hnswlib-node` compiles at install and is unsuitable for a `pi install`
package.

## 11. Implementation gotcha: no honest window evidence for the semantic arm

`BoxSearchResult.hidden` is computed as `matchedBlockCount − rows.length`. For keyword
search that is honest, because the kernel's count is a real SQL count of matches.

For semantic search it is not. `SemanticSearchBlock` sets
`matchedBlockCount = h.Len()` where the heap is capped at `page * pageSize`, or at
`rerankCandidateCount()` (default 30) when rerank is enabled. That is a *candidate-window*
size, not a match total. Consequences:

- `hidden` would read as zero almost always, regardless of how many matches exist beyond
  the window.
- With rerank enabled, a `pageSize` larger than the candidate count returns fewer rows than
  requested, silently.

Therefore `semanticSearchBoxes` must not reuse `BoxSearchResult`'s window-evidence fields.
It needs its own result shape — or explicitly named fields — and the query envelope's
`truncated` claim must never be driven by semantic counts.

## 12. Churn

Measured against the current tree: roughly 440–470 lines, about 250 of them tests, additive,
across ~14 files in three repositories.

#### Layer 1 — `siyuan-kernel-api` (~90 lines, 4 files)
- `client.ts`: `semanticSearch` (no `method` field on the wire) and `embeddingStat`.
- `types.ts`: an `EmbeddingStat` type.
- `census.test.ts`: two names in the pinned surface list and two entries in the
  signature-checked `ARGS` map.
- `client.test.ts`: two cases.

#### Layer 2 — `siyuan-kb-primitives` (~160 lines, 5–6 files)
- `search.ts`: `semanticSearchBoxes`.
- New `embedding.ts`: `embeddingReadiness` — requires a `package.json` `files` entry and a
  barrel export; `index.test.ts` enforces barrel completeness and `check-pack.mjs` enforces
  the file list.
- Unit tests, plus one self-skipping live case.

#### Layer 3 — `gnubrain` (~190 lines, 5 files)
- `KbHit` type, `rrf.ts`, and their unit tests. New root `.ts` files ship automatically.

## 13. Rollout

**v1:** ships clean, RAG-free. The vocabulary the seam needs is already frozen:
`kb_search` rows echo `kb` / `docId` / `blockId`, the primitives export
`keywordSearchBoxes`, and layer 1 exposes `fullTextSearch` — no breaking change is left
between v1 and the seam.

**First post-v1 release:** the seam, bottom-up.
1. `siyuan-kernel-api` — `semanticSearch` + `embeddingStat` + census pin.
2. `siyuan-kb-primitives` — `semanticSearchBoxes` + `embeddingReadiness` (depends on 1).
3. `gnubrain` — `KbHit` + `rrf.ts`, pure and unwired (depends on 2).

**Second post-v1 release:** the feature — `mode` on `kb_search`, the two-arm flow, RRF
wiring, and the availability policy.

The dependency arrow stays one-way, and each step is a release of the layer below it, so
the seam lands as three small additive releases rather than one entangled change. Note that
the seam's primitives are exported but unused in the release that introduces them.

## 14. Open items

- Numeric thresholds for the latency trigger (deferred deliberately, §10).
- Whether a refs arm moves into the first RAG cut — currently deferred to the second
  iteration, and the first rung of the escalation ladder.
- Per-KB dominance behaviour when a single semantic call spans several notebooks: scoping
  works, but ranking across a union of boxes has not been measured.
- Whether `KbHit` should carry section context once the second ladder rung is built.

## Appendix: sources

Kernel source read at the pinned version: `kernel/model/embedding.go`,
`kernel/model/embedding_store.go`, `kernel/api/search.go`, `kernel/api/ai.go`,
`kernel/apicontract/search_block.go`, `kernel/apicontract/ai.go`,
`kernel/conf/ai.go`, `kernel/util/openai.go`, `kernel/sql/database.go`,
`app/src/config/tabs/ai/aiTab.ts`, `appearance/langs/en.json`,
`docs/API.md`.

Tracked repository behaviour and roadmap: issues #17788 (embedding/semantic epic, 3.8.0),
#18030 (semantic notebook scoping, broken in 3.7.0 and fixed), #18039 (custom embedding
request parameters — maintainer: OpenAI-spec only), #19245 (embedding indexing scheduling
and connection recovery, 3.8.4); milestones 3.8.7, 3.9.0, 4.0.0.

External reading: Jina AI, "Late Chunking in Long-Context Embedding Models" (2024) and
arXiv 2409.04701; Anthropic, "Introducing Contextual Retrieval" (2024) — top-20 failure
rate 5.7% → 2.9% with contextual embeddings plus contextual BM25, → 1.9% with reranking.

Package candidates evaluated (versions current at the time of writing): `@electric-sql/pglite`
0.5.9 with pgvector; `sqlite-vec` 0.1.9; `@lancedb/lancedb` 0.40.0; `usearch` 2.26.4;
`hnswlib-node` 3.0.0; `@orama/orama` 3.1.18; `vectra` 0.15.0; local embedding options
`@huggingface/transformers` 4.3.1, `fastembed` 3.0.0, `node-llama-cpp` 3.22.1.
