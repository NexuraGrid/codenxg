import type * as monacoTypes from "monaco-editor";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { CopyAction, CutAction, PasteAction } from "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";

type Monaco = typeof monacoTypes;
// getModel/getSelections/trigger/executeEdits/pushUndoStop are all common to
// every code editor (not just the standalone one), which is what lets
// installContextMenuClipboard's global override run against whichever
// editor happens to be focused (see focusedEditor below).
type Editor = monacoTypes.editor.ICodeEditor;

// What the last copy put on the clipboard, so a paste of that same text can
// restore VS Code's behaviours: one piece per cursor, and a whole line copied
// with no selection pasted above the current line instead of mid-line.
let lastCopy: { text: string; pieces: string[]; wholeLines: boolean } | null = null;

/**
 * Ctrl+C / Ctrl+X / Ctrl+V through the native clipboard plugin, and the same
 * for the editor's right-click Cut/Copy/Paste. The webview's own clipboard
 * events/APIs are unreliable under WebKitGTK/WSLg and in other webviews;
 * this also keeps the editor and the terminal on one clipboard.
 */
export function installEditorClipboard(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco): void {
  const { KeyMod, KeyCode } = monaco;
  // Actions rather than addCommand: Monaco registers addCommand keybindings
  // globally, so with an editor per editor group the last one created would
  // handle every editor's Ctrl+C. Actions are scoped to their own editor.
  // editorTextFocus: the find widget's own input keeps its native shortcuts.
  const shortcuts = [
    ["codenxg.clipboard.copy", "Copy", KeyCode.KeyC, copy],
    ["codenxg.clipboard.cut", "Cut", KeyCode.KeyX, cut],
    ["codenxg.clipboard.paste", "Paste", KeyCode.KeyV, paste],
  ] as const;
  for (const [id, label, key, action] of shortcuts) {
    const disposable = editor.addAction({
      id,
      label,
      keybindings: [KeyMod.CtrlCmd | key],
      keybindingContext: "editorTextFocus",
      run: (target) => void action(target),
    });
    editor.onDidDispose(() => disposable.dispose());
  }
  installContextMenuClipboard(editor, monaco);
}

export async function copy(editor: Editor): Promise<boolean> {
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

export async function cut(editor: Editor): Promise<void> {
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

export async function paste(editor: Editor): Promise<void> {
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

// ---- Right-click Cut / Copy / Paste --------------------------------------
//
// Monaco's own "Cut"/"Copy"/"Paste" context-menu rows run through
// document.execCommand()/navigator.clipboard (see clipboard.js in
// monaco-editor): execCommand is deprecated and inconsistent across
// webviews, and navigator.clipboard.readText() needs a clipboard-read
// permission a Tauri webview generally can't grant, so Paste in particular
// tends to silently do nothing. Whether each row even exists at all also
// depends on the webview: Monaco only registers CutAction/CopyAction/
// PasteAction when document.queryCommandSupported('cut'|'copy') /
// navigator.clipboard say they're supported (checked once, at module load).
//
// Rather than adding a second set of menu rows next to Monaco's own — two
// "Paste" entries, one of them silently broken, would be worse than one —
// this replaces *what runs* when the existing row is clicked, using the same
// extension point Monaco itself uses for its Electron-vs-browser fallback:
// MultiCommand#addImplementation. Priority 20000 beats Monaco's own
// implementations (10000 and 0 in clipboard.js), and returning `undefined`
// when no Monaco editor has focus lets the click fall through to them, so
// clipboard in ordinary <input>/<textarea> elements elsewhere in the app
// (the settings fields, the search box, ...) is untouched.
//
// In an environment where Monaco didn't register one of the three commands
// at all (so there would be no row to begin with), addAction below adds a
// plain per-editor context-menu entry for exactly that one — so Cut, Copy
// and Paste are always present, from whichever source is available.
let globalOverrideInstalled = false;

/** The Monaco editor the user is actually typing in right now, if any. */
export function focusedEditor<T extends { hasTextFocus(): boolean }>(editors: readonly T[]): T | undefined {
  return editors.find((e) => e.hasTextFocus());
}

function installContextMenuClipboard(editor: monacoTypes.editor.IStandaloneCodeEditor, monaco: Monaco): void {
  installGlobalOverrideOnce(monaco);
  if (!CutAction) addFallbackAction(editor, "codeEditor.clipboardCut", "Cut", 1, "!editorReadonly", cut);
  if (!CopyAction) addFallbackAction(editor, "codeEditor.clipboardCopy", "Copy", 2, undefined, copy);
  if (!PasteAction) addFallbackAction(editor, "codeEditor.clipboardPaste", "Paste", 4, "!editorReadonly", paste);
}

function installGlobalOverrideOnce(monaco: Monaco): void {
  if (globalOverrideInstalled) return;
  globalOverrideInstalled = true;

  const target = () => focusedEditor(monaco.editor.getEditors());
  CutAction?.addImplementation(20000, "tauri-clipboard", () => {
    const editor = target();
    if (!editor) return undefined;
    void cut(editor);
    return true;
  });
  CopyAction?.addImplementation(20000, "tauri-clipboard", () => {
    const editor = target();
    if (!editor) return undefined;
    void copy(editor);
    return true;
  });
  PasteAction?.addImplementation(20000, "tauri-clipboard", () => {
    const editor = target();
    if (!editor) return undefined;
    void paste(editor);
    return true;
  });
}

function addFallbackAction(
  editor: monacoTypes.editor.IStandaloneCodeEditor,
  id: string,
  label: string,
  contextMenuOrder: number,
  precondition: string | undefined,
  action: (editor: Editor) => unknown,
): void {
  const disposable = editor.addAction({
    id,
    label,
    contextMenuGroupId: "9_cutcopypaste",
    contextMenuOrder,
    precondition,
    run: (target) => {
      void action(target);
    },
  });
  editor.onDidDispose(() => disposable.dispose());
}
