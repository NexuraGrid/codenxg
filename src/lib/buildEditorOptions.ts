import type * as monacoTypes from "monaco-editor";
import { EDITOR_OPTIONS } from "./editorOptions";
import type { EditorSettings } from "./settingsSchema";

/**
 * Turns a bare font name into a full CSS font-family value with the same
 * monospace fallback chain the app has always used. A value that already
 * looks like a stack (it has a comma) is trusted as-is instead of re-quoted.
 */
export function resolveFontFamily(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return String(EDITOR_OPTIONS.fontFamily);
  return trimmed.includes(",") ? trimmed : `"${trimmed}", ui-monospace, Menlo, Consolas, monospace`;
}

/**
 * Monaco editor construction options built from the user's settings. Model-level
 * concerns (tab size, insert spaces, detect indentation) are applied separately
 * via monacoModelRegistry, since they must reach every open model, not just the
 * one attached to the visible editor.
 */
export function buildEditorOptions(settings: EditorSettings): monacoTypes.editor.IStandaloneEditorConstructionOptions {
  return {
    ...EDITOR_OPTIONS,
    fontFamily: resolveFontFamily(settings.fontFamily),
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    minimap: { enabled: settings.minimap },
    wordWrap: settings.wordWrap ? "on" : "off",
    renderWhitespace: settings.renderWhitespace ? "all" : "none",
  };
}
