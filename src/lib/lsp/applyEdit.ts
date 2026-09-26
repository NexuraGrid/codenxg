// Applies an LSP WorkspaceEdit (rename, code actions) across open and closed
// files consistently: an open file's model gets an undoable, dirty-marking
// edit (the same path fileSave.ts's save takes); a closed file is patched on
// disk through the same atomic write the search-and-replace feature uses.
//
// Deliberately bypasses Monaco's own bulk-edit service: its ITextModelService
// only resolves files that already have a model (see StandaloneTextModelService
// in monaco-editor), so it can't touch a file this editor hasn't opened.
import * as monaco from "monaco-editor";
import { getModel } from "../monacoModelRegistry";
import { pathFromUri } from "../paths";
import { readFile, writeSearchFiles } from "../tauri-api";
import { toMonacoEdit, type LspWorkspaceEdit } from "./protocol";
import { applyEditsToText, normalizeWorkspaceEdit, type ResourceOperation } from "./workspaceEdit";

export interface ApplyWorkspaceEditResult {
  changedPaths: string[];
  /** create/rename/delete file operations the edit asked for that were skipped. */
  skippedOperations: ResourceOperation[];
}

export async function applyWorkspaceEdit(edit: LspWorkspaceEdit | null | undefined): Promise<ApplyWorkspaceEditResult> {
  const { fileEdits, resourceOperations } = normalizeWorkspaceEdit(edit);
  const changedPaths: string[] = [];
  const diskWrites: { path: string; content: string }[] = [];

  for (const { uri, edits } of fileEdits) {
    if (edits.length === 0) continue;
    const path = pathFromUri(monaco.Uri.parse(uri));
    const model = getModel(path);
    if (model) {
      model.pushStackElement();
      model.pushEditOperations([], edits.map(toMonacoEdit), () => null);
      model.pushStackElement();
    } else {
      const current = await readFile(path);
      diskWrites.push({ path, content: applyEditsToText(current, edits) });
    }
    changedPaths.push(path);
  }

  if (diskWrites.length > 0) await writeSearchFiles(diskWrites);

  return { changedPaths, skippedOperations: resourceOperations };
}
