import { useEditorStore } from "../state/editorStore";

// A synthetic key, same trick as the commit:/stash: tabs (GitHistory.tsx,
// SourceControl.tsx): unique, and never collides with a real file path.
export const SETTINGS_TAB_PATH = "settings:app";

/** Opens the Settings tab, or just focuses it if already open. */
export function openSettingsTab(): void {
  useEditorStore.getState().addTab({
    path: SETTINGS_TAB_PATH,
    title: "Settings",
    isDirty: false,
    language: "plaintext",
    settings: true,
  });
}
