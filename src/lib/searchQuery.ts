// Pure query-building and text helpers for the project-wide search panel.
// Kept free of Tauri/React so they're cheap to unit test.

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export type RegexResult = { ok: true; regex: RegExp } | { ok: false; error: string };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Builds a global RegExp for scanning a line, from the panel's toggles. */
export function buildSearchRegex(options: SearchOptions): RegexResult {
  if (!options.query) return { ok: false, error: "Type something to search for" };

  let source = options.useRegex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `\\b(?:${source})\\b`;

  try {
    return { ok: true, regex: new RegExp(source, options.matchCase ? "g" : "gi") };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * The text that should replace one matched occurrence. In regex mode this
 * re-runs the (anchored) pattern against just the matched text so `$1`-style
 * group references in `replace` expand correctly; in literal mode the
 * replacement is used as-is. Falls back to the literal text if the pattern
 * can't be rebuilt or no longer matches (should not normally happen, since
 * `matchText` was produced by this same pattern).
 */
export function buildReplacementText(matchText: string, replace: string, options: SearchOptions): string {
  if (!options.useRegex) return replace;

  try {
    const anchored = new RegExp(`^(?:${options.query})$`, options.matchCase ? "" : "i");
    if (anchored.test(matchText)) return matchText.replace(anchored, replace);
  } catch {
    // Invalid regex: fall through to the literal replacement below.
  }
  return replace;
}

/** "N results in M files" summary from the grouped search response. */
export function summarizeResults(files: { matches: unknown[] }[]): { matchCount: number; fileCount: number } {
  return {
    matchCount: files.reduce((sum, f) => sum + f.matches.length, 0),
    fileCount: files.length,
  };
}

/** Splits a (possibly already-trimmed) preview line for match highlighting. */
export function splitPreview(
  preview: string,
  matchStart: number,
  matchEnd: number,
): { before: string; match: string; after: string } {
  const start = Math.max(0, Math.min(matchStart, preview.length));
  const end = Math.max(start, Math.min(matchEnd, preview.length));
  return { before: preview.slice(0, start), match: preview.slice(start, end), after: preview.slice(end) };
}

/** The editor's current selection, prefilled into the search box (VS Code does the same). */
export function prefillFromSelection(selectedText: string): string {
  return (selectedText.split(/\r?\n/)[0] ?? "").trim();
}
