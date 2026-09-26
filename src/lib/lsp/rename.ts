// Pure interpretation of `textDocument/prepareRename`'s three possible
// result shapes into what Monaco's `resolveRenameLocation` needs: a range and
// the text to prefill the rename box with, or a rejection reason.
import type * as monaco from "monaco-editor";
import type { LspRenameLocation } from "./protocol";
import { toMonacoRange } from "./protocol";

export interface ResolvedRenameLocation {
  range: monaco.IRange;
  text: string;
}
export interface RejectedRename {
  rejectReason: string;
}

const NOTHING_TO_RENAME = "Nothing to rename here";

/**
 * `fallback` and `textInRange` read from the live model (word-under-cursor,
 * and the text a bare range covers) — kept as callbacks so this stays
 * Monaco-model-free and unit-testable.
 */
export function toRenameLocation(
  result: LspRenameLocation | null,
  position: monaco.IPosition,
  fallback: (position: monaco.IPosition) => ResolvedRenameLocation | null,
  textInRange: (range: monaco.IRange) => string,
): ResolvedRenameLocation | RejectedRename {
  if (!result) return { rejectReason: NOTHING_TO_RENAME };
  if ("defaultBehavior" in result) return fallback(position) ?? { rejectReason: NOTHING_TO_RENAME };
  if ("placeholder" in result) return { range: toMonacoRange(result.range), text: result.placeholder };
  const range = toMonacoRange(result);
  return { range, text: textInRange(range) };
}
