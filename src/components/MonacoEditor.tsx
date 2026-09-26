import { useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as monacoTypes from "monaco-editor";
import { useEditorStore, type EditorTab } from "../state/editorStore";
import { showDialog } from "../state/dialogStore";
import { readFile } from "../lib/tauri-api";
import { getModel, createModel } from "../lib/monacoModelRegistry";
import { saveFile } from "../lib/fileSave";
import { setActiveEditor } from "../lib/editorInstance";
import { installEditorClipboard } from "../lib/editorClipboard";
import { EDITOR_THEME_ID } from "../lib/editorTheme";
import { attachGitGutter } from "../lib/gitGutter";
import { applyPendingReveal } from "../lib/editorNavigation";
import { DiffView } from "./DiffView";
import { CommitDiffView } from "./CommitDiffView";
import { EDITOR_OPTIONS } from "../lib/editorOptions";

export function MonacoEditor() {
  const editorRef = useRef<monacoTypes.editor.IStandaloneCodeEditor | null>(null);
  const requestedPathRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null;

  // Called from both the tab-change effect and Monaco's onMount (either can
  // fire first). The getModel recheck after the await prevents two models for
  // one path, and requestedPathRef drops a slow read that finishes after the
  // user already switched to another tab.
  async function syncModel(editor: monacoTypes.editor.IStandaloneCodeEditor, tab: EditorTab) {
    requestedPathRef.current = tab.path;
    setLoadError(null);

    let model = getModel(tab.path);
    if (!model) {
      try {
        const content = await readFile(tab.path);
        model = getModel(tab.path) ?? createModel(tab.path, content, tab.language);
      } catch (error) {
        if (requestedPathRef.current === tab.path) {
          setLoadError(`Can't open ${tab.title} as text: ${String(error)}`);
          editor.setModel(null);
        }
        return;
      }
    }

    if (requestedPathRef.current === tab.path) {
      editor.setModel(model);
      applyPendingReveal(editor, tab.path);
    }
  }

  // Swap the model on the existing editor instance instead of recreating it
  // — this is what preserves undo history, cursor position and scroll.
  useEffect(() => {
    if (!activeTab || !editorRef.current) return;
    syncModel(editorRef.current, activeTab);
  }, [activeTab?.path]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSaveShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
      if (!isSaveShortcut || !activeTab) return;
      event.preventDefault();

      saveFile(activeTab.path).catch((error) =>
        showDialog({
          title: `Couldn't save ${activeTab.title}`,
          message: String(error),
          buttons: [{ label: "OK", value: "ok", variant: "primary" }],
          cancelValue: "ok",
        }),
      );
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setActiveEditor(editor);
    installEditorClipboard(editor, monaco);
    const detachGutter = attachGitGutter(editor);
    // The editor unmounts when the last tab closes; don't leave a disposed
    // instance reachable from the palette.
    editor.onDidDispose(() => {
      detachGutter();
      if (editorRef.current === editor) editorRef.current = null;
      setActiveEditor(null);
    });
    // Monaco measures glyph widths at mount; if the web font arrives later
    // the caret and selections drift unless it re-measures.
    document.fonts.ready.then(() => monaco.editor.remeasureFonts());
    if (activeTab) {
      syncModel(editor, activeTab);
    }
  };

  if (!activeTab) {
    return <div className="empty">No file open</div>;
  }

  if (activeTab.commit) {
    return <CommitDiffView key={activeTab.path} tab={activeTab} />;
  }

  if (activeTab.showDiff) {
    return <DiffView key={activeTab.path} tab={activeTab} />;
  }

  return (
    <>
      <Editor
        theme={EDITOR_THEME_ID}
        onMount={handleMount}
        // Without this the wrapper disposes the active model when it unmounts
        // (switching to the diff view, closing the last tab) — models belong
        // to monacoModelRegistry.
        keepCurrentModel
        options={EDITOR_OPTIONS}
      />
      {loadError && <div className="empty editor__error">{loadError}</div>}
    </>
  );
}
