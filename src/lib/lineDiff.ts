export interface LineChange {
  kind: "added" | "modified" | "deleted";
  /** 1-based lines in the new text. A deletion sits on the line after the gap. */
  start: number;
  end: number;
}

// Past this many differing lines the exact diff isn't worth its cost for a
// gutter; the changed middle is reported as one modified block instead.
const MAX_EDIT_DISTANCE = 2000;

/**
 * Line diff (Myers' O(ND) algorithm) grouped into VS Code-style gutter hunks:
 * only additions -> added, only removals -> deleted, both -> modified.
 */
export function diffLines(before: string[], after: string[]): LineChange[] {
  // Common head and tail are skipped: a typical edit touches a few lines.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  if (a.length === 0 && b.length === 0) return [];

  const ops = myers(a, b) ?? [...a.map(() => "-" as const), ...b.map(() => "+" as const)];
  return toHunks(ops, head, after.length);
}

type Op = "=" | "-" | "+";

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= Math.min(offset, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}

function toHunks(ops: Op[], firstLine: number, afterLength: number): LineChange[] {
  const hunks: LineChange[] = [];
  let line = firstLine; // 0-based index into the new text
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === "=") {
      line++;
      i++;
      continue;
    }
    let removed = 0;
    let added = 0;
    const start = line;
    while (i < ops.length && ops[i] !== "=") {
      if (ops[i] === "-") removed++;
      else added++;
      i++;
    }
    line += added;

    if (added === 0) {
      // Mark the line after the gap, or the last line when the gap is at the end.
      const at = Math.min(start + 1, Math.max(afterLength, 1));
      hunks.push({ kind: "deleted", start: at, end: at });
    } else {
      hunks.push({ kind: removed === 0 ? "added" : "modified", start: start + 1, end: start + added });
    }
  }
  return hunks;
}
