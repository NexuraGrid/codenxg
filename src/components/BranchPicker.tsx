import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useGitStore } from "../state/gitStore";
import type { GitBranch } from "../lib/tauri-api";
import { BranchPlusIcon, GitIcon, PlusIcon, RefreshIcon } from "./icons";

type Item = { kind: "create"; name: string } | { kind: "create-from" } | { kind: "branch"; branch: GitBranch };

interface BranchPickerProps {
  onClose: () => void;
  /** Opens the full "Create branch" dialog (pick a base, switch or not). */
  onCreateAdvanced: (name: string) => void;
}

/** VS Code's branch quick pick: filter, switch, or create from what you typed. */
export function BranchPicker({ onClose, onCreateAdvanced }: BranchPickerProps) {
  const branches = useGitStore((s) => s.branches);
  const { loadBranches, checkout, createBranch, fetch } = useGitStore.getState();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadBranches();
    // Clicking anywhere else closes it, like any popup.
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) onClose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [loadBranches, onClose]);

  const items = useMemo<Item[]>(() => {
    const needle = query.trim().toLowerCase();
    const matches = branches.filter((b) => b.name.toLowerCase().includes(needle));
    const exact = branches.some((b) => !b.isRemote && b.name === query.trim());
    const create: Item[] = needle && !exact ? [{ kind: "create", name: query.trim() }] : [];
    return [...create, { kind: "create-from" }, ...matches.map((branch) => ({ kind: "branch" as const, branch }))];
  }, [branches, query]);

  async function choose(item: Item | undefined) {
    if (!item) return;
    onClose();
    if (item.kind === "create") await createBranch(item.name);
    else if (item.kind === "create-from") onCreateAdvanced(query.trim());
    else if (!item.branch.isCurrent) await checkout(item.branch);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") setSelected((i) => Math.min(i + 1, items.length - 1));
    else if (event.key === "ArrowUp") setSelected((i) => Math.max(i - 1, 0));
    else if (event.key === "Enter") void choose(items[selected]);
    else return;
    event.preventDefault();
  }

  return (
    <div ref={rootRef} className="branch-picker">
      <div className="branch-picker__search">
        <input
          autoFocus
          value={query}
          placeholder="Switch to or create a branch…"
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onKeyDown}
        />
        <button className="icon-btn" title="Fetch from remotes" onClick={() => void fetch()}>
          <RefreshIcon />
        </button>
      </div>
      <ul className="branch-picker__list">
        {items.map((item, i) => (
          <li
            key={item.kind === "branch" ? `${item.branch.isRemote}:${item.branch.name}` : item.kind}
            className={`branch-picker__item${i === selected ? " is-selected" : ""}`}
            onPointerEnter={() => setSelected(i)}
            onClick={() => void choose(item)}
          >
            {item.kind === "create" ? (
              <>
                <PlusIcon />
                <span>
                  Create &amp; switch to <strong>{item.name}</strong>
                </span>
              </>
            ) : item.kind === "create-from" ? (
              <>
                <BranchPlusIcon />
                <span>Create new branch from…</span>
              </>
            ) : (
              <>
                <GitIcon />
                <span className={item.branch.isCurrent ? "is-current" : undefined}>{item.branch.name}</span>
                <span className="branch-picker__meta">
                  {item.branch.isCurrent ? "current" : item.branch.isRemote ? "remote" : ""}
                </span>
              </>
            )}
          </li>
        ))}
        {items.length === 0 && <li className="branch-picker__empty">No branches</li>}
      </ul>
    </div>
  );
}
