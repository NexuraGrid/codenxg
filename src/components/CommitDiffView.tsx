import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import type { EditorTab } from "../state/editorStore";
import { gitShowAt } from "../lib/tauri-api";
import { EDITOR_THEME_ID } from "../lib/editorTheme";
import { EDITOR_OPTIONS } from "../lib/editorOptions";

/** One file's change in a past commit: its parent's version against the commit's. Read-only. */
export function CommitDiffView({ tab }: { tab: EditorTab }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const commit = tab.commit!;

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
    // A root commit has no parent and an added file has no "before": both are empty.
    Promise.all([
      gitShowAt(`${commit.hash}^`, commit.origFile ?? commit.file).catch(() => null),
      gitShowAt(commit.hash, commit.file).catch(() => null),
    ]).then(([before, after]) => {
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
  }, [commit.hash, commit.file, commit.origFile, tab.language]);

  return (
    <div className="diff-view">
      <div className="diff-view__bar">
        <span className="diff-view__title">{tab.title}</span>
        <span className="diff-view__hint">Commit {commit.shortHash} (read-only)</span>
      </div>
      <div ref={containerRef} className="diff-view__body" />
    </div>
  );
}
