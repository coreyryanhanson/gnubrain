// The `kb_write` create flow: title guard (exact leg, then near-match
// scan) → submission path from ground truth → verified-create by-ID asserts
// → echo, with guard-stop draft staging.

import {
	GUARD_NEAR_CAP,
	SiYuanApiError,
	docMarkdown,
	findTitleMatches,
	firstChildContent,
	walkBlockTree,
	type GuardRow,
	type WalkedBlock,
} from "siyuan-kb-primitives";
import { createVerifiedDoc } from "siyuan-kb-primitives/write";
import { type Envelope } from "./envelope.js";
import { spillFile, withRowPayload } from "./spill.js";
import { rememberServedRows } from "./baselines.js";
import { serveOutline, serveOutlineFromWalk } from "./outline.js";
import type { WriteFlowBase } from "./writeFlow.js";
import { finishWrite } from "./writeResult.js";
import { createVerdictEnvelope } from "./writeVerdicts.js";

export interface CreateFlowInput extends WriteFlowBase {
	/** Minted (normalized) title — the kb_write entry validated it. */
	title: string;
	parentId?: string | undefined;
	/** True when the body came from markdownFile — staging is skipped. */
	bodyFromFile: boolean;
	confirmNew: boolean;
}

async function duplicateStop(
	input: CreateFlowInput,
	title: string,
	rows: GuardRow[],
): Promise<Envelope> {
	const { kernel, sessionId, name } = input;
	const detailed: Record<string, unknown>[] = [];
	const walks: WalkedBlock[][] = [];
	for (const row of rows) {
		const docId = row.root_id;
		// Guard-stop evidence is presentation-only: the write never fires on
		// this path, so a candidate deleted between the guard query and these
		// reads degrades to an empty outline/excerpt (nearMatchStop's rule)
		// instead of discarding the whole duplicate stop. The strict posture
		// stays reserved for write-verification walks. One walk per row also
		// serves both the outline and (single-row) the block-ID payload —
		// never a second traversal of the same doc.
		const walk = await walkBlockTree(kernel, docId, {
			tolerateVanished: true,
		});
		walks.push(walk);
		// The stop serves heading content — seed the baselines so a follow-up
		// edit on a served heading verifies against what the agent saw here,
		// not against content read at edit time (which launders a concurrent
		// kernel-side change past the stale_content precondition).
		const outline = serveOutlineFromWalk(
			sessionId,
			"kb_write",
			walk,
			input.baselines,
		);
		let markdown = "";
		try {
			const md = await docMarkdown(kernel, docId);
			markdown = md.content;
		} catch (err) {
			// Same vanished-candidate rule as the walk above.
			if (!(err instanceof SiYuanApiError)) throw err;
		}
		const markdownPath = spillFile(
			sessionId,
			"kb_write-candidate",
			markdown,
			"md",
		);
		detailed.push({
			docId,
			title: row.content,
			updated: row.updated,
			outline: outline.outline,
			markdownPath,
		});
	}
	const docIds = detailed.map((d) => d.docId).join(", ");
	const envelope: Envelope = {
		status: "duplicate",
		message:
			`${rows.length} existing doc${rows.length === 1 ? "" : "s"} titled '${title}' in KB '${name}': ${docIds} — ` +
			`reconcile by docId (edit/append onto the wanted doc), or pass confirmNew: true to mint a conscious second doc`,
		kb: name,
		rows: detailed,
	};
	// Single-row: block IDs with content so the agent can go straight to
	// `edit` by blockId — reuses the outline walk already in hand.
	if (rows.length === 1) {
		const blocks = walks[0]!.map((b) => ({
			id: b.id,
			type: b.type,
			content: b.content,
		}));
		// Same serve-time seeding as the outline above — blockIds is the
		// payload the agent is invited to edit by id.
		rememberServedRows(input.baselines, blocks);
		withRowPayload(envelope, sessionId, "kb_write-blocks", "blockIds", blocks);
	}
	return stagedEnvelope(envelope, input);
}

