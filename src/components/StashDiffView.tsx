import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import type { EditorTab } from "../state/editorStore";
import { gitStashFileDiff } from "../lib/tauri-api";
import { EDITOR_THEME_ID } from "../lib/editorTheme";
import { EDITOR_OPTIONS } from "../lib/editorOptions";

/** One file's change in a stash: its base commit's version against the stashed one. Read-only. */
export function StashDiffView({ tab }: { tab: EditorTab }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stash = tab.stash!;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const diff = monaco.editor.createDiffEditor(container, {
      ...EDITOR_OPTIONS,
      theme: EDITOR_THEME_ID,
      readOnly: true,
      originalEditable: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
    });
    const original = monaco.editor.createModel("", tab.language);
    const modified = monaco.editor.createModel("", tab.language);
    diff.setModel({ original, modified });

    let cancelled = false;
    gitStashFileDiff(stash.index, stash.file, stash.origFile).then(({ before, after }) => {
      if (cancelled) return;
      original.setValue(before ?? "");
      modified.setValue(after ?? "");
    });

    return () => {
      cancelled = true;
      diff.setModel(null);
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [stash.index, stash.file, stash.origFile, tab.language]);

  return (
    <div className="diff-view">
      <div className="diff-view__bar">
        <span className="diff-view__title">{tab.title}</span>
        <span className="diff-view__hint">Stash #{stash.index} — {stash.message} (read-only)</span>
      </div>
      <div ref={containerRef} className="diff-view__body" />
    </div>
  );
}
