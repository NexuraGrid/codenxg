import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useGitStore, decorationOf, type FileDecoration } from "../state/gitStore";
import { useEditorStore } from "../state/editorStore";
import type { GitChange } from "../lib/tauri-api";
import { basename, dirname } from "../lib/paths";
import { languageFromPath } from "../lib/language";
import { FileIcon } from "./FileIcon";
import { BranchPicker } from "./BranchPicker";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { GitHistory } from "./GitHistory";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  FileIconLine,
  BranchPlusIcon,
  GitIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  UndoIcon,
} from "./icons";

const LETTER_TITLES: Record<FileDecoration, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  U: "Untracked",
  C: "Conflict",
};

function openChange(path: string, showDiff: boolean) {
  useEditorStore.getState().addTab({ path, title: basename(path), isDirty: false, language: languageFromPath(path), showDiff });
}

export function SourceControl({ root }: { root: string }) {
  const status = useGitStore((s) => s.status);
  const busy = useGitStore((s) => s.busy);
  const message = useGitStore((s) => s.message);
  const { refresh, setMessage, commit, push, pull, init, stage, unstage, discard } = useGitStore.getState();
  const [view, setView] = useState<"changes" | "history">("changes");
  const [isPickingBranch, setIsPickingBranch] = useState(false);
  // null = closed; otherwise the name to prefill.
  const [newBranchName, setNewBranchName] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!status) return <div className="scm scm--empty">Loading…</div>;

  if (!status.isRepo) {
    return (
      <div className="scm scm--empty">
        <p>This folder is not a Git repository.</p>
        <button className="scm__primary" onClick={() => void init()} disabled={busy !== null}>
          Initialize Repository
        </button>
      </div>
    );
  }

  const conflicts = status.changes.filter((c) => c.conflicted);
  const staged = status.changes.filter((c) => !c.conflicted && c.index !== "." && c.index !== "?");
  const unstaged = status.changes.filter((c) => !c.conflicted && (c.worktree !== "." || c.index === "?"));
  const branch = status.branch ?? "(detached)";

  async function submit() {
    if (!message.trim() || busy) return;
    if (await commit(message)) setMessage("");
  }

  function handleMessageKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <div className="scm">
      <div className="scm__branch">
        <button
          className="scm__branch-btn"
          title={`${status.upstream ? `Tracking ${status.upstream}` : "Not published"} — click to switch branch`}
          onClick={() => setIsPickingBranch((open) => !open)}
        >
          <GitIcon />
          <span className="scm__branch-name">{branch}</span>
        </button>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="scm__sync-count">
            {status.behind > 0 && `${status.behind}↓ `}
            {status.ahead > 0 && `${status.ahead}↑`}
          </span>
        )}
        <span className="scm__spacer" />
        <button className="icon-btn" title="Create branch…" onClick={() => setNewBranchName("")} disabled={busy !== null}>
          <BranchPlusIcon />
        </button>
        <button className="icon-btn" title="Pull" onClick={() => void pull()} disabled={busy !== null}>
          <ArrowDownIcon />
        </button>
        <button
          className="icon-btn"
          title={status.upstream ? "Push" : "Publish branch"}
          onClick={() => void push()}
          disabled={busy !== null}
        >
          <ArrowUpIcon />
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void refresh()}>
          <RefreshIcon />
        </button>
        {isPickingBranch && (
          <BranchPicker
            onClose={() => setIsPickingBranch(false)}
            onCreateAdvanced={(name) => {
              setIsPickingBranch(false);
              setNewBranchName(name);
            }}
          />
        )}
        {newBranchName !== null && (
          <CreateBranchDialog initialName={newBranchName} onClose={() => setNewBranchName(null)} />
        )}
      </div>

      <div className="scm__views" role="tablist">
        <button className={view === "changes" ? "is-active" : undefined} onClick={() => setView("changes")}>
          Changes
        </button>
        <button className={view === "history" ? "is-active" : undefined} onClick={() => setView("history")}>
          History
        </button>
      </div>

      {view === "history" ? (
        <div className="scm__lists">
          <GitHistory root={root} />
        </div>
      ) : (
        <>
          <div className="scm__commit">
            <textarea
              className="scm__message"
              placeholder={`Message (Ctrl+Enter to commit on "${branch}")`}
              value={message}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleMessageKey}
            />
            <button className="scm__primary" onClick={() => void submit()} disabled={!message.trim() || busy !== null}>
              <CheckIcon />
              {busy ?? "Commit"}
            </button>
          </div>

          <div className="scm__lists">
            {conflicts.length > 0 && (
              <Section
                title="Merge Changes"
                changes={conflicts}
                root={root}
                letter={() => "C"}
                actions={[{ title: "Mark as resolved (stage)", Icon: PlusIcon, run: (c) => stage(paths(c)) }]}
              />
            )}
            {staged.length > 0 && (
              <Section
                title="Staged Changes"
                changes={staged}
                root={root}
                letter={(c) => (c.index === "A" || c.index === "D" || c.index === "R" ? c.index : "M")}
                actions={[{ title: "Unstage", Icon: MinusIcon, run: (c) => unstage(paths(c)) }]}
              />
            )}
            <Section
              title="Changes"
              changes={unstaged}
              root={root}
              letter={(c) => (c.index === "?" ? "U" : decorationOf({ ...c, index: "." }))}
              actions={[
                { title: "Discard changes", Icon: UndoIcon, run: (c) => discard(c) },
                { title: "Stage", Icon: PlusIcon, run: (c) => stage(paths(c)) },
              ]}
              emptyText={staged.length === 0 && conflicts.length === 0 ? "No changes. Everything is committed." : undefined}
            />
          </div>
        </>
      )}
    </div>
  );
}

