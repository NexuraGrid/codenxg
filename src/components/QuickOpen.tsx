import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type * as monacoTypes from "monaco-editor";
import { listFiles } from "../lib/tauri-api";
import { matchPath } from "../lib/fuzzy";
import { getActiveEditor } from "../lib/editorInstance";
import { languageFromPath } from "../lib/language";
import { useEditorStore } from "../state/editorStore";
import { usePaletteStore } from "../state/paletteStore";
import { FileIcon } from "./FileIcon";

const MAX_RESULTS = 60;

interface FileItem {
  path: string;
  name: string;
  dir: string;
}

interface Result {
  item: FileItem;
  nameIndices: number[];
  dirIndices: number[];
}

interface FileIndex {
  root: string;
  items: FileItem[];
  truncated: boolean;
}

// Survives closing the palette: reopening shows the last listing instantly
// while a fresh one loads in the background.
let cachedIndex: FileIndex | null = null;

function toItem(root: string, path: string): FileItem {
  const relative = path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]+/, "") : path;
  const slash = Math.max(relative.lastIndexOf("/"), relative.lastIndexOf("\\"));
  return { path, name: relative.slice(slash + 1), dir: slash === -1 ? "" : relative.slice(0, slash) };
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const marked = new Set(indices);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = marked.has(0);

  for (let i = 0; i <= text.length; i++) {
    const isMarked = marked.has(i);
    if (i === text.length || isMarked !== runMarked) {
      if (run) parts.push(runMarked ? <mark key={i}>{run}</mark> : run);
      run = "";
      runMarked = isMarked;
    }
    if (i < text.length) run += text[i];
  }
  return <>{parts}</>;
}

function lineTarget(
  query: string,
  model: monacoTypes.editor.ITextModel | null | undefined,
): monacoTypes.IPosition | null {
  const match = /^:\s*(\d+)(?:[:,]\s*(\d+))?\s*$/.exec(query);
  if (!match || !model) return null;
  const lineNumber = Math.min(Math.max(Number(match[1]), 1), model.getLineCount());
  const column = Math.min(Math.max(Number(match[2] ?? 1), 1), model.getLineMaxColumn(lineNumber));
  return { lineNumber, column };
}

export function QuickOpen({ root }: { root: string }) {
  const isOpen = usePaletteStore((s) => s.isOpen);
  // Mounted fresh on every open, so query/selection always start clean.
  return isOpen ? <QuickOpenPanel root={root} /> : null;
}

function QuickOpenPanel({ root }: { root: string }) {
  const initialQuery = usePaletteStore((s) => s.initialQuery);
  const close = usePaletteStore((s) => s.close);
  const openTabs = useEditorStore((s) => s.tabs);

  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [index, setIndex] = useState<FileIndex | null>(() => (cachedIndex?.root === root ? cachedIndex : null));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const editor = getActiveEditor();
  const model = editor?.getModel();
  // Taken once, to undo the live go-to-line preview if the user cancels.
  const [initialView] = useState(() => editor?.saveViewState() ?? null);
  const previewedRef = useRef(false);

  const isLineMode = query.startsWith(":");
  const target = isLineMode ? lineTarget(query, model) : null;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listFiles(root)
      .then((list) => {
        const fresh = { root, items: list.files.map((p) => toItem(root, p)), truncated: list.truncated };
        cachedIndex = fresh;
        if (!cancelled) setIndex(fresh);
      })
      .catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [root]);

  // Live preview, as in VS Code: the editor follows the typed line.
  useEffect(() => {
    if (!editor || !target) return;
    previewedRef.current = true;
    editor.setPosition(target);
    editor.revealPositionInCenter(target);
  }, [editor, target?.lineNumber, target?.column]);

  const results = useMemo<Result[]>(() => {
    if (isLineMode || !index) return [];
    const q = query.replace(/\s+/g, "");

    if (!q) {
      // Empty query: open tabs first (most recent last in the strip, so reversed).
      const open = new Set(openTabs.map((t) => t.path));
      const items = [
        ...[...openTabs].reverse().map((t) => toItem(root, t.path)),
        ...index.items.filter((f) => !open.has(f.path)),
      ];
      return items.slice(0, MAX_RESULTS).map((item) => ({ item, nameIndices: [], dirIndices: [] }));
    }

    const scored: (Result & { score: number })[] = [];
    for (const item of index.items) {
      const match = matchPath(q, item.dir, item.name);
      if (match) scored.push({ item, ...match });
    }
    scored.sort((a, b) => b.score - a.score || a.item.dir.length - b.item.dir.length);
    return scored.slice(0, MAX_RESULTS);
  }, [index, query, isLineMode, openTabs, root]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function cancel() {
    if (previewedRef.current && editor && initialView) editor.restoreViewState(initialView);
    close();
  }

  function openResult(result: Result | undefined) {
    if (!result) return;
    const { path, name } = result.item;
    useEditorStore.getState().addTab({ path, title: name, isDirty: false, language: languageFromPath(path) });
    close();
    requestAnimationFrame(() => getActiveEditor()?.focus());
  }

  function confirm() {
    if (!isLineMode) {
      openResult(results[selected]);
      return;
    }
    if (!editor || !target) return;
    editor.setPosition(target);
    editor.revealPositionInCenter(target);
    close();
    editor.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter") {
      event.preventDefault();
      confirm();
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setSelected((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setSelected((i) => (i - 1 + results.length) % results.length);
    }
  }

  function lineHint(): string {
    if (!editor || !model) return "Open a file to go to a line.";
    if (target) {
      return target.column > 1
        ? `Go to line ${target.lineNumber}, character ${target.column}.`
        : `Go to line ${target.lineNumber}.`;
    }
    const position = editor.getPosition();
    const current = position ? `Current line: ${position.lineNumber}, character: ${position.column}. ` : "";
    return `${current}Type a line number between 1 and ${model.getLineCount()} to navigate to.`;
  }

  return createPortal(
    <div className="palette-backdrop" onPointerDown={cancel}>
      <div className="palette" role="dialog" aria-label="Quick open" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          spellCheck={false}
          placeholder="Search files by name (type : to go to a line)"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />

        {isLineMode ? (
          <div className="palette__hint">{lineHint()}</div>
        ) : !index ? (
          <div className="palette__hint">Indexing files…</div>
        ) : results.length === 0 ? (
          <div className="palette__hint">No matching files</div>
        ) : (
          <ul ref={listRef} className="palette__list" role="listbox">
            {results.map((result, i) => (
              <li
                key={result.item.path}
                role="option"
                aria-selected={i === selected}
                className={`palette__item${i === selected ? " is-selected" : ""}`}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={() => openResult(result)}
              >
                <FileIcon name={result.item.name} />
                <span className="palette__name">
                  <Highlighted text={result.item.name} indices={result.nameIndices} />
                </span>
                <span className="palette__dir">
                  <Highlighted text={result.item.dir} indices={result.dirIndices} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {!isLineMode && index?.truncated && (
          <div className="palette__footer">Showing the first 20,000 files of this project.</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
