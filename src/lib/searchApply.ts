import * as monaco from "monaco-editor";
import { getModel } from "./monacoModelRegistry";
import type { MatchRange } from "./searchReplace";

/**
 * Applies replacements straight to an already-open Monaco model, as one
 * undoable step (so Ctrl+Z restores every match at once) — used instead of
 * a disk write so a dirty buffer is never clobbered. Returns false (doing
 * nothing) when the file isn't open; the caller then falls back to reading
 * and writing it on disk.
 */
export function applyMatchesToModel(
  path: string,
  matches: MatchRange[],
  replacementFor: (match: MatchRange) => string,
): boolean {
  const model = getModel(path);
  if (!model) return false;

  const edits = matches.map((match) => ({
    range: new monaco.Range(match.line, match.startColumn, match.line, match.endColumn),
    text: replacementFor(match),
  }));

  model.pushStackElement();
  model.pushEditOperations([], edits, () => null);
  model.pushStackElement();
  return true;
}
