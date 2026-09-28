// kb_write registration: the tool surface (schema + description), the
// hooks the chassis injects, the write-path probe gate, and the non-create
// mode dispatch. The create flow lives in writeCreate.ts; shape/schema in
// writeSchema.ts; the per-KB grant gate in writeConfirm.ts; mint policy in
// writeGuard.ts; the guard SQL and anchors (placement) live in the
// primitives; shared baselines in writeResult.ts, echo tails in
// writeFlow.ts.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { defineToolset, type Toolset } from "pi-tool-masking";
import { READ_TOOLSET_ID } from "./tools.js";
import type { CircuitBreaker } from "./breaker.js";
import {
	errorEnvelope,
	refusedEnvelope,
	textResult,
	type Envelope,
} from "./envelope.js";
import {
	gateWriteAttempt,
	runGatedTool,
	resolveBox,
	staticDriftRefusal,
} from "./gate.js";
import type { SessionValidation } from "./validation.js";
import {
	grantGate,
	readBodyFile,
	type WriteGrantState,
} from "./writeConfirm.js";
import { runCreateFlow } from "./writeCreate.js";
import { runEditMode } from "./writeEdit.js";
import { runAppendMode } from "./writeAppend.js";
import { runReplaceSectionMode } from "./writeReplaceSection.js";
import { runDeleteMode } from "./writeDelete.js";
import { runMoveMode } from "./writeMove.js";
import { resolveDocTarget, type WriteFlowBase } from "./writeFlow.js";
import {
	CONTENT_BEARING_MODES,
	modeShapeProblem,
	writeSchema,
	type WriteParams,
} from "./writeSchema.js";
import { validateMintTitle } from "./writeGuard.js";
import type { ContentBaselines } from "./baselines.js";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";

