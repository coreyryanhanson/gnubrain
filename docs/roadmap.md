# GNUbrain roadmap

GNUbrain is open-source agent memory for the [pi](https://pi.dev) coding agent, built on
[SiYuan](https://siyuan.b3log.org). It turns a SiYuan workspace into a knowledge base your
agent can query, search, read, and — with your approval — write to.

This roadmap describes where the project is going and, just as importantly, where it is
**not**. It is a living document, maintained by the project maintainer.

## Why GNUbrain exists

Most agent memory lives in a service you don't own: a vector database, a hosted index, a
vendor's API. Your notes end up split across two systems that can disagree, and the memory
you rely on is something you can't read or fix by hand.

GNUbrain takes the opposite position. **Your notes are the memory.** The agent works
directly against a SiYuan workspace you already own, using the storage engine you already
run. That gives you three things:

- **No lock-in.** No vendor, no proprietary note app, no required model or embedding
  provider. Notes stay in standard SiYuan notebooks, readable by any other tool.
- **No surprise calls or costs.** The extension itself never calls a model. There are no
  keys to manage, no background spend, and no second service to keep alive.
- **Memory you can inspect and correct.** Because the store is human-readable, you can read
  what the agent knows, fix it, or delete it — by hand, in the same app.

[gbrain](https://github.com/garrytan/gbrain) proved how much a real brain layer adds to an
agent. GNUbrain applies that lesson to a substrate you already own instead of a new one you
have to run.

## Scope

GNUbrain is a **memory and retrieval substrate** over your own notes:

- **Read** a document as markdown, with a heading outline you can navigate.
- **Search** across your knowledge bases.
- **Query** the note index with read-only SQL.
- **Write** (create, edit, append, replace a section, move, delete) behind a per-KB approval.
- Over time: **structured memory** (typed metadata and attributed claims), **stronger
  retrieval** (semantic search fused with keyword search, and the links between notes), and
  **session context** (a small set of notes your agent is handed when a session starts).

The detailed design for retrieval lives in [`rag-integration.md`](./rag-integration.md) and
[`rag-seam-plan.md`](./rag-seam-plan.md).

## Non-goals

These are deliberate and, in most cases, permanent:

- **Not multi-user.** One person, one workspace. Team memory and shared institutions are a
  different product.
- **Not remote.** No hosted service, no HTTP API, and not reachable from other agent
  harnesses. GNUbrain runs where your notes and your agent run.
- **Not an ingestion product.** No connectors for email, chat, GitHub, voice, or PDFs. You
  write in SiYuan; the agent writes what it reads.
- **No background daemon.** No scheduler, no overnight jobs, no worker process holding your
  notes open. Work happens when you ask for it.
- **Not a decision-support or analytics engine.** No scoring, forecasting, or autonomous
  judgment. The agent reasons; GNUbrain supplies the evidence.
- **Not an "answer" engine.** GNUbrain returns ranked evidence, not synthesized prose. The
  point is to hand your agent the material and let it think.
- **No model calls by the extension**, ever as a default. GNUbrain never locks you into a
  provider.
- **Not a code-intelligence tool.** Your editor and agent already understand code.
- **Text first.** Other content types are a direction we're keeping open, not a promise.

## Now

The work that is landing or starts immediately after the first release:

- **First release (v1).**
  - `kb_search` results echo **`kb`** (the resolved KB name) instead of `box`.
  - The keyword fan-out is named **`keywordSearchBoxes`**, making room for a semantic
    counterpart.
  - Echoed row handles use the same vocabulary the tools accept — **`docId` / `blockId`** —
    instead of raw kernel names, so a hit can be fed straight back into a tool call.
  - The **`kb` parameter shapes** and the `"kbs"` discovery value are frozen deliberately.
- **A stability guarantee, enforced.** An additive-only contract test ships with v1: it
  fails CI if any tool parameter, response field, or status changes in a breaking way. The
  promise below is not just a policy — it is checked.
- **Typed metadata (read and write).** Read and write per-block custom attributes. This is
  the foundation for structured memory: facts, tags, and relationships can all carry typed
  metadata rather than living in prose.
- **A conventions layer.** Shipped guidance so the agent files, links, and maintains notes
  the same way every time — the cheapest way to add capability without adding tools.

## Next

- **Hybrid retrieval.** Semantic search fused with keyword search, opt-in per call, so
  concept questions and exact-match questions both work.
- **Section and evidence context.** Hits come back with the surrounding section or the whole
  note, not a bare snippet, so the agent doesn't have to fetch each hit separately.
- **References and backlinks.** Retrieval that can follow the links between your notes — the
  relationship signal keyword and vector search both miss.
- **Session memory.** A small, budgeted set of notes handed to the agent at session start,
  so it begins a session already oriented.
- **Tags.** First-class tags you can write and search by.

## Later

Real possibilities, not commitments — these depend on what users actually need:

- **Identity and claims.** A structured memory layer: named entities (people, companies,
  projects) and attributed claims you can recall by name.
- **Typed links and traversal.** Answering relationship questions across several notes.
- **An evaluation harness.** Measuring whether a retrieval change actually helps.
- **Larger-scale retrieval.** A vector index alongside the kernel's own, only if the built-in
  path hits its limits at real corpus sizes.
- **Non-text content.** Images and other files.
- **Retrieval feedback.** Teaching ranking which notes turned out to be useful.

## Stability promise

- **From v1, the tool contract is additive-only.** Tool names, parameters, and response
  fields will not break. New capability arrives as new optional parameters, new fields, or
  new tools; what works today keeps working.
- **Settings keys are additive-only from v1.**
- If something ever does need to be retired, it gets a documented deprecation cycle rather
  than a silent change.

Before v1 ships, the surface may still change. From v1 on, it won't break.

## Getting involved

Contributions, issues, and experiments are welcome. The most useful things to bring:
unusual note structures, retrieval questions that don't work well today, and conventions or
recipes that make the agent better at maintaining a knowledge base.
