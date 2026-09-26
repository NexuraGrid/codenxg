import type { SwitchBlock } from "./tauri-api";

export interface SwitchExplanation {
  title: string;
  message: string;
  /** Stashing clears the way (local changes, untracked files); it can't fix a half-done merge. */
  canStash: boolean;
}

const MAX_LISTED_FILES = 8;

function fileList(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `• ${f}`);
  if (files.length > MAX_LISTED_FILES) shown.push(`…and ${files.length - MAX_LISTED_FILES} more`);
  return shown.join("\n");
}

/**
 * Why git wouldn't move to `target`, in plain words. `created` is true when
 * the branch was just made: it exists, the user just isn't on it.
 */
export function explainSwitchBlock(
  block: SwitchBlock,
  target: string,
  current: string,
  created: boolean,
): SwitchExplanation {
  const title = created
    ? `Branch "${target}" was created, but you're still on "${current}"`
    : `Can't switch to "${target}" yet`;

  switch (block.kind) {
    case "local-changes":
      return {
        title,
        message:
          `You have uncommitted changes that "${target}" would overwrite:\n${fileList(block.files)}\n\n` +
          "Commit them first, or stash them: they are put aside and you can bring them back later with “git stash pop”.",
        canStash: true,
      };
    case "untracked-files":
      return {
        title,
        message:
          `These new files (not in git yet) have the same names as files in "${target}":\n${fileList(block.files)}\n\n` +
          "Move, rename or commit them first — or stash them to set them aside.",
        canStash: true,
      };
    case "unresolved-conflicts":
      return {
        title,
        message:
          "A merge is in progress and some files still have conflicts" +
          (block.files.length ? `:\n${fileList(block.files)}` : ".") +
          "\n\nResolve them (see “Merge Changes” in Source Control), stage and commit, then switch.",
        canStash: false,
      };
    default:
      return { title, message: `git said:\n${block.detail}`, canStash: false };
  }
}
