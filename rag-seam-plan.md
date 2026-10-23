# RAG seam — issue drafts

Paste-ready issue drafts for the seam described in [`rag-integration.md`](./rag-integration.md).
Nothing here has been created on GitHub; `gh` is not installed in the development VM, so
these are drafts to create when convenient.

> **Version note.** Cited SiYuan **3.8.6** source facts (`semanticSearchBlock`,
> `embeddingStat`, `block_embeddings` schema) re-verified unchanged against the pinned
> **3.8.8**.

Each draft has a title, target repository, suggested labels, dependencies, scope,
acceptance criteria, tests, and the files it touches.

## Repositories

| Layer | Repository | Remote |
| --- | --- | --- |
| 1 | `siyuan-kernel-api` | `github.com/coreyryanhanson/siyuan-kernel-api` |
| 2 | `siyuan-kernel-primitives` | `github.com/coreyryanhanson/siyuan-kernel-primitives` |
| 3 | `gnubrain` | `github.com/coreyryanhanson/gnubrain` |

## Sequencing

| # | Issue | Repo | When | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Add `semanticSearch` and `embeddingStat` client methods | siyuan-kernel-api | post-v1 | — |
| 2 | Add `semanticSearchBoxes` and `embeddingReadiness` primitives | siyuan-kernel-primitives | post-v1 | 1 |
| 3 | Add `KbHit` record and the RRF fusion function (pure, unwired) | gnubrain | post-v1 | 2 |
| 4 | Wire `kb_search { mode }`: two arms, RRF, availability policy | gnubrain | post-v1 | 3 |

Issues 1–3 are the seam and land bottom-up (each is a release of the layer below). Issue 4
is the feature.

## Creating these

Labels below are suggestions; check each repository's actual label set first
(`gh label list --repo <repo>`). To create, save a draft body to a file and pass it:

```sh
gh issue create --repo coreyryanhanson/siyuan-kernel-api \
  --title "Add semanticSearch and embeddingStat client methods" \
  --label enhancement \
  --body-file /tmp/issue-1.md
```

---

## 1. Add `semanticSearch` and `embeddingStat` client methods

**Repo:** `coreyryanhanson/siyuan-kernel-api` · **Labels:** `enhancement` ·
**Depends on:** none

### Context

SiYuan 3.8.8 exposes `POST /api/search/semanticSearchBlock` (same request and response
shape as `fullTextSearchBlock`) and `POST /api/ai/embeddingStat` (embedding readiness).
The client currently exposes neither, so the layer above cannot reach the kernel's
semantic recall or its readiness probe.

### Scope

- `semanticSearch({ query, paths, page?, pageSize? })` → `/api/search/semanticSearchBlock`.
  Same parameters as `fullTextSearch`, but **no `method` field** — the semantic endpoint ignores
  it, and omitting it keeps the request minimal.
- `embeddingStat()` → `/api/ai/embeddingStat`, returning `{ enabled, total, indexed,
  pending, failed, ignoredByLen, ignoredByConfig }`.
- Add an `EmbeddingStat` type.

Both endpoints are authenticated (the kernel guards them with auth plus admin role), so
both ride the normal request path and the existing token attachment.

### Acceptance criteria

- `semanticSearch` returns the existing `SearchResult` shape; no new response type.
- `embeddingStat` returns the readiness record; `page`/`pageSize` are omitted from the
  wire body when unset, matching `fullTextSearch`.
- Both names are added to the pinned public surface and the signature-checked `ARGS` map
  in `census.test.ts` — an unpinned method must remain a compile error.
- The kernel's response carries **no relevance score**; the client must not invent one.

### Tests

- `client.test.ts`: request mapping for each method (path, body, omitted fields) and token
  attachment.
- `census.test.ts`: the two new names in both the surface list and the `ARGS` map.
- Optional live case against a kernel with the AI feature available.

### Files

- `client.ts`, `types.ts`, `census.test.ts`, `client.test.ts`.

---

## 2. Add `semanticSearchBoxes` and `embeddingReadiness` primitives

**Repo:** `coreyryanhanson/siyuan-kernel-primitives` · **Labels:** `enhancement` ·
**Depends on:** issue 1

### Context

The keyword path fans out one scoped kernel call per notebook, because the kernel shares a
single `pageSize` window across every `paths` entry of one call. The semantic path needs
the same fan-out, plus a readiness primitive so the tool layer can refuse honestly when
embeddings are unconfigured.

### Scope

- `semanticSearchBoxes(client, { query, boxIds, pageSize })` — one scoped call per box,
  with the same contamination backstop as the keyword fan-out.
- `embeddingReadiness(client)` — reports `enabled`, `total`, `indexed`, `pending`,
  `failed`, `ignoredByLen`, `ignoredByConfig` straight from the kernel.
- Report-only: outcome data and evidence, no refusal policy and no wording.

### Acceptance criteria

- Both return kernel-shaped evidence; neither owns prose.
- The read barrel exports both, and `index.test.ts` (barrel completeness) passes.
- Any new module is added to the `package.json` `files` list; `check-pack.mjs` passes.

