import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useGitStore, decorationOf, type FileDecoration } from "../state/gitStore";
import { useEditorStore } from "../state/editorStore";
import { gitStashFiles, type GitChange, type GitCommitFile, type GitStash } from "../lib/tauri-api";
import { basename, dirname } from "../lib/paths";
import { languageFromPath } from "../lib/language";
import { relativeTime } from "../lib/relativeTime";
import { FileIcon } from "./FileIcon";
import { BranchPicker } from "./BranchPicker";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { StashDialog } from "./StashDialog";
import { GitHistory } from "./GitHistory";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronIcon,
  FileIconLine,
  BranchPlusIcon,
  GitIcon,
  MinusIcon,
  PlusIcon,
  RefreshIcon,
  StashApplyIcon,
  StashIcon,
  StashPlusIcon,
  StashPopIcon,
  TrashIcon,
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

function openStashFile(stash: GitStash, file: GitCommitFile) {
  useEditorStore.getState().addTab({
    path: `stash:${stash.index}:${file.path}`,
    title: basename(file.path),
    isDirty: false,
    language: languageFromPath(file.path),
    stash: { index: stash.index, message: stash.message, file: file.path, origFile: file.origPath },
  });
}

export function SourceControl({ root }: { root: string }) {
  const status = useGitStore((s) => s.status);
  const busy = useGitStore((s) => s.busy);
  const message = useGitStore((s) => s.message);
  const stashes = useGitStore((s) => s.stashes);
  const { refresh, setMessage, commit, push, pull, init, stage, unstage, discard, loadStashes, stashPush } =
    useGitStore.getState();
  const [view, setView] = useState<"changes" | "history">("changes");
  const [isPickingBranch, setIsPickingBranch] = useState(false);
  // null = closed; otherwise the name to prefill.
  const [newBranchName, setNewBranchName] = useState<string | null>(null);
  const [isStashing, setIsStashing] = useState(false);

  useEffect(() => {
    void refresh();
    // Cheap and only fetched once per panel mount, not on every status poll.
    void loadStashes();
  }, [refresh, loadStashes]);

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
        <button className="icon-btn" title="Stash changes…" onClick={() => setIsStashing(true)} disabled={busy !== null}>
          <StashIcon />
        </button>
        <button
          className="icon-btn"
          title="Stash (Include Untracked)"
          onClick={() => void stashPush(null, true)}
          disabled={busy !== null}
        >
          <StashPlusIcon />
        </button>
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
        {isStashing && <StashDialog onClose={() => setIsStashing(false)} />}
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
            {stashes.length > 0 && <StashesSection stashes={stashes} root={root} />}
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

function StashesSection({ stashes, root }: { stashes: GitStash[]; root: string }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <section className="scm__section">
      <header className="scm__section-header scm__section-header--clickable" onClick={() => setCollapsed((c) => !c)}>
        <ChevronIcon open={!collapsed} />
        <span>Stashes</span>
        <span className="scm__count">{stashes.length}</span>
      </header>

      {!collapsed && (
        <ul className="scm__list history">
          {stashes.map((stash) => (
            <StashRow key={stash.index} stash={stash} root={root} />
          ))}
        </ul>
      )}
    </section>
  );
}

function StashRow({ stash, root }: { stash: GitStash; root: string }) {
  const { stashApply, stashPop, stashDrop } = useGitStore.getState();
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  function toggle() {
    setIsOpen((open) => !open);
    if (!files) gitStashFiles(stash.index).then(setFiles).catch(console.error);
  }

  function act(event: MouseEvent, run: () => Promise<void>) {
    event.stopPropagation();
    void run();
  }

  return (
    <li>
      <div className="history__commit" onClick={toggle} title={stash.branch ? `On ${stash.branch}` : undefined}>
        <ChevronIcon open={isOpen} />
        <div className="history__text">
          <div className="history__subject">
            <span>{stash.message}</span>
            {stash.branch && <span className="history__ref">{stash.branch}</span>}
          </div>
          <div className="history__meta">{relativeTime(stash.timestamp)}</div>
        </div>
        <span className="scm__row-actions">
          <button className="icon-btn" title="Apply Stash" onClick={(e) => act(e, () => stashApply(stash.index))}>
            <StashApplyIcon />
          </button>
          <button className="icon-btn" title="Pop Stash" onClick={(e) => act(e, () => stashPop(stash.index))}>
            <StashPopIcon />
          </button>
          <button className="icon-btn" title="Drop Stash" onClick={(e) => act(e, () => stashDrop(stash.index))}>
            <TrashIcon />
          </button>
        </span>
      </div>
      {isOpen && (
        <ul className="history__files">
          {!files && <li className="scm__empty-text">Loading…</li>}
          {files?.length === 0 && <li className="scm__empty-text">No files.</li>}
          {files?.map((file) => (
            <li key={file.path} className="scm__row" onClick={() => openStashFile(stash, file)}>
              <FileIcon name={basename(file.path)} />
              <span className={`scm__name git-${file.status === "M" || file.status === "T" ? "M" : file.status}`}>
                {basename(file.path)}
              </span>
              <span className="scm__folder">{dirname(file.path).slice(root.length + 1)}</span>
              <span className={`scm__letter git-${file.status === "T" ? "M" : file.status}`}>{file.status}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
