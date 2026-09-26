import * as monaco from "monaco-editor";
import { useEditorStore } from "../state/editorStore";
import { isSameOrInside, rebase } from "./paths";
import { languageFromPath } from "./language";

interface ModelEntry {
  model: monaco.editor.ITextModel;
  /** Mutable: a rename updates it, and the change listener reads it live. */
  path: string;
  savedVersionId: number;
  /**
   * What the file held the last time we read or wrote it; null once it was
   * deleted. Lets a change event tell our own save from someone else's edit.
   */
  diskText: string | null;
}

// Monaco models are mutable, non-serializable class instances — they live
// here, outside Zustand, so switching tabs never recreates them and loses
// undo history / cursor / scroll position.
const entries = new Map<string, ModelEntry>();

export function getModel(path: string): monaco.editor.ITextModel | undefined {
  return entries.get(path)?.model;
}

/** The file a model belongs to (models are keyed by path, not the reverse). */
export function pathOfModel(model: monaco.editor.ITextModel): string | undefined {
  for (const entry of entries.values()) if (entry.model === model) return entry.path;
  return undefined;
}

export function createModel(path: string, content: string, language: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(content, language);
  const entry: ModelEntry = { model, path, savedVersionId: model.getAlternativeVersionId(), diskText: content };
  entries.set(path, entry);

  model.onDidChangeContent(() => {
    const dirty = model.getAlternativeVersionId() !== entry.savedVersionId;
    useEditorStore.getState().setDirty(entry.path, dirty);
  });

  return model;
}

export function markSaved(path: string, diskText: string): void {
  const entry = entries.get(path);
  if (!entry) return;
  entry.diskText = diskText;
  setClean(entry);
}

function setClean(entry: ModelEntry): void {
  entry.savedVersionId = entry.model.getAlternativeVersionId();
  useEditorStore.getState().setDirty(entry.path, false);
}

function isDirty(entry: ModelEntry): boolean {
  return entry.model.getAlternativeVersionId() !== entry.savedVersionId;
}

export type DiskSync = "unchanged" | "reloaded" | "conflict";

/**
 * Brings an open file in line with `text`, just read from disk. A clean file
 * is reloaded in place (as an undoable edit); a file with unsaved changes is
 * left alone and reported as a conflict for the user to settle.
 */
export function syncWithDisk(path: string, text: string): DiskSync {
  const entry = entries.get(path);
  if (!entry || text === entry.diskText) return "unchanged";
  entry.diskText = text;

  if (entry.model.getValue() === text) {
    setClean(entry);
    return "unchanged";
  }
  if (isDirty(entry)) return "conflict";

  replaceContent(entry, text);
  return "reloaded";
}

/** Settles a conflict in favour of the disk: unsaved edits are dropped (undo still has them). */
export function reloadFromDisk(path: string): void {
  const entry = entries.get(path);
  if (entry?.diskText != null) replaceContent(entry, entry.diskText);
}

/** The file is gone from disk: keep the text, but flag it so saving recreates it. */
export function markDeletedOnDisk(path: string): void {
  const entry = entries.get(path);
  if (!entry || entry.diskText === null) return;
  entry.diskText = null;
  entry.savedVersionId = -1;
  useEditorStore.getState().setDirty(path, true);
}

function replaceContent(entry: ModelEntry, text: string): void {
  const { model } = entry;
  model.pushStackElement();
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
  model.pushStackElement();
  setClean(entry);
}

/**
 * Re-keys every model at or under `from` after a rename. Models keep their
 * content, unsaved edits and undo history; the language follows a changed
 * extension (notes.txt -> notes.go).
 */
export function rebaseModels(from: string, to: string): void {
  const moved = [...entries.values()].filter((e) => isSameOrInside(e.path, from));
  for (const entry of moved) {
    entries.delete(entry.path);
    entry.path = rebase(entry.path, from, to);
    entries.set(entry.path, entry);

    const language = languageFromPath(entry.path);
    if (entry.model.getLanguageId() !== language) monaco.editor.setModelLanguage(entry.model, language);
  }
}

export function disposeAllModels(): void {
  for (const path of [...entries.keys()]) disposeModel(path);
}

export function disposeModel(path: string): void {
  const entry = entries.get(path);
  if (entry) {
    entry.model.dispose();
    entries.delete(path);
  }
}
