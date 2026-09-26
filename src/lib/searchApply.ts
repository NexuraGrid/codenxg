import * as monaco from "monaco-editor";
import { getModel } from "./monacoModelRegistry";
import type { MatchRange } from "./searchReplace";

/**
 * Applies replacements straight to an already-open Monaco model, as one
 * undoable step (so Ctrl+Z restores every match at once) — used instead of
 * a disk write so a dirty buffer is never clobbered. Results come from the
 * file on disk, so a match whose range no longer holds its text (unsaved
 * edits since) is skipped. Returns false (doing
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

  const edits = matches
    .map((match) => ({
      match,
      range: new monaco.Range(match.line, match.startColumn, match.line, match.endColumn),
    }))
    .filter(({ match, range }) => model.getValueInRange(range) === match.matchText)
    .map(({ match, range }) => ({ range, text: replacementFor(match) }));

  model.pushStackElement();
  model.pushEditOperations([], edits, () => null);
  model.pushStackElement();
  return true;
}
