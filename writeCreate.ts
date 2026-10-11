// The `kb_write` create flow: title guard (exact leg, then near-match
// scan) → submission path from ground truth → verified-create by-ID asserts
// → echo, with guard-stop draft staging.

import {
	GUARD_EXACT_CAP,
	GUARD_NEAR_CAP,
	SiYuanApiError,
	docMarkdown,
	findTitleMatches,
	firstChildContent,
	walkBlockTree,
	type GuardRow,
	type WalkedTree,
} from "siyuan-kb-primitives";
import {
	createDocVerified,
	type CreateDocOutcome,
} from "siyuan-kb-primitives/write";
import { errorEnvelope, type Envelope } from "./envelope.js";
import { spillFile, withRowPayload } from "./spill.js";
import { rememberServedRows } from "./baselines.js";
import { serveOutline, serveOutlineFromWalk } from "./outline.js";
import type { WriteFlowBase } from "./writeTarget.js";
import { finishWrite } from "./writeResult.js";
import { mintTitleMessage } from "./writeGuard.js";
import {
	driftRefusal,
	transportUnverifiedMessage,
	verificationAuthEventMessage,
	verificationReadsFailedMessage,
} from "./writeVerdicts.js";

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
	truncated: boolean,
): Promise<Envelope> {
	const { kernel, sessionId, name } = input;
	// Cap rendering like nearMatchStop — each row costs a walk plus a
	// markdown export, so a truncated (cap+1) row set renders only the cap.
	// The flag rides the primitives' TitleMatchResult; never re-derive it
	// from row-count arithmetic here.
	const shown = truncated ? rows.slice(0, GUARD_EXACT_CAP) : rows;
	const detailed: Record<string, unknown>[] = [];
	const walks: WalkedTree[] = [];
	for (const row of shown) {
		const docId = row.root_id;
		// Guard-stop evidence is presentation-only: the write never fires on
		// this path, so a candidate deleted between the guard query and these
		// reads degrades to an empty outline/excerpt (nearMatchStop's rule)
		// instead of discarding the whole duplicate stop. The strict posture
		// stays reserved for write-verification walks. One walk per row also
		// serves both the outline and (single-row) the block-ID payload —
		// never a second traversal of the same doc.
		const tree = await walkBlockTree(kernel, docId, {
			tolerateVanished: true,
		});
		walks.push(tree);
		// The stop serves heading content — seed the baselines so a follow-up
		// edit on a served heading verifies against what the agent saw here,
		// not against content read at edit time (which launders a concurrent
		// kernel-side change past the stale_content precondition).
		const outline = serveOutlineFromWalk(
			sessionId,
			"kb_write",
			tree,
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
	const count = truncated ? `${shown.length}+` : `${shown.length}`;
	const envelope: Envelope = {
		status: "duplicate",
		message:
			`${count} existing doc${shown.length === 1 ? "" : "s"} titled '${title}' in KB '${name}': ${docIds} — ` +
			`reconcile by docId (edit/append onto the wanted doc), or pass confirmNew: true to mint a conscious second doc`,
		kb: name,
		rows: detailed,
	};
	if (truncated) {
		envelope.truncated = `capped at ${GUARD_EXACT_CAP} candidates — refine the title`;
	}
	// Single-row: block IDs with content so the agent can go straight to
	// `edit` by blockId — reuses the outline walk already in hand.
	if (rows.length === 1) {
		const blocks = walks[0]!.blocks.map((b) => ({
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
	truncated: boolean,
): Promise<Envelope> {
	const { kernel, name } = input;
	const candidates: Record<string, unknown>[] = [];
	// Truncated (cap+1) row sets render only the cap — each row costs a walk
	// plus a markdown export, so overflow rows are sliced off before any
	// read. The flag rides the primitives' TitleMatchResult; never re-derive
	// it from row-count arithmetic here.
	const visible = truncated ? rows.slice(0, GUARD_NEAR_CAP) : rows;
	for (const row of visible) {
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
	if (truncated) {
		envelope.truncated = `capped at ${GUARD_NEAR_CAP} candidates — refine the title`;
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

/** The create mode's verdict frame: every guarded-create outcome other
 * than `created` → envelope. The mode's agent surface lives with the
 * mode; the words come from writeVerdicts' fragments (drift,
 * transport/verification, mint-title). The create mint runs with no doc
 * target, so the transport/kernel-refused legs carry no echo tail (the
 * errorTail rule for a missing doc). */
function createVerdictEnvelope(
	outcome: Exclude<CreateDocOutcome, { kind: "created" }>,
	ctx: { name: string },
): Envelope {
	switch (outcome.kind) {
		case "parent-missing":
			return errorEnvelope(
				`parentId '${outcome.parentId}' does not resolve to a doc in KB '${ctx.name}' (stale or foreign target)`,
			);
		case "unconfirmable":
			return errorEnvelope(
				`verified-create failed: the kernel returned doc id '${outcome.returnedId}' but no type='d' row exists for it in KB '${ctx.name}' — the mint is unconfirmable; do not retry blindly`,
			);
		case "ghost-intermediate":
			return errorEnvelope(
				`verified-create failed: parent '${outcome.parentId}' was deleted or renamed between the hpath read-back and the create — the kernel minted a ghost intermediate; drop the ghost subtree and retry`,
			);
		case "hpath-mismatch":
			return errorEnvelope(
				`verified-create failed: stored hpath '${outcome.stored}' does not match ground truth '${outcome.expected}' — unexpected kernel title normalization`,
			);
		case "transport-unverified":
			return errorEnvelope(transportUnverifiedMessage(outcome.detail), {
				kb: ctx.name,
				verificationFailed: true,
			});
		case "kernel-refused":
			return errorEnvelope(outcome.message, { kb: ctx.name });
		case "verification-failed":
			if (
				outcome.cause.kind === "auth" ||
				outcome.cause.kind === "rate-limit"
			) {
				return errorEnvelope(
					verificationAuthEventMessage(outcome.cause, outcome.detail),
					{
						docId: outcome.returnedId,
						kb: ctx.name,
						verificationFailed: true,
						authEvent: outcome.cause,
					},
				);
			}
			return errorEnvelope(verificationReadsFailedMessage(outcome.detail), {
				docId: outcome.returnedId,
				kb: ctx.name,
				verificationFailed: true,
			});
		case "mint-title":
			// The primitives run the mint-title judgment internally; the
			// tool-surface pre-flight (validateMintTitle) normally refuses
			// first, so this arm is defense-in-depth behind it — same words,
			// one home.
			return errorEnvelope(mintTitleMessage(outcome.problem));
		case "drift":
			return driftRefusal(outcome.observed);
	}
	outcome satisfies never;
	return errorEnvelope("internal: unhandled create verdict");
}

/** The `create` flow: title guard (exact leg, then near-match scan) →
 * guarded-create primitive (parent read-back, mint, verified-create by-ID
 * asserts) → echo (root docId, stored title, real hpath, fresh outline).
 * `confirmNew: true` bypasses both guard legs; the per-KB grant (resolved
 * at the kb_write entry) and the primitive's asserts still apply. */
export async function runCreateFlow(input: CreateFlowInput): Promise<Envelope> {
	const { kernel, sessionId, name, boxId } = input;
	const title = input.title;

	// Guard — exact leg first; only an empty exact leg runs the scan.
	if (!input.confirmNew) {
		const matches = await findTitleMatches(kernel, boxId, title);
		switch (matches.kind) {
			case "duplicate":
				return duplicateStop(input, title, matches.rows, matches.truncated);
			case "near":
				return nearMatchStop(input, title, matches.rows, matches.truncated);
			case "clear":
				break;
			default:
				// Exhaustive: a new guard kind added upstream must fail
				// typecheck here — an implicit fallthrough would read it as
				// "clear" and create past the guard. Fail closed if ever hit.
				matches.kind satisfies never;
				throw new Error("internal: unhandled title-guard kind");
		}
	}

	// The version-coupled core — submission path from ground truth, the
	// mint, and the verified-create asserts — lives in the primitive; its
	// required probe carries the gate's verdict and the drift refusal is
	// the primitive's own arm.
	const outcome = await createDocVerified(kernel, input.probe, {
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
