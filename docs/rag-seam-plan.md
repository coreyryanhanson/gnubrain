# RAG seam — issue drafts

Paste-ready issue drafts for the seam described in [`rag-integration.md`](./rag-integration.md).
Nothing here has been created on GitHub; `gh` is not installed in the development VM, so
these are drafts to create when convenient.

Each draft has a title, target repository, suggested labels, dependencies, scope,
acceptance criteria, tests, and the files it touches.

## Repositories

| Layer | Repository | Remote |
| --- | --- | --- |
| 1 | `siyuan-kernel-api` | `github.com/coreyryanhanson/siyuan-kernel-api` |
| 2 | `siyuan-kb-primitives` | `github.com/coreyryanhanson/siyuan-kb-primitives` |
| 3 | `gnubrain` | `github.com/coreyryanhanson/gnubrain` |

## Sequencing

| # | Issue | Repo | When | Depends on |
| --- | --- | --- | --- | --- |
| 1 | v1: rename `kb_search` echo field `box` → `kb` | gnubrain | v1 | — |
| 2 | v1: rename `searchBoxes` → `keywordSearchBoxes` | siyuan-kb-primitives | v1 | — |
| 3 | Add `semanticSearch` and `embeddingStat` client methods | siyuan-kernel-api | post-v1 | — |
| 4 | Add `semanticSearchBoxes` and `embeddingReadiness` primitives | siyuan-kb-primitives | post-v1 | 3 |
| 5 | Add `KbHit` record and the RRF fusion function (pure, unwired) | gnubrain | post-v1 | 4 |
| 6 | Wire `kb_search { mode }`: two arms, RRF, availability policy | gnubrain | post-v1 | 5 |

Issues 1 and 2 are independent of the seam and land with v1. Issues 3–5 are the seam and
land bottom-up (each is a release of the layer below). Issue 6 is the feature.

## Creating these

Labels below are suggestions; check each repository's actual label set first
(`gh label list --repo <repo>`). To create, save a draft body to a file and pass it:

```sh
gh issue create --repo coreyryanhanson/gnubrain \
  --title "v1: rename kb_search echo field box → kb" \
  --label breaking-change \
  --body-file /tmp/issue-1.md
```

---

## 1. v1: rename `kb_search` echo field `box` → `kb`

**Repo:** `coreyryanhanson/gnubrain` · **Labels:** `breaking-change`, `v1` ·
**Depends on:** none

### Context

`kb_search` rows echo `box` as the **resolved KB name**, while `kb_query` rows carry `box`
as the **raw kernel box ID** (it is the SQL column the agent selects, and the tool scopes
with `box IN (…)`). The same field name means two different things across two read tools.

The agent passes KB *names* to `kb_read` and `kb_write` and never writes box IDs, so the
resolved value is the one that deserves a name matching the tool parameter.

### Scope

Rename the echo field in `kb_search` rows from `box` to `kb`, and update
`SEARCH_DESCRIPTION` to say `kb (the resolved KB name)`. Leave the raw `box` column in
`kb_query` rows untouched.

### Acceptance criteria

- `kb_search` rows carry `kb` (the resolved KB name) instead of `box`.
- `SEARCH_DESCRIPTION` names `kb`, and no longer describes an echoed `box`.
- `kb_query` rows are unchanged; the discovery-pattern wording that selects the raw `box`
  column still refers to `box`.
- This is the only breaking output change in v1, and it ships with v1.

### Tests

- Update the `runSearchFanOut` merged-row assertions in `__tests__/unit/tools.test.ts`
  (the two-row fan-out case).
- Update the `SEARCH_DESCRIPTION` wording assertions if any test pins that string.

### Files

- `tools.ts` — the echo object in `runSearchFanOut`, and `SEARCH_DESCRIPTION`.
- `__tests__/unit/tools.test.ts`.

---

## 2. v1: rename `searchBoxes` → `keywordSearchBoxes`

**Repo:** `coreyryanhanson/siyuan-kb-primitives` · **Labels:** `breaking-change`, `v1` ·
**Depends on:** none

### Context

`searchBoxes` is the keyword fan-out: one scoped `fullTextSearchBlock` call per box. The
seam adds a semantic counterpart, `semanticSearchBoxes`. Renaming the keyword function now
gives the pair symmetric names, and the package is pre-release, so the rename is cheap.
Deferring it would cost a primitives release plus a downstream pin bump later, for nothing.

### Scope

Rename the exported function and update every call site and test. No behaviour change.

### Acceptance criteria

- The read barrel exports `keywordSearchBoxes` and no longer exports `searchBoxes`.
- `gnubrain`'s `runSearchFanOut` calls the new name.
- `index.test.ts` (barrel completeness) passes.
- `check-pack.mjs` passes — the `package.json` `files` list is unchanged, since no module
  is added.

### Tests

- Rename call sites in the primitives' own unit tests.
- Update the primitives' README/API examples if the function is named there.

### Downstream follow-up

`gnubrain` v1 must pin the primitives release containing this rename; v1 needs an exact pin
anyway to drop the `file:` co-development link.

### Files

- `search.ts`, `index.ts`, `package.json` (no change expected), tests, `README.md` if the
  function is documented.
- `gnubrain/tools.ts` (call site).

---

## 3. Add `semanticSearch` and `embeddingStat` client methods

**Repo:** `coreyryanhanson/siyuan-kernel-api` · **Labels:** `enhancement` ·
**Depends on:** none

### Context

SiYuan 3.8.6 exposes `POST /api/search/semanticSearchBlock` (same request and response
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

## 4. Add `semanticSearchBoxes` and `embeddingReadiness` primitives

**Repo:** `coreyryanhanson/siyuan-kb-primitives` · **Labels:** `enhancement` ·
**Depends on:** issue 3

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

## 5. Add `KbHit` record and the RRF fusion function (pure, unwired)

**Repo:** `coreyryanhanson/gnubrain` · **Labels:** `enhancement` ·
**Depends on:** issue 4

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
- New root `.ts` files ship automatically (`files: ["*.ts"]`).

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

## 6. Wire `kb_search { mode }`: two arms, RRF, availability policy

**Repo:** `coreyryanhanson/gnubrain` · **Labels:** `enhancement` ·
**Depends on:** issue 5

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
