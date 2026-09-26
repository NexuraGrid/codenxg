import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { useEditorStore, type EditorTab } from "../state/editorStore";
import { headText, useGitStore } from "../state/gitStore";
import { readFile } from "../lib/tauri-api";
import { createModel, getModel } from "../lib/monacoModelRegistry";
import { setActiveEditor } from "../lib/editorInstance";
import { installEditorClipboard } from "../lib/editorClipboard";
import { EDITOR_THEME_ID } from "../lib/editorTheme";
import { EDITOR_OPTIONS } from "../lib/editorOptions";

/**
 * Side-by-side diff of the last commit (left, read-only) against the file as
 * it is now (right). The right side is the tab's own model: edits, undo and
 * Ctrl+S behave exactly as in the normal editor.
 */
export function DiffView({ tab }: { tab: EditorTab }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const originalRef = useRef<monaco.editor.ITextModel | null>(null);
  const headVersion = useGitStore((s) => s.headVersion);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const diff = monaco.editor.createDiffEditor(container, {
      ...EDITOR_OPTIONS,
      theme: EDITOR_THEME_ID,
      renderSideBySide: true,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
    });
    const modifiedEditor = diff.getModifiedEditor();
    setActiveEditor(modifiedEditor);
    installEditorClipboard(modifiedEditor, monaco);

    const original = monaco.editor.createModel("", tab.language);
    originalRef.current = original;
    // Only a deleted file needs a throwaway right side; a real file's model
    // belongs to the registry and outlives this view.
    let placeholder: monaco.editor.ITextModel | null = null;
    let cancelled = false;

    (async () => {
      let modified = getModel(tab.path);
      if (!modified) {
        try {
          const content = await readFile(tab.path);
          modified = getModel(tab.path) ?? createModel(tab.path, content, tab.language);
        } catch {
          placeholder = monaco.editor.createModel("", tab.language);
          modified = placeholder;
          modifiedEditor.updateOptions({ readOnly: true });
          if (!cancelled) setNotice("This file was deleted; the left side is its last committed version.");
        }
      }
      if (!cancelled) diff.setModel({ original, modified });
    })();

    return () => {
      cancelled = true;
      diff.setModel(null);
      diff.dispose();
      original.dispose();
      placeholder?.dispose();
      originalRef.current = null;
      setActiveEditor(null);
    };
  }, [tab.path, tab.language]);

  // Refills the left side on open and whenever HEAD moves (a commit, a checkout).
  useEffect(() => {
    let cancelled = false;
    headText(tab.path).then((text) => {
      if (!cancelled) originalRef.current?.setValue(text ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [tab.path, headVersion]);

  return (
    <div className="diff-view">
      <div className="diff-view__bar">
        <span className="diff-view__title">{tab.title}</span>
        <span className="diff-view__hint">Last commit ↔ Working tree</span>
        <button
          className="diff-view__open"
          onClick={() => useEditorStore.getState().setShowDiff(tab.path, false)}
        >
          Open File
        </button>
      </div>
      {notice && <div className="diff-view__notice">{notice}</div>}
      <div ref={containerRef} className="diff-view__body" />
    </div>
  );
}
