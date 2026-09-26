import type * as monacoTypes from "monaco-editor";

// Module-level so its identity is stable: a fresh object per render makes
// @monaco-editor/react call updateOptions on every keystroke.
export const EDITOR_OPTIONS: monacoTypes.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
  fontSize: 15.8,
  lineHeight: 22.5,
  fontLigatures: false,
  padding: { top: 4, bottom: 40 },
  minimap: { enabled: false },
  folding: false,
  glyphMargin: false,
  // Room for the git change bars (gitGutter.ts).
  lineDecorationsWidth: 10,
  lineNumbersMinChars: 3,
  renderLineHighlight: "none",
  scrollBeyondLastLine: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  cursorWidth: 2,
  cursorBlinking: "blink",
  wordWrap: "off",
  bracketPairColorization: { enabled: true },
  // Standalone Monaco leaves this to the theme, which never opts in.
  "semanticHighlighting.enabled": true,
  guides: { indentation: true, highlightActiveIndentation: true, bracketPairs: false },
  scrollbar: {
    vertical: "auto",
    horizontal: "auto",
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
    verticalSliderSize: 6,
    horizontalSliderSize: 6,
    useShadows: false,
  },
};
