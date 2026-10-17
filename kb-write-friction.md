# GNUbrain KB write-tool friction points

Observed hands-on while editing the `scratch` KB (Kim Simons artist doc), 2026-10-13.
All findings verified against the live kernel, not assumed from docs.

## 1. Heading delete does not cascade to section body

`mode: delete` with a heading's `blockId` removes **only the heading block**. The section
body survives and re-parents to the nearest preceding heading — with no warning in the
response ("0 orphaned refs" refers to cross-document refs, not orphaned content blocks).

- Failure looks like success. Contaminated content lands in an unrelated section where it
  can sit unnoticed until someone reads the doc closely.
- Full section removal requires N deletes: heading + each top-level body block. Children
  *inside* a list container go with the container, so a single-list section costs 2 deletes;
  a section with mixed paragraphs + lists costs one delete per top-level block.
- Recoverable (delete the re-parented container afterward), but only if you notice.

## 2. Heading move leaves the body behind (same problem, move flavor)

`mode: move` on a heading block moves only the heading. Body blocks stay at the old
location and re-parent to the preceding heading, exactly as in delete. Verified by moving
a section heading to another section and querying the body block's `parent_id`.

- A section move used to be expressible as: move the heading, then move each
  top-level body block — with an ordering trap (moving the heading back lands it
  *after* the orphaned body, since "end of section" anchors to the re-parented
  body as the last child). As of the fold-blind move refusals, the tool no
  longer permits the heading-first step at all: `moveBlockVerified` refuses
  section-bearing heading targets fold-blind and pre-mutation
  (`heading-with-section`, plus the matching anchor-arm refusal
  `heading-anchor-with-section`) — the kernel's move scope for such headings
  is fold-dependent hidden state (folded, the section travels along;
  unfolded, the body is orphaned exactly as described above). The workaround
  the refusal wording itself advises: move the body blocks individually
  against a derived section-end anchor, or use `append` for section-start
  placement. The sanctioned single-call replacement is `move-section`
  (below).

## 3. Section-level anchoring can refuse a legitimate-looking move

Anchoring `toHeadingId` to heading H means "end of H's section." If the block already
directly follows H's content, the kernel refuses with "already sits at the destination
position." Correct behavior, but surprising: there is no way to express "re-nest this
section under that heading" via move at all.

## 4. True outline nesting is a heading-level edit, not a move

In the markdown outline, a `##` heading following another `##` heading's content is a
sibling section regardless of position. Nesting a section under another means **demoting
the heading's `#` level** (one `edit` call on the heading text); the body follows
automatically since nothing moves. This is not documented anywhere obvious and took an
experiment to discover.

## 5. Block index lags after writes (stale reads)

After a successful write, `kb_query` can still return pre-write rows (deleted blocks
reappearing, pre-edit content). One write also produced "block not found" for a block the
same index had just served, and a verified-edit false alarm. Writes themselves succeeded;
only the read side lagged.

- Practical rule: after any structural write, verify with a **fresh `kb_read`**, never a
  cached result or an immediately-following query.

## 6. Edit replaces block type as well as content

`mode: edit` replaces the block with the given markdown as-is. Editing a list-item block
without including the `- ` marker converts it to a paragraph; sibling list items can be
collapsed with it. Keep the list marker in replacement markdown when the target is a list
item.

## Status

All three suggestions have landed: the `delete-section` mode (one verified
section-removal call with a partial-apply receipt — not atomic; the honest
claim is "one call, verified, partial-apply receipt"), the heading-delete
report (a heading-scoped `mode: delete` names the member blocks left in
place), and the heading-demotion idiom + "end of section" anchor semantics
in the `kb_write` tool description. The kernel-fact corrections folded out
of the original suggestions — the corruption is outline/section ownership,
not a tree-parent change, and the delete path is fold-blind (`node.Unlink()`,
no `IsSelfFolded` — unlike move) — now live in the primitives'
`deleteSection.ts` module doc and the AGENTS.md fact lists. The remaining
open item is `move-section`
([`docs/move-section-plan.md`](docs/move-section-plan.md), deferred).
