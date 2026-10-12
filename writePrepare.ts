// The ordered kernel-free ladder of the kb_write entry, then the probe
// gate and the mode dispatch. Standalone from the tool registration
// (write.ts) so the ordering pins — file read before the probe gate,
// drift refusal before the grant, grant before the probe gate, mint
// before the grant — are a unit under test, not an inline closure.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CircuitBreaker } from "./breaker.js";
import { errorEnvelope, refusedEnvelope, type Envelope } from "./envelope.js";
import { gateWriteAttempt, staticDriftRefusal } from "./gate.js";
import { resolveBox } from "./kbScope.js";
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
import { resolveDocTarget, type WriteFlowBase } from "./writeTarget.js";
import {
	CONTENT_BEARING_MODES,
	isWriteMode,
	modeShapeProblem,
	type WriteParams,
} from "./writeSchema.js";
import { validateMintTitle } from "./writeGuard.js";
import type { ContentBaselines } from "./baselines.js";
import type { KernelProbeClient } from "siyuan-kb-primitives";
import type { WriteKernelClient } from "siyuan-kb-primitives/write";

/** Runtime deps the write tool adds to the register seam. */
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

/** Ordered kernel-free steps of the kb_write entry (mode-target shape →
 * body resolve → KB resolution → mint-title validation → static drift
 * refusal → grant dialog), then the probe gate → flow dispatch. */
export async function prepareWrite(
	p: WriteParams,
	hooks: WriteToolHooks,
	kernel: WriteKernelClient,
	validation: SessionValidation,
	names: string[],
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	/** The raw (untracked) client the gate hands the op alongside the
	 * tracked one — the probe handle. Declared as the narrow probe type, so
	 * a real kernel call through it fails typecheck. Defaults to `kernel`
	 * for direct callers (untracked stubs: observationally identical); the
	 * production wiring pin asserts write.ts passes the raw client. */
	probe: KernelProbeClient = kernel,
): Promise<Envelope> {
	// Uniform mode-target shape check before anything else —
	// zero kernel calls, and it covers create too (create's
	// flow never reaches runWriteMode, so this is the only
	// check point).
	const shapeProblem = modeShapeProblem(p);
	if (shapeProblem !== undefined) {
		return refusedEnvelope(shapeProblem);
	}
	// modeShapeProblem refused unknown modes above; this narrow only types
	// p.mode as the closed union for the dispatch below (never fires).
	if (!isWriteMode(p.mode)) {
		return refusedEnvelope(`mode '${p.mode}' is not supported`);
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
	// authenticated calls, and the probe runs on the raw client, which the
	// tracked proxy never wraps (the trap never sees it). The returned
	// verdict is the stamp the flow input carries: the cached-ok verdict on
	// the cached path, the fresh re-probe result on the retry path.
	const probeGate = await gateWriteAttempt({
		validation,
		kernel: probe,
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
	}
	// Exhaustive tail: modeShapeProblem and the isWriteMode narrow above
	// guarantee p.mode is a dispatched mode — a new table key fails
	// typecheck here until its flow case exists.
	p.mode satisfies never;
	return errorEnvelope(`internal: unhandled write mode '${p.mode}'`);
}
