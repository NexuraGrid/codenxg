import { useEffect, useRef, type KeyboardEvent } from "react";
import * as monaco from "monaco-editor";
import { useSearchStore } from "../state/searchStore";
import { splitPreview, summarizeResults } from "../lib/searchQuery";
import { openMatchInFile } from "../lib/editorNavigation";
import { languageFromPath } from "../lib/language";
import { basename, dirname } from "../lib/paths";
import { FileIcon } from "./FileIcon";
import { ChevronIcon, PencilIcon, RefreshIcon } from "./icons";
import type { FileMatches, SearchMatch } from "../lib/tauri-api";

const DEBOUNCE_MS = 300;

export function SearchPanel({ root }: { root: string }) {
  const query = useSearchStore((s) => s.query);
  const replaceValue = useSearchStore((s) => s.replaceValue);
  const isReplaceOpen = useSearchStore((s) => s.isReplaceOpen);
  const matchCase = useSearchStore((s) => s.matchCase);
  const wholeWord = useSearchStore((s) => s.wholeWord);
  const useRegex = useSearchStore((s) => s.useRegex);
  const include = useSearchStore((s) => s.include);
  const exclude = useSearchStore((s) => s.exclude);
  const isSearching = useSearchStore((s) => s.isSearching);
  const error = useSearchStore((s) => s.error);
  const files = useSearchStore((s) => s.files);
  const truncated = useSearchStore((s) => s.truncated);
  const collapsedPaths = useSearchStore((s) => s.collapsedPaths);
  const focusToken = useSearchStore((s) => s.focusToken);

  const inputRef = useRef<HTMLInputElement | null>(null);

  // Fires on mount and every later Ctrl+Shift+F, even if the panel was
  // already open.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // Re-runs 300ms after the last change to any option, so typing doesn't
  // fire a search per keystroke; toggling a checkbox re-searches too.
  useEffect(() => {
    const timer = setTimeout(() => {
      void useSearchStore.getState().runSearch(root);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [root, query, matchCase, wholeWord, useRegex, include, exclude]);

  function searchNow() {
    void useSearchStore.getState().runSearch(root);
  }

  function onQueryKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      searchNow();
    }
  }

  const { matchCount, fileCount } = summarizeResults(files);

  return (
    <div className="search">
      <div className="search__inputs">
        <div className="search__field">
          <button
            className="search__reveal-replace"
            title={isReplaceOpen ? "Hide replace" : "Show replace"}
            onClick={() => useSearchStore.getState().setIsReplaceOpen(!isReplaceOpen)}
          >
            <ChevronIcon open={isReplaceOpen} />
          </button>
          <input
            ref={inputRef}
            className="search__input"
            placeholder="Search"
            spellCheck={false}
            value={query}
            onChange={(e) => useSearchStore.getState().setQuery(e.target.value)}
            onKeyDown={onQueryKeyDown}
          />
          <div className="search__toggles">
            <ToggleButton label="Aa" title="Match case" active={matchCase} onToggle={() => useSearchStore.getState().setMatchCase(!matchCase)} />
            <ToggleButton label="ab" title="Match whole word" active={wholeWord} onToggle={() => useSearchStore.getState().setWholeWord(!wholeWord)} />
            <ToggleButton label=".*" title="Use regular expression" active={useRegex} onToggle={() => useSearchStore.getState().setUseRegex(!useRegex)} />
          </div>
        </div>

        {isReplaceOpen && (
          <div className="search__field">
            <span className="search__field-spacer" />
            <input
              className="search__input"
              placeholder="Replace"
              spellCheck={false}
              value={replaceValue}
              onChange={(e) => useSearchStore.getState().setReplaceValue(e.target.value)}
              onKeyDown={onQueryKeyDown}
            />
            <button
              className="search__replace-all"
              title="Replace All"
              disabled={files.length === 0}
              onClick={() => void useSearchStore.getState().replaceAll()}
            >
              <PencilIcon />
            </button>
          </div>
        )}

        <div className="search__globs">
          <input
            className="search__glob"
            placeholder="files to include (e.g. *.ts,src/**)"
            spellCheck={false}
            value={include}
            onChange={(e) => useSearchStore.getState().setInclude(e.target.value)}
          />
          <input
            className="search__glob"
            placeholder="files to exclude"
            spellCheck={false}
            value={exclude}
            onChange={(e) => useSearchStore.getState().setExclude(e.target.value)}
          />
        </div>
      </div>

      <div className="search__summary">
        {error
          ? error
          : isSearching
            ? "Searching…"
            : query.trim() === ""
              ? "Type to search across the project."
              : `${matchCount} result${matchCount === 1 ? "" : "s"} in ${fileCount} file${fileCount === 1 ? "" : "s"}${
                  truncated ? " (truncated)" : ""
                }`}
        <button className="icon-btn search__refresh" title="Search again" onClick={searchNow}>
          <RefreshIcon />
        </button>
      </div>

      <div className="search__results">
        {files.map((file) => (
          <FileGroup key={file.path} root={root} file={file} collapsed={collapsedPaths.has(file.path)} />
        ))}
      </div>
    </div>
  );
}

function ToggleButton({
  label,
  title,
  active,
  onToggle,
}: {
  label: string;
  title: string;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`search__toggle${active ? " is-active" : ""}`}
      title={title}
      aria-pressed={active}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

function FileGroup({ root, file, collapsed }: { root: string; file: FileMatches; collapsed: boolean }) {
  const name = basename(file.path);
  const folder = dirname(file.path).slice(root.length + 1);

  return (
    <section className="search__file">
      <header className="search__file-header" onClick={() => useSearchStore.getState().toggleCollapsed(file.path)}>
        <ChevronIcon open={!collapsed} />
        <FileIcon name={name} languageId={languageFromPath(file.path)} />
        <span className="search__file-name">{name}</span>
        <span className="search__file-folder">{folder}</span>
        <span className="search__count">{file.matches.length}</span>
        <button
          className="icon-btn search__file-replace"
          title="Replace in file"
          onClick={(e) => {
            e.stopPropagation();
            void useSearchStore.getState().replaceInFile(file.path);
          }}
        >
          <PencilIcon />
        </button>
      </header>

      {!collapsed && (
        <ul className="search__matches">
          {file.matches.map((match, i) => (
            <MatchRow key={i} path={file.path} match={match} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MatchRow({ path, match }: { path: string; match: SearchMatch }) {
  const { before, match: matched, after } = splitPreview(match.preview, match.previewMatchStart, match.previewMatchEnd);

  function open() {
    const range = new monaco.Range(match.line, match.startColumn, match.line, match.endColumn);
    openMatchInFile(path, range);
  }

  return (
    <li className="search__match" onClick={open} title={`Line ${match.line}`}>
      <span className="search__match-line">{match.line}</span>
      <span className="search__match-preview">
        {before}
        <mark>{matched}</mark>
        {after}
      </span>
    </li>
  );
}