export interface WriteToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): WriteKernelClient | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped per-KB write-grant state — same lifecycle class as the
	 * breaker. */
	grantState: WriteGrantState;
	/** Session-scoped fresh-content baselines — same
	 * lifecycle class as the breaker/grant state. */
	baselines: ContentBaselines;
	/** Injectable file-read seam (unit tests); defaults to the real
	 * readBodyFile from writeConfirm. */
	readBodyFile?: (path: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Write toolset (tool-masking record)
// ---------------------------------------------------------------------------

export const WRITE_TOOLSET_ID = "gnubrain.write";
const WRITE_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.write";

const WRITE_DESCRIPTION = `Write to a GNUbrain knowledge base. Modes: create — mint a new doc by title (topic), optionally nested under an echoed parentId; edit — updateBlock on a blockId target (the outline carries heading IDs only; non-heading block IDs come from kb_query rows); replace-section — swap a section's body in one call (the heading ID survives); append — insert new content under a heading (omitted headingId → doc end; the anchor is always tool-derived); delete — a block, or a whole doc with doc: true; move — block-level (toDocId + optional toHeadingId) or doc-level (doc: true; omitted toDocId → notebook root).

Doctrine: mint by title (kernel-normalized); discover by query/search; consume by ID. Targets (docId/blockId/headingId) are agent-supplied echoed values from kb_query/kb_search/kb_read/write results — never invented; anchors are always tool-derived — never agent-supplied. Replace-first: prefer edit/replace-section over append — append is for genuinely new facts. The body travels via markdown (inline) XOR markdownFile (path to a prepared markdown file; read once at call start) on create/edit/replace-section/append; delete/move carry neither. The title guard stops exact/near matches on create and returns the existing docs (docId, outline, spilled markdown) — reconcile by docId, or mint a conscious duplicate with confirmNew: true (you learn this exit from the rejection; do not pass it preemptively). Writes are approved once per KB per interaction via a dialog that names the KB only (no op detail): Yes grants for the interaction, 'Always this session' for the session, any other answer denies that KB until the interaction ends — do not retry within the interaction. allowUnattendedWrites: true skips the dialog in any session; headless sessions deny writes unless it is set. The discovery name 'kbs' is read-only; writes always target a real KB by name.`;

/** Ordered kernel-free steps of the kb_write entry (mode-target shape →
 * body resolve → KB resolution → static drift refusal → grant dialog),
 * then the probe gate → flow dispatch. Standalone so the ordering pins —
 * file read before the probe gate, drift refusal before the grant, grant
 * before the probe gate, mint before the grant — are a unit under test,
 * not an inline closure. */
async function prepareWrite(
	p: WriteParams,
	hooks: WriteToolHooks,
	kernel: WriteKernelClient,
	validation: SessionValidation,
	names: string[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): Promise<Envelope> {
	// Uniform mode-target shape check before anything else —
	// zero kernel calls, and it covers create too (create's
	// flow never reaches runWriteMode, so this is the only
	// check point).
	const shapeProblem = modeShapeProblem(p);
	if (shapeProblem !== undefined) {
		return refusedEnvelope(shapeProblem);
	}
	// Content-body shape: markdown XOR markdownFile. Resolved
	// before the probe gate and before any guard query — the
	// file read is the call's first content step, so a bad
	// path refuses with zero kernel calls.
	let body: string | undefined = p.markdown;
	const fromFile = p.markdownFile !== undefined;
	if (CONTENT_BEARING_MODES.has(p.mode)) {
		if ((body !== undefined) === fromFile) {
			return refusedEnvelope(
				"provide exactly one of 'markdown' (inline string) or 'markdownFile' (path)",
			);
		}
		if (fromFile) {
			const read = hooks.readBodyFile ?? readBodyFile;
			try {
				body = await read(p.markdownFile as string);
			} catch (err) {
				return errorEnvelope(err instanceof Error ? err.message : String(err));
			}
		}
	}
	// KB resolution: local map lookup, zero kernel calls.
	const name = names[0] as string;
	const boxId = resolveBox(name, validation);
	// Create's mint-title validation: kernel-free, part of the same shape
	// leg that must precede the grant dialog.
	let title = "";
	if (p.mode === "create") {
		const mint = validateMintTitle(p.topic ?? "");
		if (!mint.ok) return refusedEnvelope(mint.message);
		title = mint.title;
	}
	// Static drift refusal before the grant dialog: kernel-free and cached
	// (probe === "drift" decides from session state alone), so a drifted
	// session refuses writes with zero kernel calls and zero dialogs. The
	// probe's live legs (unreachable retry, auth/429 classification) stay
	// below the dialog — a cached verdict may precede the prompt, a live
	// one may not.
	const drift = staticDriftRefusal(validation);
	if (drift !== null) return drift;
	// Per-KB per-interaction grant dialog (or its local refusals:
	// allowUnattendedWrites skip, held grants, terminal denial, headless
	// default-deny) — kernel-free, before the probe gate. The run's abort
	// signal rides to select: pi force-resolves the dialog to undefined on
	// abort, which lands in the single terminal denial.
	const grant = await grantGate({
		name,
		hasUI: ctx.hasUI,
		allowUnattendedWrites: validation.settings?.allowUnattendedWrites,
		writeConfirmTimeout: validation.settings?.writeConfirmTimeout,
		signal,
		select: (t, options, opts) => ctx.ui.select(t, options, opts),
		state: hooks.grantState,
	});
	if (grant !== null) return grant;
	// Write-path probe gate: a successful probe (or a per-attempt retry)
	// must precede any write. The probe is unauthenticated, so it marks no
	// kernel contact — the breaker's reset-on-success contract counts only
	// authenticated calls, and the gate's tracked client marks nothing for
	// getVersion. The returned verdict is the stamp the flow input
	// carries: the cached-ok verdict on the cached path, the fresh
	// re-probe result on the retry path.
	const probeGate = await gateWriteAttempt({
		validation,
		kernel,
		breaker: hooks.breaker,
	});
	if (!probeGate.ok) return probeGate.envelope;
	const flowBase: WriteFlowBase = {
		sessionId: ctx.sessionManager.getSessionId(),
		kernel,
		name,
		boxId,
		body: body ?? "",
		baselines: hooks.baselines,
		probe: probeGate.probe,
	};
	if (p.mode === "create") {
		return runCreateFlow({
			...flowBase,
			title,
			parentId: p.parentId,
			bodyFromFile: fromFile,
			confirmNew: p.confirmNew === true,
		});
	}
	// Non-create modes: dispatch. The mode-specific target shape (schema
	// table) was already validated by modeShapeProblem at the entry, and
	// the per-KB grant already resolved before the probe gate — a denied
	// write costs zero kernel round-trips.
	const target = await resolveDocTarget(kernel, boxId, name, p.docId as string);
	if ("status" in target) return target;
	switch (p.mode) {
		case "edit":
			return runEditMode({ ...flowBase, params: p }, target);
		case "append":
			return runAppendMode({ ...flowBase, params: p }, target);
		case "replace-section":
			return runReplaceSectionMode({ ...flowBase, params: p }, target);
		case "delete":
			return runDeleteMode({ ...flowBase, params: p }, target);
		case "move":
			return runMoveMode({ ...flowBase, params: p }, target);
		// Unreachable: modeShapeProblem refused any other mode at the entry.
		// Kept because params.mode is a plain string, so TS needs a return.
		default:
			return errorEnvelope(`internal: unhandled write mode '${p.mode}'`);
	}
}

/** Register kb_write and declare the write toolset (one tool, all
 * mutation modes; requires the read toolset — enabling writes cascades
 * reads on, disabling reads cascades writes off; live toggles only — the
 * settings tier applies pins per-toolset without the cascade, the
 * documented write-without-read boundary, backstopped by the per-KB write
 * grant + headless default-deny). */
export function registerWriteToolAndToolset(
	pi: ExtensionAPI,
	hooks: WriteToolHooks,
): Toolset {
	pi.registerTool({
		name: "kb_write",
		label: "KB Write",
		description: WRITE_DESCRIPTION,
		parameters: writeSchema,
		async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext) {
			const envelope = await runGatedTool(
				hooks,
				params.kb,
				"single",
				(kernel, validation, names) =>
					prepareWrite(
						params as WriteParams,
						hooks,
						kernel,
						validation,
						names,
						ctx,
						signal,
					),
			);
			return textResult(envelope);
		},
	});
	return defineToolset(pi, {
		id: WRITE_TOOLSET_ID,
		label: "GNUbrain KB writes",
		names: new Set(["kb_write"]),
		persistKey: WRITE_TOOLSET_PERSIST_KEY,
		defaultEnabled: true,
		requires: [READ_TOOLSET_ID],
	});
}
