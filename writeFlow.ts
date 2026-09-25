// Shared scaffolding for the write flows: the flow input shape, doc-target
// ownership resolution, and the shared target reads — everything the
// per-mode flow files
// (writeCreate/writeEdit/writeAppend/writeReplaceSection/writeDelete/writeMove)
// build on.

import {
	errorEnvelope,
	type Envelope,
	noSuchDocEnvelope,
	refusedEnvelope,
} from "./envelope.js";
import {
	ownershipStmt,
	resolveHeadingTarget,
	rootEcho,
	type KernelProbeResult,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";
import { inlineOrSpill, jsonl } from "./spill.js";
import type { ContentBaselines } from "./baselines.js";
import { writeEchoTail } from "./writeResult.js";
import type { WriteParams } from "./writeSchema.js";

/** Flow input shared by every mode, create included — one declaration so
 * the fields (and their contracts) cannot drift between create and the
 * per-mode flows. */
export interface WriteFlowBase {
	sessionId: string;
	kernel: WriteKernelClient;
	/** Resolved KB name + notebook id (the gate already validated both). */
	name: string;
	boxId: string;
	/** Captured content body ("" on body-less modes). */
	body: string;
	baselines: ContentBaselines;
	/** Fires at the flow's first kernel call — kernel-free refusals
	 * (shape, grant, drift) must not reset the breaker's consecutive count. */
	contact: () => void;
	/** The gate's probe verdict, stamped by prepareWrite's caller — the
	 * session-start value, or the fresh re-probe on the retry path. The
	 * verdict primitives require it; the gate refuses the
	 * unreachable/never-probed members before any flow runs, so only the
	 * narrow KernelProbeResult reaches here. */
	probe: KernelProbeResult;
}

export interface WriteFlowInput extends WriteFlowBase {
	params: WriteParams;
}

export interface DocTarget {
	rootId: string;
	title: string;
}

/** Every non-create mode takes docId — an echoed target, ownership-
 * checked by the scoping query (an id from another KB reads as
 * nothing). The statement itself lives in the primitives beside the
 * block-row shape it encodes; this side owns only the refusal. */
export async function resolveDocTarget(
	kernel: WriteKernelClient,
	boxId: string,
	name: string,
	docId: string,
): Promise<DocTarget | Envelope> {
	const rows = await kernel.query(ownershipStmt(boxId, docId));
	const rootId = rows[0] === undefined ? undefined : String(rows[0].root_id);
	if (rootId === undefined) {
		return noSuchDocEnvelope(name, docId);
	}
	const root = await rootEcho(kernel, boxId, rootId);
	if (root === undefined) {
		return errorEnvelope(
			`doc '${docId}' has no type='d' root row in KB '${name}'`,
		);
	}
	return { rootId: root.docId, title: root.title };
}

/** The stale-heading refusal — shared by headingInWalk and replace-section's
 * section-membership fallback, which both reject the same target. */
export function staleHeadingMessage(headingId: string, doc: DocTarget): string {
	return `headingId '${headingId}' is not a heading of doc '${doc.title}' (${doc.rootId}) — stale or foreign target; re-fetch the outline (kb_read) and re-target`;
}

/** The heading-target refusal map — wording only. The judgment (membership
 * + write-parent targetability, the kernel's CheckContainerParent set) is
 * the primitives' `resolveHeadingTarget`; a section target inside `tabs` or
 * an unnamed container (wire type "", e.g. a footnote definition) would
 * place the write in a container the kernel rejects, so the untargetable
 * arm refuses with the same re-target guidance every flow shares. */
export function headingInWalk(
	walk: WalkedBlock[],
	doc: DocTarget,
	headingId: string,
): WalkedBlock | Envelope {
	const outcome = resolveHeadingTarget(walk, headingId);
	switch (outcome.kind) {
		case "heading":
			return outcome.heading;
		case "stale":
			return refusedEnvelope(staleHeadingMessage(headingId, doc));
		case "untargetable": {
			const container =
				outcome.containerType === ""
					? "an unnamed container"
					: `a '${outcome.containerType}' container`;
			return refusedEnvelope(
				`headingId '${headingId}' (${outcome.headingContent}) sits inside ${container}, which the kernel does not accept as a write-parent — not a targetable heading; re-target a heading in the doc, a quote, a list, a superblock, a callout or a tab`,
			);
		}
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled heading-target arm");
}

/** Error-path echo reads are garnish: the verdict (the transport message or
 * the kernel's own error) is already correct without the outline, so a
 * dropped re-read must not mask it — unwrapped, the echo's transport throw
 * would escape the flow's per-arm mapping and runKbCall would reclassify a
 * kernel-answered call as "SiYuan unreachable". Success-path echoes
 * (finishWrite) stay loud on purpose: a dropped verification read must read
 * as unverified, never as success. Exported for the write flows' per-arm
 * refusal envelopes — every mode now maps its primitive outcomes here and
 * applies the same garnish rule. */
export async function errorTail(
	input: WriteFlowBase,
	doc: DocTarget | undefined,
): Promise<Record<string, unknown>> {
	if (doc === undefined) return {};
	try {
		return await echoTail(input, doc);
	} catch {
		return {};
	}
}

/** writeEchoTail with the flow's fixed identity args bound — call sites
 * pass only an optional pre-fetched verification walk and the write's own
 * block IDs (only on the success paths — a write that did not land
 * refreshes nothing, or it would launder a concurrent change). */
export async function echoTail(
	input: WriteFlowBase,
	doc: DocTarget,
	walk?: WalkedBlock[] | undefined,
	refreshBlockIds?: readonly string[],
): Promise<Record<string, unknown>> {
	return writeEchoTail({
		kernel: input.kernel,
		sessionId: input.sessionId,
		boxId: input.boxId,
		docId: doc.rootId,
		baselines: input.baselines,
		walk,
		refreshBlockIds,
	});
}

/** The delete receipt: what a delete-bearing op removed — block ids and
 * their walk content, covering both the members the sweep deleted
 * explicitly and the descendants the kernel's cascade took with them
 * (the closure is exactly what left the doc). Built from the walk the
 * flow already holds — zero extra kernel calls. Inline within the shared
 * preview budget; overflow spills the full JSONL and the pointer rides as
 * a sibling field, the same contract as `outline`/`fullOutlinePath`. */
export function deletedBlocksTail(
	sessionId: string,
	blocks: { id: string; content: string | null }[],
): Record<string, unknown> {
	const rows = blocks.map((b) => ({ id: b.id, content: b.content }));
	const { inline, spillPath } = inlineOrSpill(
		sessionId,
		"kb_write-deleted-blocks",
		jsonl(rows),
		"jsonl",
	);
	if (spillPath === undefined) return { deletedBlocks: rows };
	return { deletedBlocksPreview: inline, deletedBlocksPath: spillPath };
}