async function nearMatchStop(
	input: CreateFlowInput,
	title: string,
	rows: GuardRow[],
): Promise<Envelope> {
	const { kernel, name } = input;
	const candidates: Record<string, unknown>[] = [];
	for (const row of rows) {
		// First child block's content — cheap and excerpt-only by design
		// (near-match tier). The document-order read itself lives in the
		// primitives; only the swallow policy stays here (a vanished
		// candidate mid-scan means an empty excerpt, row still shown;
		// auth/rate-limit/network rethrow for runKbCall's classification).
		let firstParagraph = "";
		try {
			firstParagraph = (await firstChildContent(kernel, row.root_id)) ?? "";
		} catch (err) {
			if (!(err instanceof SiYuanApiError)) throw err;
			firstParagraph = "";
		}
		candidates.push({
			docId: row.root_id,
			title: row.content,
			firstParagraph,
			updated: row.updated,
		});
	}
	const envelope: Envelope = {
		status: "near_matches",
		message:
			`near-matches exist for '${title}' in KB '${name}' — pass confirmNew: true to create anyway, ` +
			`or read an existing topic by docId and edit it`,
		kb: name,
		candidates,
	};
	if (rows.length > GUARD_NEAR_CAP) {
		envelope.truncated = `capped at ${GUARD_NEAR_CAP} candidates — refine the title`;
		candidates.length = GUARD_NEAR_CAP;
	}
	return stagedEnvelope(envelope, input);
}

/** Guard-stop draft staging: an inline body is staged so the retry
 * travels by path (~25 tokens) instead of re-transmitting the full draft.
 * Creates that already used markdownFile stage nothing. */
function stagedEnvelope(envelope: Envelope, input: CreateFlowInput): Envelope {
	if (input.bodyFromFile) return envelope;
	const stagedPath = spillFile(input.sessionId, "draft", input.body, "md");
	envelope.stagedPath = stagedPath;
	envelope.message += ` — body staged at ${stagedPath}; retry with markdownFile: '${stagedPath}'`;
	return envelope;
}

/** The `create` flow: title guard (exact leg, then near-match scan) →
 * guarded-create primitive (parent read-back, mint, verified-create by-ID
 * asserts) → echo (root docId, stored title, real hpath, fresh outline).
 * `confirmNew: true` bypasses both guard legs; the per-KB grant (resolved
 * at the kb_write entry) and the primitive's asserts still apply. */
export async function runCreateFlow(input: CreateFlowInput): Promise<Envelope> {
	const { kernel, sessionId, name, boxId } = input;
	const title = input.title;

	// Guard — exact leg first; only an empty exact leg runs the scan. The
	// primitive fires the single pre-legs contact (reset-on-success) itself.
	if (!input.confirmNew) {
		const matches = await findTitleMatches(kernel, input.contact, boxId, title);
		if (matches.kind === "duplicate") {
			return duplicateStop(input, title, matches.rows);
		}
		if (matches.kind === "near") {
			return nearMatchStop(input, title, matches.rows);
		}
	}

	// The version-coupled core — submission path from ground truth, the
	// mint, and the verified-create asserts — lives in the primitive; its
	// required probe carries the gate's verdict and the drift refusal is
	// the primitive's own arm.
	const outcome = await createVerifiedDoc(kernel, input.probe, input.contact, {
		boxId,
		title,
		body: input.body,
		...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
	});
	if (outcome.kind !== "created") {
		return createVerdictEnvelope(outcome, { name });
	}

	// Post-mint echo: a network drop here must never read as "unreachable" —
	// the mint is already verified by the primitive's asserts (finishWrite
	// doc).
	return finishWrite(input.name, { docId: outcome.docId }, async () => {
		const outline = await serveOutline(
			kernel,
			sessionId,
			"kb_write",
			outcome.docId,
			input.baselines,
		);
		return {
			status: "ok",
			message: `created '${outcome.content}' in KB '${name}' — docId ${outcome.docId}, hpath ${outcome.hpath}`,
			kb: name,
			docId: outcome.docId,
			title: outcome.content,
			hpath: outcome.hpath,
			...outline,
		};
	});
}
