// Monaco ships its own Cut/Copy/Paste context-menu commands as an internal
// contribution, without public types (see editorClipboard.ts for why this is
// used at all: their default implementation goes through
// document.execCommand()/navigator.clipboard, which is unreliable inside a
// Tauri webview). `^0.56.0` only auto-updates within 0.56.x, which keeps this
// path reasonably stable; CutAction/CopyAction/PasteAction are still
// individually optional below because Monaco itself only registers them when
// the browser claims to support the underlying execCommand/Clipboard API.
declare module "monaco-editor/editor/contrib/clipboard/browser/clipboard.js" {
  /** A command with multiple priority-ordered implementations (see MultiCommand in editorExtensions.js). */
  export interface EditorClipboardMultiCommand {
    addImplementation(
      priority: number,
      name: string,
      implementation: (accessor: unknown, args: unknown) => unknown,
    ): { dispose(): void };
  }
  export const CutAction: EditorClipboardMultiCommand | undefined;
  export const CopyAction: EditorClipboardMultiCommand | undefined;
  export const PasteAction: EditorClipboardMultiCommand | undefined;
}