### Gotcha — do not reuse the keyword window-evidence shape

`BoxSearchResult.hidden` is `matchedBlockCount − rows.length`. For keyword that is honest
(the kernel's count is a real SQL count). For semantic it is not:
`SemanticSearchBlock` sets `matchedBlockCount = h.Len()`, where the heap is capped at
`page * pageSize` or at `rerankCandidateCount()` (default 30) when rerank is enabled. That
is a candidate-window size, not a match total, so:

- `hidden` would read as zero almost always, regardless of matches beyond the window.
- With rerank enabled, a `pageSize` above the candidate count returns fewer rows than
  requested, silently.

So the semantic primitive needs its own result shape, or explicitly named fields, and
downstream truncation claims must never be driven by semantic counts.

### Tests

- Unit: one call per box, correct scoping, contamination backstop, and the window evidence
  the semantic arm can honestly report.
- Unit: `embeddingReadiness` mapping for enabled/disabled and pending/failed counts.
- Live: a case that **self-skips when `embeddingStat.enabled === false`**, since CI has no
  embedding-configured kernel.

### Files

- `search.ts` (or a sibling for the semantic fan-out), a new `embedding.ts` (or equivalent),
  `index.ts`, `package.json` `files`, unit tests, one live test.

---

## 3. Add `KbHit` record and the RRF fusion function (pure, unwired)

**Repo:** `coreyryanhanson/gnubrain` · **Labels:** `enhancement` ·
**Depends on:** issue 2

### Context

Fusion needs one shape for a hit and one pure function to merge ranked lists. Both belong
in the tool layer, because only the consumer of a merged list needs a merged shape — arms
have to agree on exactly two things, identity (block ID) and their own ordering. This
lands now, unwired, so the feature release is small.

### Scope

- The hit record:

  ```ts
  type KbHit = {
    blockId: string;                 // block ID — the identity space and dedup key
    docId: string;                   // the doc kb_read consumes
    hpath: string;                   // derived display label, never an address
    kb: string;                      // resolved KB name
    updated: string;
    arms: ("keyword" | "semantic")[];
  };
  ```

  No `score` (the kernel returns none), no `rank` (fusion derives rank from each arm's
  ordered list), no per-hit `stale` (the index caveat is envelope-level).
- The RRF function: `score(d) = Σ over arms 1 / (k + rank_arm(d))`, `k = 60`. Input is one
  ranked `KbHit[]` per arm; output is a single ranked `KbHit[]` with `arms` filled in.

### Acceptance criteria

- Both are pure: no client, no kernel access, no I/O.
- Extending `arms` with a future value (for example `"refs"`) is a type-only change; the
  function is generic over lists of hits.
- Nothing is wired into `kb_search` in this issue.
- New root `.ts` files ship automatically (`files: ["*.ts", "!vitest.config.ts"]`).

### Tests

Pure unit tests for the fusion function:

- empty arm (one arm returns nothing) — the other arm's order survives;
- both arms populated;
- a block present in both arms is deduplicated, with `arms` carrying both values;
- deterministic tie-breaking;
- single-arm passthrough.

Plus a unit test for the `KbHit` mapping from a kernel row.

### Files

- New `kbHit.ts` (type and mapping), new `rrf.ts`, new unit tests.

---

## 4. Wire `kb_search { mode }`: two arms, RRF, availability policy

**Repo:** `coreyryanhanson/gnubrain` · **Labels:** `enhancement` ·
**Depends on:** issue 3

### Context

The feature itself: let the agent choose an arm and get an honestly-labelled merged list.

### Scope

- Add `mode: "keyword" | "semantic" | "hybrid"` to the `kb_search` schema, defaulting to
  `keyword`. The schema stays closed (`additionalProperties: false`).
- `keyword` runs the existing fan-out. `semantic` runs only the semantic arm. `hybrid`
  runs both and fuses them with RRF.
- The envelope names which arms ran and which rows came from which arm.
- Availability policy, owned here:
  - `semantic`/`hybrid` with embeddings unconfigured → `status: refused`, naming the fix
    (configure an embedding model in SiYuan).
  - embeddings configured but `embeddingStat.pending > 0` → run anyway, with an
    index-pending caveat on the envelope.
  - never return an empty `ok` in place of "the embedder is not configured".
- Extend the gate's mode/body-shape leg to validate `mode`.

### Acceptance criteria

- `mode` is validated locally before any kernel call, in the pinned gate order.
- `semantic` with no embedder refuses; it never silently degrades to keyword.
- `hybrid` results are deduplicated by block ID with both arms recorded.
- The description documents the three modes and the embedding prerequisite.

### Tests

- Tool-flow tests through the existing harness with a kernel stubbed per arm, covering:
  keyword-only, semantic-only, hybrid dedup and ordering, refusal when unconfigured, and
  the index-pending caveat.
- One live end-to-end case with an embedding-configured kernel (self-skipping otherwise).

### Files

- `tools.ts` (schema, description, flow), `tools.test.ts`, integration tests, and the
  gate's mode leg in `gate.ts` if it needs extending.
