import * as monaco from "monaco-editor";
import { useEditorStore } from "../state/editorStore";
import { getActiveEditor } from "./editorInstance";
import { basename, pathFromUri } from "./paths";
import { languageFromPath } from "./language";

// Where to put the cursor once a file's model is shown (go to definition).
const pendingReveals = new Map<string, monaco.IRange | monaco.IPosition>();

/** Applies a pending reveal for `path` to `editor`, if one was requested. */
export function applyPendingReveal(editor: monaco.editor.ICodeEditor, path: string): void {
  const target = pendingReveals.get(path);
  if (!target) return;
  pendingReveals.delete(path);
  reveal(editor, target);
}

function reveal(editor: monaco.editor.ICodeEditor, target: monaco.IRange | monaco.IPosition) {
  if ("startLineNumber" in target) {
    editor.setSelection(target);
    editor.revealRangeInCenterIfOutsideViewport(target);
  } else {
    editor.setPosition(target);
    editor.revealPositionInCenterIfOutsideViewport(target);
  }
  editor.focus();
}

/**
 * Lets Monaco jump into other files (go to definition from a language
 * server): the file opens as a tab and the cursor lands on the target.
 */
export function registerFileOpener(): monaco.IDisposable {
  return monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const path = pathFromUri(resource);
      const store = useEditorStore.getState();
      const active = getActiveEditor();

      if (store.activeTabPath === path && active) {
        if (selectionOrPosition) reveal(active, selectionOrPosition);
        return true;
      }
      if (selectionOrPosition) pendingReveals.set(path, selectionOrPosition);
      store.addTab({ path, title: basename(path), isDirty: false, language: languageFromPath(path) });
      return true;
    },
  });
}

/**
 * Opens `path` (or focuses its tab if already open) and reveals/selects
 * `range` — used by project-wide search results to jump to a match in any
 * file, the same way go-to-definition jumps into one.
 */
export function openMatchInFile(path: string, range: monaco.IRange): void {
  const store = useEditorStore.getState();
  const active = getActiveEditor();

  if (store.activeTabPath === path && active) {
    reveal(active, range);
    return;
  }
  pendingReveals.set(path, range);
  store.addTab({ path, title: basename(path), isDirty: false, language: languageFromPath(path) });
}
