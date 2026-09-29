import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { getActiveEditor } from "../lib/editorInstance";
import { openFileFromGroup } from "../lib/pinGroupActions";
import {
  backToGroups,
  enterGroup,
  filterGroupFiles,
  filterGroups,
  initialQuickPick,
  matchQuickPickHotkey,
  nthGroupId,
  quickPickKey,
  quickPickShortcutLabel,
  setQuickPickQuery,
  type QuickPickCommand,
} from "../lib/pinGroupQuickPick";
import { useEditorStore } from "../state/editorStore";
import { usePinGroupStore } from "../state/pinGroupStore";
import { usePinQuickPickStore } from "../state/pinQuickPickStore";
import { FileIcon } from "./FileIcon";
import { PinIcon } from "./icons";
import { Highlighted } from "./QuickOpen";
import { useMissingGroupPaths } from "./useMissingGroupPaths";

/** "Pin Groups" quick pick (Ctrl+Alt+P): pick a group, then one of its files. */
export function PinGroupQuickPick() {
  const isOpen = usePinQuickPickStore((s) => s.isOpen);
  const session = usePinQuickPickStore((s) => s.session);
  // Mounted fresh on every open, like Quick Open, so it always starts clean.
  return isOpen ? <PinGroupQuickPickPanel key={session} /> : null;
}

/**
 * Ctrl+Alt+P (Cmd+Alt+P): the quick pick's group list. Ctrl+Alt+1…9: straight
 * to that group's files; a number with no group behind it is left alone.
 */
export function usePinQuickPickHotkeys(): void {
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const match = matchQuickPickHotkey({
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState?.("AltGraph") ?? false,
      });
      if (!match) return;
      const groups = usePinGroupStore.getState().groups;
      const groupId = match.nth === null ? null : nthGroupId(groups, match.nth);
      if (match.nth !== null && !groupId) return;
      event.preventDefault();
      event.stopPropagation();
      usePinQuickPickStore.getState().open(groupId);
    }
    // Captured ahead of Monaco and the terminal, like Quick Open's shortcuts.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}

function PinGroupQuickPickPanel() {
  const initialGroupId = usePinQuickPickStore((s) => s.initialGroupId);
  const close = usePinQuickPickStore((s) => s.close);
  const groups = usePinGroupStore((s) => s.groups);
  const activeGroupId = usePinGroupStore((s) => s.activeGroupId);
  const root = usePinGroupStore((s) => s.root);
  const tabs = useEditorStore((s) => s.tabs);
  const missing = useMissingGroupPaths();

  const [state, setState] = useState(() => initialQuickPick(usePinGroupStore.getState().groups, initialGroupId));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const group = state.groupId === null ? undefined : groups.find((g) => g.id === state.groupId);
  // The group was deleted while browsing it: back to the list.
  useEffect(() => {
    if (state.groupId !== null && !group) setState((s) => ({ ...s, groupId: null, query: "", selected: 0 }));
  }, [state.groupId, group]);

  const groupItems = useMemo(() => (group ? [] : filterGroups(groups, state.query)), [group, groups, state.query]);
  const fileItems = useMemo(() => (group ? filterGroupFiles(group, root, state.query) : []), [group, root, state.query]);
  const ids = group ? fileItems.map((f) => f.path) : groupItems.map((g) => g.group.id);
  const selected = Math.min(state.selected, Math.max(0, ids.length - 1));
  const dirty = useMemo(() => new Set(tabs.filter((t) => t.isDirty).map((t) => t.path)), [tabs]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [state.groupId]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected, state.groupId]);

  function run(command: QuickPickCommand | null) {
    if (!command) return;
    close();
    if (command.type === "openFile") {
      void openFileFromGroup(command.groupId, command.path, missing.has(command.path)).then((result) => {
        if (result === "opened") requestAnimationFrame(() => getActiveEditor()?.focus());
      });
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const result = quickPickKey({ ...state, selected }, event.key, ids);
    if (!result.handled) return;
    event.preventDefault();
    setState(result.state);
    run(result.command);
  }

  const placeholder = group ? `Search files in "${group.name}" (Backspace to go back)` : "Select a pin group";

  return createPortal(
    <div className="palette-backdrop" onPointerDown={close}>
      <div className="palette" role="dialog" aria-label="Pin groups" onPointerDown={(e) => e.stopPropagation()}>
        {group && (
          <div className="palette__crumb">
            <button className="palette__crumb-back" onClick={() => setState(backToGroups)}>
              Pin Groups
            </button>
            <span>›</span>
            <span className="palette__crumb-name">{group.name}</span>
          </div>
        )}
        <input
          ref={inputRef}
          className="palette__input"
          value={state.query}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => setState((s) => setQuickPickQuery(s, e.target.value))}
          onKeyDown={onKeyDown}
        />

        {groups.length === 0 ? (
          <div className="palette__hint">No pin groups yet. Save pinned tabs as a group from the tab bar.</div>
        ) : ids.length === 0 ? (
          <div className="palette__hint">{group ? (state.query ? "No matching files" : "No files in this group yet") : "No matching groups"}</div>
        ) : group ? (
          <ul ref={listRef} className="palette__list" role="listbox">
            {fileItems.map((item, i) => {
              const isMissing = missing.has(item.path);
              return (
                <li
                  key={item.path}
                  role="option"
                  aria-selected={i === selected}
                  className={`palette__item${i === selected ? " is-selected" : ""}${isMissing ? " is-missing" : ""}`}
                  title={isMissing ? `${item.path} (missing)` : item.path}
                  onMouseMove={() => i !== selected && setState((s) => ({ ...s, selected: i }))}
                  onClick={() => run({ type: "openFile", groupId: group.id, path: item.path })}
                >
                  <FileIcon name={item.name} />
                  <span className="palette__name">
                    <Highlighted text={item.name} indices={item.nameIndices} />
                  </span>
                  <span className="palette__dir">
                    <Highlighted text={item.dir} indices={item.dirIndices} />
                  </span>
                  {dirty.has(item.path) && <span className="palette__dirty" title="Unsaved changes">●</span>}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul ref={listRef} className="palette__list" role="listbox">
            {groupItems.map(({ group: g, indices }, i) => (
              <li
                key={g.id}
                role="option"
                aria-selected={i === selected}
                className={`palette__item${i === selected ? " is-selected" : ""}${g.id === activeGroupId ? " is-active-group" : ""}`}
                onMouseMove={() => i !== selected && setState((s) => ({ ...s, selected: i }))}
                onClick={() => setState((s) => enterGroup({ ...s, selected: i }, g.id))}
              >
                <PinIcon />
                <span className="palette__name">
                  <Highlighted text={g.name} indices={indices} />
                </span>
                <span className="palette__dir">
                  {g.paths.length === 1 ? "1 file" : `${g.paths.length} files`}
                  {g.id === activeGroupId && " • active"}
                </span>
                {i < 9 && !state.query && <kbd className="palette__kbd">{quickPickShortcutLabel(undefined, String(i + 1))}</kbd>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
