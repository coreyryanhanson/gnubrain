// kb_write registration: the tool surface (schema + description), the
// hooks the chassis injects, and the write-path probe gate. The flows live
// in writeCreate.ts / writeModes.ts; shape/schema in writeSchema.ts;
// confirmation in writeConfirm.ts; guard SQL in writeGuard.ts; anchors in
// writeAnchors.ts; shared baselines/echo in writeResult.ts.

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CircuitBreaker } from "./breaker.js";
import { errorEnvelope, refusedEnvelope, textResult } from "./envelope.js";
import { resolveBox } from "./gate.js";
import {
	gateWriteAttempt,
	NOT_READY_KERNEL,
	NOT_READY_VALIDATION,
	runKbCall,
} from "./gate.js";
import type { SessionValidation } from "./validation.js";
import {
	readBodyFile,
	preflightWrite,
	type WriteConfirmFn,
	type WriteConfirmState,
} from "./writeConfirm.js";
import { createConfirmInputs, runCreateFlow } from "./writeCreate.js";
import {
	CONTENT_BEARING_MODES,
	modeConfirmInputs,
	modeShapeProblem,
	writeSchema,
	type WriteParams,
} from "./writeSchema.js";
import { runWriteMode } from "./writeModes.js";
import { validateMintTitle } from "./writeGuard.js";
import type { ContentBaselines } from "./baselines.js";
import type { WriteKernelClient } from "./writeResult.js";

export interface WriteToolHooks {
	/** Live session validation — set by session_start / /kb recovery. */
	getValidation(): SessionValidation | undefined;
	/** Kernel client built from the freshest settings (revalidate). */
	getKernel(): WriteKernelClient | undefined;
	breaker: CircuitBreaker;
	/** Session-scoped confirm_timeout state — same lifecycle class as the breaker. */
	confirmState: WriteConfirmState;
	/** Session-scoped fresh-content baselines (decision record) — same
	 * lifecycle class as the breaker/confirm state. */
	baselines: ContentBaselines;
	/** Per-test version-pin override — threaded to the write gate so a
	 * drift refusal names the overridden pin, not the module constant. */
	pinnedVersion?: string;
	/** Injectable seams (unit tests); defaults wire to ctx at execute time. */
	confirm?: WriteConfirmFn;
	hasUI?: boolean;
	readBodyFile?: (path: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Write toolset (tool-masking record)
// ---------------------------------------------------------------------------

export const WRITE_TOOLSET_ID = "gnubrain.write";
export const WRITE_TOOLSET_PERSIST_KEY = "toolset-state:gnubrain.write";

const WRITE_DESCRIPTION = `Write to a GNUbrain knowledge base. Modes: create — mint a new doc by title (topic), optionally nested under an echoed parentId; edit — updateBlock on a blockId target (the outline carries heading IDs only; non-heading block IDs come from kb_query rows); replace-section — swap a section's body in one call (the enumerated delete set rides the confirmation; the heading ID survives); append — insert new content under a heading (omitted headingId → doc end; the anchor is always tool-derived); delete — a block, or a whole doc with doc: true; move — block-level (toDocId + optional toHeadingId) or doc-level (doc: true; omitted toDocId → notebook root).

Doctrine: mint by title (kernel-normalized); discover by query/search; consume by ID. Targets (docId/blockId/headingId) are agent-supplied echoed values from kb_query/kb_search/kb_read/write results — never invented; anchors are always tool-derived — never agent-supplied. Replace-first: prefer edit/replace-section over append — append is for genuinely new facts. The body travels via markdown (inline) XOR markdownFile (path to a prepared markdown file; read once at call start) on create/edit/replace-section/append; delete/move carry neither. The title guard stops exact/near matches on create and returns the existing docs (docId, outline, spilled markdown) — reconcile by docId, or mint a conscious duplicate with confirmNew: true (you learn this exit from the rejection; do not pass it preemptively). Every write is confirmed with the user unless the session is headless with allowUnattendedWrites: true. The discovery name 'kbs' is read-only; writes always target a real KB by name.`;

export function registerWriteTool(pi: ExtensionAPI, hooks: WriteToolHooks) {
	pi.registerTool({
		name: "kb_write",
		label: "KB Write",
		description: WRITE_DESCRIPTION,
		parameters: writeSchema,
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const validation = hooks.getValidation();
			if (validation === undefined) {
				return textResult(errorEnvelope(NOT_READY_VALIDATION));
			}
			const kernel = hooks.getKernel();
			const p = params as WriteParams;
			const envelope = await runKbCall(
				{ validation, breaker: hooks.breaker, kb: p.kb, arity: "single" },
				async (names, contact) => {
					if (kernel === undefined) {
						return errorEnvelope(NOT_READY_KERNEL);
					}
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
								return errorEnvelope(
									err instanceof Error ? err.message : String(err),
								);
							}
						}
					}
					// KB resolution: local map lookup, zero kernel calls.
					const name = names[0] as string;
					const boxId = resolveBox(name, validation);
					// Confirm key + pre-dialog permission before the probe gate:
					// both are kernel-free, so a denied write costs zero kernel
					// round-trips. Key/summary are shared with the flows so the
					// terminal confirm_timeout key can't drift.
					let confirmInputs: { key: string; summary: string };
					let title = "";
					if (p.mode === "create") {
						const mint = validateMintTitle(p.topic ?? "");
						if (!mint.ok) return refusedEnvelope(mint.message);
						title = mint.title;
						confirmInputs = createConfirmInputs(
							name,
							title,
							(body ?? "").length,
						);
					} else {
						confirmInputs = modeConfirmInputs(name, p);
					}
					const preflight = preflightWrite({
						hasUI: hooks.hasUI ?? ctx.hasUI,
						allowUnattendedWrites: validation.settings?.allowUnattendedWrites,
						state: hooks.confirmState,
						...confirmInputs,
					});
					if (!preflight.ok) return preflight.envelope;
					// Write-path probe gate: a successful probe (or a
					// per-attempt retry) must precede any write. The probe is
					// unauthenticated, so it does not fire `contact` — the breaker's
					// reset-on-success contract counts only authenticated calls;
					// the op's own contact covers any write that reaches the kernel.
					const probeEnv = await gateWriteAttempt({
						validation,
						kernel,
						breaker: hooks.breaker,
						...(hooks.pinnedVersion !== undefined && {
							pinnedVersion: hooks.pinnedVersion,
						}),
					});
					if (probeEnv !== null) return probeEnv;
					const flowBase = {
						sessionId: ctx.sessionManager.getSessionId(),
						kernel,
						validation,
						name,
						boxId,
						body: body ?? "",
						confirm:
							hooks.confirm ??
							((t, message, opts) => ctx.ui.confirm(t, message, opts)),
						dialog: preflight.dialog,
						confirmInputs,
						confirmState: hooks.confirmState,
						baselines: hooks.baselines,
						contact,
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
					// Non-create modes: the mode-specific target shape (schema
					// table) was already validated by modeShapeProblem at the entry
					// — runWriteMode does not re-validate.
					return runWriteMode({
						...flowBase,
						confirmKey: confirmInputs.key,
						params: p,
					});
				},
			);
			return textResult(envelope);
		},
	});
}
