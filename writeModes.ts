// Dispatcher for the non-create write modes — edit / append /
// replace-section / delete / move. The shape/schema layer lives in
// writeSchema.ts, the shared scaffolding (doc-target resolution, confirm
// gate, target reads, delete-set display) in writeFlow.ts, and each flow in
// its own file (writeEdit/writeAppend/writeReplaceSection/writeDelete/
// writeMove).

import { errorEnvelope, type Envelope } from "./envelope.js";
import { resolveDocTarget, type WriteFlowInput } from "./writeFlow.js";
import { runEditMode } from "./writeEdit.js";
import { runAppendMode } from "./writeAppend.js";
import { runReplaceSectionMode } from "./writeReplaceSection.js";
import { runDeleteMode } from "./writeDelete.js";
import { runMoveMode } from "./writeMove.js";

/** Dispatch point for the non-create modes; mode-target shape is checked
 * once at the kb_write entry (write.ts) — create never reaches here. */
export async function runWriteMode(input: WriteFlowInput): Promise<Envelope> {
	const mode = input.params.mode;
	const confirmKey = input.confirmKey;
	// Pre-dialog permission (headless default-deny + terminal
	// confirm_timeout) already ran at the kb_write entry, before the
	// probe gate — a denied write costs zero kernel round-trips.
	input.contact();
	const target = await resolveDocTarget(
		input.kernel,
		input.boxId,
		input.name,
		input.params.docId as string,
	);
	if ("status" in target) return target;
	switch (mode) {
		case "edit":
			return runEditMode(input, target, input.dialog, confirmKey);
		case "append":
			return runAppendMode(input, target, input.dialog, confirmKey);
		case "replace-section":
			return runReplaceSectionMode(input, target, input.dialog, confirmKey);
		case "delete":
			return runDeleteMode(input, target, input.dialog, confirmKey);
		case "move":
			return runMoveMode(input, target, input.dialog, confirmKey);
		default:
			return errorEnvelope(`internal: unhandled write mode '${mode}'`);
	}
}
