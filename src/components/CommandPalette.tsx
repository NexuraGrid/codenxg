import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { availableCommands, executeCommand, recentCommandIds } from "../lib/commands/registry";
import { filterCommands, type CommandResult } from "../lib/commands/filter";
import { formatKeybinding } from "../lib/commands/keybindingLabel";
import { usePaletteStore } from "../state/paletteStore";
import { Highlighted } from "./QuickOpen";

/** Command Palette (Ctrl+Shift+P / F1): Quick Open's modal, listing the command registry. */
export function CommandPalette() {
  const isOpen = usePaletteStore((s) => s.isOpen && s.commandMode);
  // Mounted fresh on every open, so the command list and `when`s are current.
  return isOpen ? <CommandPalettePanel /> : null;
}

function CommandPalettePanel() {
  const initialQuery = usePaletteStore((s) => s.initialQuery);
  const close = usePaletteStore((s) => s.close);
  // VS Code's ">" prefix: deleting it drops back to Quick Open's file search.
  const [value, setValue] = useState(`>${initialQuery}`);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // Taken before the input grabs focus, to hand it back (usually the editor).
  const [returnFocus] = useState(() => document.activeElement);
  const [commands] = useState(availableCommands);
  const [recent] = useState(recentCommandIds);

  const query = value.slice(1).trim();
  const results = useMemo(() => filterCommands(commands, query, recent), [commands, query, recent]);

  useEffect(() => {
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function dismiss() {
    close();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
  }

  function run(result: CommandResult | undefined) {
    if (!result) return;
    // Focus goes back first: a command may move it again (another picker, the editor).
    dismiss();
    void executeCommand(result.command.id, { recordRecent: true });
  }

  function onChange(next: string) {
    if (!next.startsWith(">")) {
      usePaletteStore.getState().open(next);
      return;
    }
    setValue(next);
    setSelected(0);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(results[selected]);
    } else if (event.key === "ArrowDown" && results.length) {
      event.preventDefault();
      setSelected((i) => (i + 1) % results.length);
    } else if (event.key === "ArrowUp" && results.length) {
      event.preventDefault();
      setSelected((i) => (i - 1 + results.length) % results.length);
    }
  }

  const recentSet = new Set(recent);

  return createPortal(
    <div className="palette-backdrop" onPointerDown={dismiss}>
      <div className="palette" role="dialog" aria-label="Command palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          value={value}
          spellCheck={false}
          placeholder="Type the name of a command to run"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />

        {results.length === 0 ? (
          <div className="palette__hint">No matching commands</div>
        ) : (
          <ul ref={listRef} className="palette__list" role="listbox">
            {results.map((result, i) => (
              <li
                key={result.command.id}
                role="option"
                aria-selected={i === selected}
                className={`palette__item${i === selected ? " is-selected" : ""}`}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={() => run(result)}
              >
                <span className="palette__name">
                  <Highlighted text={result.label} indices={result.indices} />
                </span>
                {!query && recentSet.has(result.command.id) && <span className="palette__dir">recently used</span>}
                {result.command.keybinding && (
                  <kbd className="palette__kbd">{formatKeybinding(result.command.keybinding)}</kbd>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
