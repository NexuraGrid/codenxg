// Applies search matches to a file's full text. Pure and Monaco-free so it
// can run identically for an open buffer's text and for a plain string read
// from disk — the caller decides where the result goes (a model edit or a
// file write).

export interface MatchRange {
  /** 1-based, matching Monaco's line numbers. */
  line: number;
  /** 1-based, inclusive (Monaco column convention). */
  startColumn: number;
  /** 1-based, exclusive. */
  endColumn: number;
  matchText: string;
}

/**
 * Replaces every match in `text`, grouped by line and applied right-to-left
 * within each line so earlier columns on the same line stay valid. A match
 * whose line falls outside the text (stale results after an external edit)
 * is skipped rather than throwing.
 */
export function applyMatchesToText(
  text: string,
  matches: MatchRange[],
  replacementFor: (match: MatchRange) => string,
): string {
  const lines = text.split("\n");
  const byLine = new Map<number, MatchRange[]>();
  for (const match of matches) {
    const list = byLine.get(match.line);
    if (list) list.push(match);
    else byLine.set(match.line, [match]);
  }

  for (const [lineNumber, lineMatches] of byLine) {
    const index = lineNumber - 1;
    if (index < 0 || index >= lines.length) continue;

    let line = lines[index];
    const rightToLeft = [...lineMatches].sort((a, b) => b.startColumn - a.startColumn);
    for (const match of rightToLeft) {
      const start = match.startColumn - 1;
      const end = match.endColumn - 1;
      line = line.slice(0, start) + replacementFor(match) + line.slice(end);
    }
    lines[index] = line;
  }

  return lines.join("\n");
}
