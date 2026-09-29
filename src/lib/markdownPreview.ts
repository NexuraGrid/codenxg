import { MARKDOWN_PREVIEW_PREFIX, useEditorStore, type EditorTab } from "../state/editorStore";
import { basename } from "./paths";
import { openToSide } from "./editorGroupActions";

/** Files the preview (Ctrl+Shift+V / Ctrl+K V) applies to. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** A real Markdown file's tab — not a diff, commit, stash or preview view. */
export function isMarkdownSourceTab(tab: EditorTab): boolean {
  return !tab.commit && !tab.stash && !tab.settings && !tab.markdownPreview && isMarkdownPath(tab.path);
}

export function markdownPreviewTab(source: string): EditorTab {
  return {
    path: `${MARKDOWN_PREVIEW_PREFIX}${source}`,
    title: `Preview ${basename(source)}`,
    isDirty: false,
    language: "markdown",
    markdownPreview: { source },
  };
}

/** Opens (or focuses) the rendered preview of `source`. */
export function openMarkdownPreview(source: string): void {
  useEditorStore.getState().addTab(markdownPreviewTab(source));
}

/**
 * Ctrl+K V: opens the rendered preview of `source` in the group to the side
 * (creating it), leaving focus on the Markdown source so typing goes on and
 * the preview follows live.
 */
export function openMarkdownPreviewToSide(source: string): void {
  openToSide(markdownPreviewTab(source));
}

/**
 * Ctrl+Shift+V: from a Markdown file, opens its preview; from a preview, goes
 * back to the file. Returns false (key left alone) for any other tab.
 */
export function toggleMarkdownPreview(): boolean {
  const { tabs, activeTabPath, addTab } = useEditorStore.getState();
  const active = tabs.find((t) => t.path === activeTabPath);
  if (!active) return false;
  if (active.markdownPreview) {
    const source = active.markdownPreview.source;
    addTab({ path: source, title: basename(source), isDirty: false, language: "markdown" });
    return true;
  }
  if (!isMarkdownSourceTab(active)) return false;
  openMarkdownPreview(active.path);
  return true;
}

/** Whether Ctrl+K V would do something for the active tab. */
export function canOpenMarkdownPreviewToSide(): boolean {
  const { tabs, activeTabPath } = useEditorStore.getState();
  const active = tabs.find((t) => t.path === activeTabPath);
  return Boolean(active && isMarkdownSourceTab(active));
}

/** Whether Ctrl+Shift+V would do something for the active tab. */
export function canToggleMarkdownPreview(): boolean {
  const { tabs, activeTabPath } = useEditorStore.getState();
  const active = tabs.find((t) => t.path === activeTabPath);
  return Boolean(active && (active.markdownPreview || isMarkdownSourceTab(active)));
}
