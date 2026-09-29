import type * as monacoTypes from "monaco-editor";
import { getModel, markSaved } from "./monacoModelRegistry";
import { writeFile } from "./tauri-api";
import { notifySaved } from "./lsp/manager";
import { getActiveEditor } from "./editorInstance";
import { useSettingsStore } from "../state/settingsStore";
import { useEditorStore } from "../state/editorStore";
import { showDialog } from "../state/dialogStore";

export async function saveFile(path: string): Promise<void> {
  const model = getModel(path);
  if (!model) return;
  if (useSettingsStore.getState().settings.editor.formatOnSave) {
    await tryFormat(model);
  }
  const content = model.getValue();
  await writeFile(path, content);
  markSaved(path, content);
  notifySaved(model);
  // Saving a preview tab keeps it, same as editing it would.
  useEditorStore.getState().makePermanent(path);
}

/** Ctrl+S / "File: Save": saves the active tab, reporting a failed write in a dialog. */
export async function saveActiveTab(): Promise<void> {
  const { tabs, activeTabPath } = useEditorStore.getState();
  const tab = tabs.find((t) => t.path === activeTabPath);
  if (!tab) return;
  try {
    await saveFile(tab.path);
  } catch (error) {
    await showDialog({
      title: `Couldn't save ${tab.title}`,
      message: String(error),
      buttons: [{ label: "OK", value: "ok", variant: "primary" }],
      cancelValue: "ok",
    });
  }
}

// Best-effort: the language-registered formatting provider (see lsp/manager.ts)
// runs through Monaco's own action, which needs a visible editor attached to
// the model. A dirty tab saved in the background (Save All, auto save) while
// it isn't the active tab just saves unformatted rather than failing.
async function tryFormat(model: monacoTypes.editor.ITextModel): Promise<void> {
  const editor = getActiveEditor();
  if (!editor || editor.getModel() !== model) return;
  try {
    await editor.getAction("editor.action.formatDocument")?.run();
  } catch {
    // No formatting provider, or the server rejected it: save as-is.
  }
}
