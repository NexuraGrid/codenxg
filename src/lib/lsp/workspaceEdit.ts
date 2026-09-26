// Pure, Monaco-free normalization of an LSP WorkspaceEdit (rename, code
// actions) and application of its text edits to a plain string. Kept
// side-effect-free so it runs the same for an open buffer's text and for a
// file just read from disk — the caller (applyEdit.ts) decides where the
// result goes.
import type { LspPosition, LspTextEdit, LspWorkspaceEdit } from "./protocol";

export interface FileEdits {
  uri: string;
  edits: LspTextEdit[];
}

export interface ResourceOperation {
  kind: "create" | "rename" | "delete";
  uri: string;
  /** Only for "rename". */
  newUri?: string;
}

export interface NormalizedWorkspaceEdit {
  fileEdits: FileEdits[];
  /** create/rename/delete file operations we don't perform; reported, not applied. */
  resourceOperations: ResourceOperation[];
}

/**
 * `documentChanges` (when present) is authoritative over `changes` per the
 * spec. Text edits and file resource operations (create/rename/delete) are
 * split apart: only the text edits are applied here.
 */
export function normalizeWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): NormalizedWorkspaceEdit {
  if (!edit) return { fileEdits: [], resourceOperations: [] };

  if (edit.documentChanges) {
    const fileEdits: FileEdits[] = [];
    const resourceOperations: ResourceOperation[] = [];
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        fileEdits.push({ uri: change.textDocument.uri, edits: change.edits });
      } else if (change.kind === "rename") {
        resourceOperations.push({ kind: "rename", uri: change.oldUri, newUri: change.newUri });
      } else {
        resourceOperations.push({ kind: change.kind, uri: change.uri });
      }
    }
    return { fileEdits, resourceOperations };
  }

  if (edit.changes) {
    return {
      fileEdits: Object.entries(edit.changes).map(([uri, edits]) => ({ uri, edits })),
      resourceOperations: [],
    };
  }

  return { fileEdits: [], resourceOperations: [] };
}

function comparePositions(a: LspPosition, b: LspPosition): number {
  return a.line - b.line || a.character - b.character;
}

// The start of each line as a JS string index. LSP characters are UTF-16
// code units, and so are JS string indices, so no further conversion is
// needed here (unlike on the Rust side, which is UTF-8 internally).
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * Applies `edits` to `text` as one batch, all ranges referring to the
 * original text (as the spec requires — they must not overlap). Edits are
 * applied last-to-first so an earlier edit's offsets stay valid while later
 * ones are spliced in.
 */
export function applyEditsToText(text: string, edits: LspTextEdit[]): string {
  if (edits.length === 0) return text;
  const starts = lineStarts(text);
  const offsetOf = (p: LspPosition) => (starts[p.line] ?? text.length) + p.character;

  const ordered = [...edits].sort((a, b) => comparePositions(b.range.start, a.range.start));
  let result = text;
  for (const edit of ordered) {
    const start = offsetOf(edit.range.start);
    const end = offsetOf(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}
