use super::workspace::ensure_in_workspace;
use crate::state::WorkspaceState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

// The git CLI rather than libgit2: it honours the user's config, hooks and
// credential helpers, and adds nothing to the binary.

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// None before the first commit.
    pub head_oid: Option<String>,
    pub changes: Vec<GitChange>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    /// Where a rename or copy came from.
    pub orig_path: Option<String>,
    /// Porcelain status letters: '.' unchanged, M, A, D, R, C, T, or '?' untracked.
    pub index: char,
    pub worktree: char,
    pub conflicted: bool,
}

#[tauri::command(async)]
pub fn git_status(workspace: State<'_, WorkspaceState>) -> Result<GitStatus, String> {
    let root = workspace_root(&workspace)?;
    let Ok(toplevel) = git(&root, &["rev-parse", "--show-toplevel"]) else {
        return Ok(GitStatus::default());
    };
    // --no-optional-locks: a plain status must not rewrite .git/index, or the
    // file watcher would see that write and trigger another status.
    let raw = git(
        &root,
        &["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_status(&raw, Path::new(toplevel.trim_end())))
}

#[tauri::command(async)]
pub fn git_stage(workspace: State<'_, WorkspaceState>, paths: Vec<String>) -> Result<(), String> {
    let (root, paths) = scoped(&workspace, &paths)?;
    // -A also records deletions of the given paths.
    run_with_paths(&root, &["add", "-A"], &paths)
}

#[tauri::command(async)]
pub fn git_unstage(workspace: State<'_, WorkspaceState>, paths: Vec<String>) -> Result<(), String> {
    let (root, paths) = scoped(&workspace, &paths)?;
    if git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
        run_with_paths(&root, &["restore", "--staged"], &paths)
    } else {
        // Before the first commit there is no HEAD to restore from.
        run_with_paths(&root, &["rm", "--cached", "-r", "-q"], &paths)
    }
}

/// Reverts tracked files to their staged state; untracked files go to the
/// trash (recoverable) since git has no copy of them.
#[tauri::command(async)]
pub fn git_discard(
    workspace: State<'_, WorkspaceState>,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    let (root, tracked) = scoped(&workspace, &tracked)?;
    let (_, untracked) = scoped(&workspace, &untracked)?;
    if !tracked.is_empty() {
        run_with_paths(&root, &["restore"], &tracked)?;
    }
    for path in untracked {
        trash::delete(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn git_commit(workspace: State<'_, WorkspaceState>, message: String, stage_all: bool) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    if message.trim().is_empty() {
        return Err("The commit message is empty".into());
    }
    if stage_all {
        git(&root, &["add", "-A"])?;
    }
    git(&root, &["commit", "-m", &message]).map(|_| ())
}

#[tauri::command(async)]
pub fn git_push(workspace: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    if git(&root, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_ok() {
        git(&root, &["push"]).map(|_| ())
    } else {
        // A new branch: publish it, like VS Code's "Publish Branch".
        git(&root, &["push", "-u", "origin", "HEAD"]).map(|_| ())
    }
}

#[tauri::command(async)]
pub fn git_pull(workspace: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["pull"]).map(|_| ())
}

#[tauri::command(async)]
pub fn git_init(workspace: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["init"]).map(|_| ())
}

/// The file's content at HEAD, or None when it isn't in HEAD (new, untracked,
/// no commits yet) or is binary.
#[tauri::command(async)]
pub fn git_show_head(workspace: State<'_, WorkspaceState>, path: String) -> Result<Option<String>, String> {
    let path = ensure_in_workspace(&workspace, &path)?;
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(None);
    };
    // "HEAD:./name" resolves relative to the working directory, which saves
    // working out the path relative to the repository root.
    let spec = format!("HEAD:./{}", name.to_string_lossy());
    let output = git_command(dir).args(["show", &spec]).output().map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.contains(&0) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

fn workspace_root(workspace: &WorkspaceState) -> Result<PathBuf, String> {
    let root = workspace.root.read().map_err(|e| e.to_string())?;
    root.clone().ok_or_else(|| "No workspace is open".to_string())
}

fn scoped(workspace: &WorkspaceState, paths: &[String]) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let root = workspace_root(workspace)?;
    let paths = paths
        .iter()
        .map(|p| ensure_in_workspace(workspace, p))
        .collect::<Result<_, _>>()?;
    Ok((root, paths))
}

fn run_with_paths(root: &Path, args: &[&str], paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let output = git_command(root)
        .args(args)
        .arg("--")
        .args(paths)
        .output()
        .map_err(|e| e.to_string())?;
    check(output).map(|_| ())
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(dir).args(args).output().map_err(|e| e.to_string())?;
    check(output)
}

fn git_command(dir: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        // Never wait on a prompt nobody can see: fail with git's own message
        // instead (missing credentials, unknown host key, SSH passphrase).
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    command
}

fn check(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // `git commit` with nothing to commit explains itself on stdout.
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// Parses `git status --porcelain=v2 --branch -z`. Paths come relative to the
/// repository root and are returned absolute.
fn parse_status(raw: &str, toplevel: &Path) -> GitStatus {
    let mut status = GitStatus { is_repo: true, ..GitStatus::default() };
    let absolute = |rel: &str| toplevel.join(rel).to_string_lossy().into_owned();
    let mut records = raw.split('\0').filter(|r| !r.is_empty());

    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => status.head_oid = Some(value.into()),
                "branch.head" if value != "(detached)" => status.branch = Some(value.into()),
                "branch.upstream" => status.upstream = Some(value.into()),
                "branch.ab" => {
                    let mut counts = value.split(' ').map(|n| n.trim_start_matches(['+', '-']).parse().unwrap_or(0));
                    status.ahead = counts.next().unwrap_or(0);
                    status.behind = counts.next().unwrap_or(0);
                }
                _ => {}
            }
            continue;
        }

        let kind = record.as_bytes()[0];
        let change = match kind {
            // Ordinary: "1 XY sub mH mI mW hH hI path" (path may hold spaces).
            b'1' | b'u' => {
                let field_count = if kind == b'1' { 8 } else { 10 };
                let mut fields = record.splitn(field_count + 1, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(field_count - 2).unwrap_or("");
                change(absolute(path), None, xy, kind == b'u')
            }
            // Renamed/copied: 9 fields, then the original path as its own record.
            b'2' => {
                let mut fields = record.splitn(10, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(7).unwrap_or("");
                let orig = records.next().map(absolute);
                change(absolute(path), orig, xy, false)
            }
            b'?' => change(absolute(&record[2..]), None, "??", false),
            _ => continue,
        };
        status.changes.push(change);
    }
    status
}

fn change(path: String, orig_path: Option<String>, xy: &str, conflicted: bool) -> GitChange {
    let mut letters = xy.chars();
    GitChange {
        path,
        orig_path,
        index: letters.next().unwrap_or('.'),
        worktree: letters.next().unwrap_or('.'),
        conflicted,
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_status, GitChange};
    use std::path::Path;

    fn changed(path: &str, index: char, worktree: char) -> GitChange {
        GitChange { path: path.into(), orig_path: None, index, worktree, conflicted: false }
    }

    #[test]
    fn reads_branch_tracking_and_head() {
        let raw = "# branch.oid 1a2b3c\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        let status = parse_status(raw, Path::new("/repo"));

        assert!(status.is_repo);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.head_oid.as_deref(), Some("1a2b3c"));
    }

    #[test]
    fn a_fresh_repository_has_no_head_and_detached_has_no_branch() {
        let fresh = parse_status("# branch.oid (initial)\0# branch.head main\0", Path::new("/repo"));
        assert_eq!(fresh.head_oid, None);

        let detached = parse_status("# branch.oid abc\0# branch.head (detached)\0", Path::new("/repo"));
        assert_eq!(detached.branch, None);
    }

    #[test]
    fn reads_ordinary_untracked_and_paths_with_spaces() {
        let raw = "1 .M N... 100644 100644 100644 aaa bbb src/app.ts\0\
                   1 A. N... 000000 100644 100644 000 ccc docs/new file.md\0\
                   ? notes.txt\0";
        let status = parse_status(raw, Path::new("/repo"));

        assert_eq!(
            status.changes,
            vec![
                changed("/repo/src/app.ts", '.', 'M'),
                changed("/repo/docs/new file.md", 'A', '.'),
                changed("/repo/notes.txt", '?', '?'),
            ]
        );
    }

    #[test]
    fn reads_renames_with_their_original_path() {
        let raw = "2 R. N... 100644 100644 100644 aaa aaa R100 src/new.ts\0src/old.ts\0? after.txt\0";
        let status = parse_status(raw, Path::new("/repo"));

        assert_eq!(status.changes[0].path, "/repo/src/new.ts");
        assert_eq!(status.changes[0].orig_path.as_deref(), Some("/repo/src/old.ts"));
        assert_eq!(status.changes[0].index, 'R');
        assert_eq!(status.changes[1].path, "/repo/after.txt");
    }

    #[test]
    fn parses_what_real_git_prints() {
        let dir = std::env::temp_dir().join(format!("code-editor-git-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(super::git(&dir, args).is_ok(), "git {args:?} failed");
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("old name.txt"), "a").unwrap();
        std::fs::write(dir.join("kept.txt"), "k").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "init"]);
        run(&["mv", "old name.txt", "new name.txt"]);
        std::fs::write(dir.join("kept.txt"), "changed").unwrap();
        std::fs::write(dir.join("fresh.txt"), "u").unwrap();

        let raw = super::git(&dir, &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]).unwrap();
        let status = parse_status(&raw, &dir);
        let find = |name: &str| status.changes.iter().find(|c| c.path.ends_with(name)).expect(name);

        assert_eq!(status.branch.as_deref(), Some("main"));
        assert!(status.head_oid.is_some());
        let renamed = find("new name.txt");
        assert_eq!(renamed.index, 'R');
        assert!(renamed.orig_path.as_deref().unwrap().ends_with("old name.txt"));
        assert_eq!(find("kept.txt").worktree, 'M');
        assert_eq!(find("fresh.txt").index, '?');
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn flags_merge_conflicts() {
        let raw = "u UU N... 100644 100644 100644 100644 a b c src/merge.ts\0";
        let status = parse_status(raw, Path::new("/repo"));

        assert!(status.changes[0].conflicted);
        assert_eq!(status.changes[0].path, "/repo/src/merge.ts");
    }
}
