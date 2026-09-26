export interface FuzzyMatch {
  score: number;
  /** Indices of matched characters in the text that was searched. */
  indices: number[];
}

const WORD_SEPARATORS = new Set(["/", "\\", ".", "-", "_", " "]);

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (WORD_SEPARATORS.has(prev)) return true;
  // camelCase boundary: "monacoEditor" -> "E"
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
}

/**
 * Subsequence match: every query character must appear in order. Rewards
 * consecutive runs and word starts, penalizes gaps. Null when no match.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let ti = 0;

  for (let qi = 0; qi < q.length; qi++) {
    const found = t.indexOf(q[qi], ti);
    if (found === -1) return null;

    const consecutive = indices.length > 0 && found === indices[indices.length - 1] + 1;
    score += 1;
    if (consecutive) score += 6;
    if (isWordStart(text, found)) score += 8;
    if (found === 0) score += 4;
    score -= Math.min(found - ti, 6) * 0.5;

    indices.push(found);
    ti = found + 1;
  }

  return { score, indices };
}

export interface PathMatch {
  score: number;
  nameIndices: number[];
  dirIndices: number[];
}

/**
 * Scores a relative path, preferring matches inside the file name over
 * matches that need the folder part — "tabs" should rank EditorTabs.tsx
 * above src/tabs/index.ts's deeper hits.
 */
export function matchPath(query: string, dir: string, name: string): PathMatch | null {
  const inName = fuzzyMatch(query, name);
  if (inName) {
    return { score: inName.score + 100 - name.length * 0.1, nameIndices: inName.indices, dirIndices: [] };
  }

  const full = dir ? `${dir}/${name}` : name;
  const inFull = fuzzyMatch(query, full);
  if (!inFull) return null;

  const offset = dir ? dir.length + 1 : 0;
  return {
    score: inFull.score - full.length * 0.05,
    dirIndices: inFull.indices.filter((i) => i < dir.length),
    nameIndices: inFull.indices.filter((i) => i >= offset).map((i) => i - offset),
  };
}
