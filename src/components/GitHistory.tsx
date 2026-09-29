import { useEffect, useState } from "react";
import { useGitStore } from "../state/gitStore";
import { openPreviewTab } from "../lib/tabActions";
import { gitCommitFiles, type GitCommit, type GitCommitFile } from "../lib/tauri-api";
import { basename, dirname } from "../lib/paths";
import { languageFromPath } from "../lib/language";
import { relativeTime } from "../lib/relativeTime";
import { FileIcon } from "./FileIcon";
import { ChevronIcon } from "./icons";

function openCommitFile(commit: GitCommit, file: GitCommitFile) {
  openPreviewTab({
    path: `commit:${commit.hash}:${file.path}`,
    title: basename(file.path),
    isDirty: false,
    language: languageFromPath(file.path),
    commit: { hash: commit.hash, shortHash: commit.shortHash, file: file.path, origFile: file.origPath },
  });
}

export function GitHistory({ root }: { root: string }) {
  const history = useGitStore((s) => s.history);
  const hasMore = useGitStore((s) => s.hasMoreHistory);
  const loadHistory = useGitStore((s) => s.loadHistory);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  if (history.length === 0) return <p className="scm__empty-text">No commits yet.</p>;

  return (
    <ul className="history">
      {history.map((commit) => (
        <CommitRow key={commit.hash} commit={commit} root={root} />
      ))}
      {hasMore && (
        <li>
          <button className="history__more" onClick={() => void loadHistory(true)}>
            Load more
          </button>
        </li>
      )}
    </ul>
  );
}

function CommitRow({ commit, root }: { commit: GitCommit; root: string }) {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  function toggle() {
    setIsOpen((open) => !open);
    if (!files) gitCommitFiles(commit.hash).then(setFiles).catch(console.error);
  }

  return (
    <li>
      <div className="history__commit" onClick={toggle} title={`${commit.hash}\n${commit.author}`}>
        <ChevronIcon open={isOpen} />
        <div className="history__text">
          <div className="history__subject">
            <span>{commit.subject}</span>
            {commit.refs.map((ref) => (
              <span key={ref} className="history__ref">
                {ref.replace("HEAD -> ", "")}
              </span>
            ))}
          </div>
          <div className="history__meta">
            {commit.author} · {relativeTime(commit.timestamp)} · {commit.shortHash}
          </div>
        </div>
      </div>
      {isOpen && (
        <ul className="history__files">
          {!files && <li className="scm__empty-text">Loading…</li>}
          {files?.map((file) => (
            <li key={file.path} className="scm__row" onClick={() => openCommitFile(commit, file)}>
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