function paths(changes: GitChange[]): string[] {
  // A rename also involves the old path (its deletion).
  return changes.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path]));
}

interface SectionAction {
  title: string;
  Icon: () => ReactNode;
  run: (changes: GitChange[]) => Promise<void>;
}

interface SectionProps {
  title: string;
  changes: GitChange[];
  root: string;
  letter: (change: GitChange) => FileDecoration;
  actions: SectionAction[];
  emptyText?: string;
}

function Section({ title, changes, root, letter, actions, emptyText }: SectionProps) {
  function act(event: MouseEvent, action: SectionAction, target: GitChange[]) {
    event.stopPropagation();
    void action.run(target);
  }

  return (
    <section className="scm__section">
      <header className="scm__section-header">
        <span>{title}</span>
        <span className="scm__row-actions">
          {changes.length > 0 &&
            actions.map((action) => (
              <button key={action.title} className="icon-btn" title={`${action.title} (all)`} onClick={(e) => act(e, action, changes)}>
                <action.Icon />
              </button>
            ))}
        </span>
        <span className="scm__count">{changes.length}</span>
      </header>

      {changes.length === 0 && emptyText && <p className="scm__empty-text">{emptyText}</p>}

      <ul className="scm__list">
        {changes.map((change) => {
          const decoration = letter(change);
          const name = basename(change.path);
          const folder = dirname(change.path).slice(root.length + 1);
          return (
            <li
              key={change.path}
              className="scm__row"
              title={`${change.path} • ${LETTER_TITLES[decoration]}`}
              onClick={() => openChange(change.path, decoration !== "U")}
            >
              <FileIcon name={name} />
              <span className={`scm__name git-${decoration}${decoration === "D" ? " is-deleted" : ""}`}>{name}</span>
              <span className="scm__folder">{folder}</span>
              <span className="scm__row-actions">
                {decoration !== "D" && (
                  <button className="icon-btn" title="Open file" onClick={(e) => (e.stopPropagation(), openChange(change.path, false))}>
                    <FileIconLine />
                  </button>
                )}
                {actions.map((action) => (
                  <button key={action.title} className="icon-btn" title={action.title} onClick={(e) => act(e, action, [change])}>
                    <action.Icon />
                  </button>
                ))}
              </span>
              <span className={`scm__letter git-${decoration}`}>{decoration}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
