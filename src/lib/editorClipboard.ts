import type * as monacoTypes from "monaco-editor";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

type Monaco = typeof monacoTypes;
type Editor = monacoTypes.editor.IStandaloneCodeEditor;

// What the last copy put on the clipboard, so a paste of that same text can
// restore VS Code's behaviours: one piece per cursor, and a whole line copied
// with no selection pasted above the current line instead of mid-line.
let lastCopy: { text: string; pieces: string[]; wholeLines: boolean } | null = null;

/**
 * Ctrl+C / Ctrl+X / Ctrl+V through the native clipboard plugin. The webview's
 * own clipboard events are unreliable under WebKitGTK/WSLg; this also keeps
 * the editor and the terminal on one clipboard.
 */
export function installEditorClipboard(editor: Editor, monaco: Monaco): void {
  const { KeyMod, KeyCode } = monaco;
  // editorTextFocus: the find widget's own input keeps its native shortcuts.
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyC, () => void copy(editor), "editorTextFocus");
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyX, () => void cut(editor), "editorTextFocus");
  editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyV, () => void paste(editor), "editorTextFocus");
}

async function copy(editor: Editor): Promise<boolean> {
  const model = editor.getModel();
  const selections = editor.getSelections();
  if (!model || !selections) return false;

  const wholeLines = selections.every((s) => s.isEmpty());
  const eol = model.getEOL();
  const pieces = wholeLines
    ? // No selection copies the cursor's whole line, like VS Code.
      [...new Set(selections.map((s) => s.positionLineNumber))].map((line) => model.getLineContent(line) + eol)
    : selections.filter((s) => !s.isEmpty()).map((s) => model.getValueInRange(s));
  const text = pieces.join(wholeLines ? "" : eol);

  try {
    await writeText(text);
  } catch (error) {
    console.error(error);
    return false;
  }
  lastCopy = { text, pieces, wholeLines };
  return true;
}

async function cut(editor: Editor): Promise<void> {
  const selections = editor.getSelections();
  if (!selections || !(await copy(editor))) return;

  if (selections.every((s) => s.isEmpty())) {
    editor.trigger("keyboard", "editor.action.deleteLines", null);
    return;
  }
  editor.pushUndoStop();
  editor.executeEdits(
    "cut",
    selections.map((range) => ({ range, text: "" })),
  );
  editor.pushUndoStop();
}

async function paste(editor: Editor): Promise<void> {
  let text: string | null;
  try {
    text = await readText();
  } catch (error) {
    console.error(error);
    return;
  }
  if (!text) return;

  const fromUs = lastCopy?.text === text ? lastCopy : null;
  // Monaco's own paste handler: respects multi-cursor, auto-indent and undo.
  editor.trigger("keyboard", "paste", {
    text,
    pasteOnNewLine: fromUs?.wholeLines ?? false,
    multicursorText: fromUs && fromUs.pieces.length > 1 ? fromUs.pieces : null,
  });
}
