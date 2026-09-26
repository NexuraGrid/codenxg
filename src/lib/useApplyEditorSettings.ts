import { useEffect } from "react";
import { useSettingsStore } from "../state/settingsStore";
import { applyIndentSettingsToAllModels } from "./monacoModelRegistry";

/**
 * Applies model-level settings (tab size, insert spaces, detect indentation)
 * to every open model as soon as they change — not just newly opened files.
 * Mounted once, independent of any project, since settings are global.
 */
export function useApplyEditorSettings(): void {
  useEffect(() => {
    return useSettingsStore.subscribe((state, previous) => {
      const a = state.settings.editor;
      const b = previous.settings.editor;
      if (a.tabSize !== b.tabSize || a.insertSpaces !== b.insertSpaces || a.detectIndentation !== b.detectIndentation) {
        applyIndentSettingsToAllModels();
      }
    });
  }, []);
}
