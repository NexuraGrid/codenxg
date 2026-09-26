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
    show_file(dir, &format!("HEAD:./{}", name.to_string_lossy()))
}

fn show_file(dir: &Path, spec: &str) -> Result<Option<String>, String> {
    let output = git_command(dir).args(["show", spec]).output().map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.contains(&0) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// Short name: "main", or "origin/main" for a remote branch.
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    /// Unix seconds.
    pub timestamp: i64,
    /// Branch and tag names pointing here ("HEAD -> main", "origin/main").
    pub refs: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub orig_path: Option<String>,
    /// A, M, D, R, C or T.
    pub status: char,
}

#[tauri::command(async)]
pub fn git_branches(workspace: State<'_, WorkspaceState>) -> Result<Vec<GitBranch>, String> {
    let root = workspace_root(&workspace)?;
    let raw = git(
        &root,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%00%(upstream:short)%00%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(parse_branches(&raw))
}

/// The result of trying to move to a branch: either we're on it, or git
/// refused and `blocked` says why (the working tree is untouched then).
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchOutcome {
    pub switched: bool,
    pub blocked: Option<SwitchBlock>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SwitchBlock {
    /// "local-changes", "untracked-files", "unresolved-conflicts" or "other".
    pub kind: &'static str,
    /// The files git named as the obstacle.
    pub files: Vec<String>,
    /// git's own message, for anything the UI doesn't explain itself.
    pub detail: String,
}

/// Switches to a branch. A remote one ("origin/feature") gets a local
/// tracking branch of the same name, as `git switch` does on its own.
#[tauri::command(async)]
pub fn git_checkout(workspace: State<'_, WorkspaceState>, name: String, is_remote: bool) -> Result<SwitchOutcome, String> {
    let root = workspace_root(&workspace)?;
    reject_option_like(&name)?;
    let local = if is_remote { name.split_once('/').map_or(name.as_str(), |(_, rest)| rest) } else { &name };
    Ok(try_switch(&root, local))
}

/// Creates `name` from `base` (the current commit when None) and, if asked,
/// moves onto it. The branch exists afterwards even when moving was refused.
#[tauri::command(async)]
pub fn git_create_branch(
    workspace: State<'_, WorkspaceState>,
    name: String,
    base: Option<String>,
    switch: bool,
) -> Result<SwitchOutcome, String> {
    let root = workspace_root(&workspace)?;
    reject_option_like(&name)?;
    git(&root, &["check-ref-format", "--branch", &name]).map_err(|_| format!("\"{name}\" is not a valid branch name"))?;
    if git(&root, &["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).is_ok() {
        return Err(format!("A branch named \"{name}\" already exists"));
    }

    // --no-track: a branch made from "origin/x" must not push back into x;
    // it gets its own upstream when first published.
    let mut args = vec!["branch", "--no-track", name.as_str()];
    if let Some(base) = base.as_deref() {
        reject_option_like(base)?;
        args.push(base);
    }
    git(&root, &args)?;

    if !switch {
        return Ok(SwitchOutcome { switched: false, blocked: None });
    }
    Ok(try_switch(&root, &name))
}

/// Puts every uncommitted change (untracked files too) in a stash, then
/// switches. The stash stays for the user to bring back with `git stash pop`.
#[tauri::command(async)]
pub fn git_stash_and_switch(workspace: State<'_, WorkspaceState>, name: String) -> Result<SwitchOutcome, String> {
    let root = workspace_root(&workspace)?;
    reject_option_like(&name)?;
    let message = format!("Before switching to {name}");
    git(&root, &["stash", "push", "--include-untracked", "-m", &message])?;
    Ok(try_switch(&root, &name))
}

fn try_switch(root: &Path, name: &str) -> SwitchOutcome {
    match git(root, &["switch", name]) {
        Ok(_) => SwitchOutcome { switched: true, blocked: None },
        Err(message) => SwitchOutcome { switched: false, blocked: Some(classify_switch_error(&message)) },
    }
}

/// Reads why `git switch` refused. git's messages are stable in the C locale,
/// which git_command forces.
fn classify_switch_error(message: &str) -> SwitchBlock {
    let kind = if message.contains("Your local changes to the following files would be overwritten") {
        "local-changes"
    } else if message.contains("untracked working tree files would be") {
        "untracked-files"
    } else if message.contains("resolve your current index first") || message.contains("needs merge") {
        "unresolved-conflicts"
    } else {
        "other"
    };
    // git lists files one per line, indented with a tab ("\tsrc/app.ts"), or
    // as "<file>: needs merge" for conflicts.
    let files = message
        .lines()
        .filter_map(|line| {
            line.strip_prefix('\t')
                .or_else(|| line.strip_suffix(": needs merge"))
                .map(|f| f.trim().to_string())
        })
        .filter(|f| !f.is_empty())
        .collect();
    SwitchBlock { kind, files, detail: message.trim().to_string() }
}

#[tauri::command(async)]
pub fn git_fetch(workspace: State<'_, WorkspaceState>) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["fetch", "--all", "--prune"]).map(|_| ())
}

#[tauri::command(async)]
pub fn git_log(workspace: State<'_, WorkspaceState>, skip: u32, limit: u32) -> Result<Vec<GitCommit>, String> {
    let root = workspace_root(&workspace)?;
    // No commits yet: an empty history, not an error.
    if git(&root, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(Vec::new());
    }
    let raw = git(
        &root,
        &[
            "log",
            "--format=%H%x00%h%x00%s%x00%an%x00%at%x00%D%x1e",
            &format!("--skip={skip}"),
            &format!("--max-count={}", limit.min(500)),
        ],
    )?;
    Ok(parse_log(&raw))
}

#[tauri::command(async)]
pub fn git_commit_files(workspace: State<'_, WorkspaceState>, hash: String) -> Result<Vec<GitCommitFile>, String> {
    let root = workspace_root(&workspace)?;
    reject_non_hash(&hash)?;
    let toplevel = git(&root, &["rev-parse", "--show-toplevel"])?;
    // --root: the first commit lists its files as added instead of nothing.
    let raw = git(&root, &["show", "--root", "--format=", "--name-status", "-z", "-M", &hash])?;
    Ok(parse_name_status(&raw, Path::new(toplevel.trim_end())))
}

/// A file as it was in `rev` (a commit hash, optionally with `^` for its
/// parent). None when it doesn't exist there or is binary.
#[tauri::command(async)]
pub fn git_show_at(workspace: State<'_, WorkspaceState>, rev: String, path: String) -> Result<Option<String>, String> {
    reject_non_hash(rev.trim_end_matches('^'))?;
    let path = ensure_in_workspace(&workspace, &path)?;
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(None);
    };
    show_file(dir, &format!("{rev}:./{}", name.to_string_lossy()))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStash {
    pub index: u32,
    /// The message after "On <branch>: " or "WIP on <branch>: ", without the prefix.
    pub message: String,
    /// None when the subject doesn't match git's usual "On/WIP on <branch>: " shape.
    pub branch: Option<String>,
    /// Unix seconds.
    pub timestamp: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashFileDiff {
    /// The file before stashing (the stash's base commit); None if it didn't exist there.
    pub before: Option<String>,
    /// The file as stashed; None if it doesn't exist (deleted, or unreadable binary).
    pub after: Option<String>,
}

#[tauri::command(async)]
pub fn git_stash_list(workspace: State<'_, WorkspaceState>) -> Result<Vec<GitStash>, String> {
    let root = workspace_root(&workspace)?;
    // No stash ref yet: an empty list, not an error.
    if git(&root, &["rev-parse", "--verify", "-q", "refs/stash"]).is_err() {
        return Ok(Vec::new());
    }
    let raw = git(&root, &["stash", "list", "--format=%gd%x00%s%x00%at%x1e"])?;
    Ok(parse_stash_list(&raw))
}

/// Puts uncommitted changes aside as a new stash; the working tree goes back
/// to HEAD (or to what's still unstashed) once this returns.
#[tauri::command(async)]
pub fn git_stash_push(
    workspace: State<'_, WorkspaceState>,
    message: Option<String>,
    include_untracked: bool,
) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(message) = message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        args.push("-m");
        args.push(message);
    }
    git(&root, &args).map(|_| ())
}

/// Re-applies a stash's changes to the working tree; the stash itself stays.
/// A conflicting file gets git's usual conflict markers instead of failing outright.
#[tauri::command(async)]
pub fn git_stash_apply(workspace: State<'_, WorkspaceState>, index: u32) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["stash", "apply", &stash_ref(index)]).map(|_| ())
}

/// Applies a stash and drops it if that succeeded cleanly.
#[tauri::command(async)]
pub fn git_stash_pop(workspace: State<'_, WorkspaceState>, index: u32) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["stash", "pop", &stash_ref(index)]).map(|_| ())
}

#[tauri::command(async)]
pub fn git_stash_drop(workspace: State<'_, WorkspaceState>, index: u32) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    git(&root, &["stash", "drop", &stash_ref(index)]).map(|_| ())
}

/// The files a stash touches, tracked and (when the git version supports it) untracked.
#[tauri::command(async)]
pub fn git_stash_files(workspace: State<'_, WorkspaceState>, index: u32) -> Result<Vec<GitCommitFile>, String> {
    let root = workspace_root(&workspace)?;
    let toplevel = git(&root, &["rev-parse", "--show-toplevel"])?;
    let raw = stash_name_status(&root, &stash_ref(index))?;
    Ok(parse_name_status(&raw, Path::new(toplevel.trim_end())))
}

/// One file's content before and after a stash, for a read-only diff.
/// `orig_path` is the pre-rename path when the entry is a rename.
#[tauri::command(async)]
pub fn git_stash_file_diff(
    workspace: State<'_, WorkspaceState>,
    index: u32,
    path: String,
    orig_path: Option<String>,
) -> Result<StashFileDiff, String> {
    let path = ensure_in_workspace(&workspace, &path)?;
    let orig_path = orig_path.map(|p| ensure_in_workspace(&workspace, &p)).transpose()?;
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Ok(StashFileDiff { before: None, after: None });
    };
    let before_path = orig_path.as_deref().unwrap_or(&path);
    let (Some(before_dir), Some(before_name)) = (before_path.parent(), before_path.file_name()) else {
        return Ok(StashFileDiff { before: None, after: None });
    };
    stash_file_diff(
        &stash_ref(index),
        dir,
        &name.to_string_lossy(),
        before_dir,
        &before_name.to_string_lossy(),
    )
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

/// `git stash show --name-status`, adding untracked files when the installed
/// git understands `--include-untracked` (added in git 2.31); older ones
/// just get the tracked changes instead of failing.
fn stash_name_status(root: &Path, stash: &str) -> Result<String, String> {
    let with_untracked = git_command(root)
        .args(["stash", "show", "--include-untracked", "--name-status", "-z", stash])
        .output()
        .map_err(|e| e.to_string())?;
    if with_untracked.status.success() {
        return Ok(String::from_utf8_lossy(&with_untracked.stdout).into_owned());
    }
    git(root, &["stash", "show", "--name-status", "-z", stash])
}

/// `before` comes from the stash's base commit (`stash@{n}^1`); `after` from
/// the stash itself, falling back to its untracked-files tree (`^3`) for a
/// file that was only ever untracked.
fn stash_file_diff(
    stash: &str,
    dir: &Path,
    name: &str,
    before_dir: &Path,
    before_name: &str,
) -> Result<StashFileDiff, String> {
    let before = show_file(before_dir, &format!("{stash}^1:./{before_name}"))?;
    let mut after = show_file(dir, &format!("{stash}:./{name}"))?;
    if after.is_none() {
        after = show_file(dir, &format!("{stash}^3:./{name}"))?;
    }
    Ok(StashFileDiff { before, after })
}

/// `git stash list --format=%gd%x00%s%x00%at%x1e`.
fn parse_stash_list(raw: &str) -> Vec<GitStash> {
    raw.split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split('\0');
            let gd = fields.next()?;
            let subject = fields.next()?;
            let timestamp = fields.next()?.parse().ok()?;
            let index = gd.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            let (branch, message) = parse_stash_subject(subject);
            Some(GitStash { index, message, branch, timestamp })
        })
        .collect()
}

/// Splits git's stash subject: the default "WIP on main: 1a2b3c subject", or
/// "On main: my message" when `git stash push -m` gave it one.
fn parse_stash_subject(subject: &str) -> (Option<String>, String) {
    for prefix in ["WIP on ", "On "] {
        if let Some(rest) = subject.strip_prefix(prefix) {
            if let Some((branch, message)) = rest.split_once(": ") {
                return (Some(branch.to_string()), message.to_string());
            }
        }
    }
    (None, subject.to_string())
}

// Branch names and hashes come from the UI and end up as git arguments:
// never let one be read as an option.
fn reject_option_like(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') {
        return Err(format!("\"{name}\" is not a valid branch name"));
    }
    Ok(())
}

fn reject_non_hash(hash: &str) -> Result<(), String> {
    if hash.len() >= 4 && hash.len() <= 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("\"{hash}\" is not a commit hash"))
    }
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
        // English messages whatever the system language: classify_switch_error
        // and friends read them.
        .env("LC_ALL", "C")
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

fn parse_branches(raw: &str) -> Vec<GitBranch> {
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let refname = fields.next()?;
            let upstream = fields.next().filter(|u| !u.is_empty()).map(String::from);
            let is_current = fields.next() == Some("*");
            let (name, is_remote) = if let Some(local) = refname.strip_prefix("refs/heads/") {
                (local, false)
            } else {
                (refname.strip_prefix("refs/remotes/")?, true)
            };
            // "origin/HEAD" is an alias for the remote's default branch.
            if is_remote && name.ends_with("/HEAD") {
                return None;
            }
            Some(GitBranch { name: name.into(), is_remote, is_current, upstream })
        })
        .collect()
}

fn parse_log(raw: &str) -> Vec<GitCommit> {
    raw.split('\x1e')
        .filter_map(|record| {
            let mut fields = record.trim_start_matches('\n').split('\0');
            Some(GitCommit {
                hash: fields.next().filter(|h| !h.is_empty())?.into(),
                short_hash: fields.next()?.into(),
                subject: fields.next()?.into(),
                author: fields.next()?.into(),
                timestamp: fields.next()?.parse().ok()?,
                refs: fields
                    .next()
                    .unwrap_or("")
                    .split(", ")
                    .filter(|r| !r.is_empty())
                    .map(String::from)
                    .collect(),
            })
        })
        .collect()
}

/// `--name-status -z`: "M\0path\0", renames/copies "R100\0old\0new\0".
fn parse_name_status(raw: &str, toplevel: &Path) -> Vec<GitCommitFile> {
    let absolute = |rel: &str| toplevel.join(rel).to_string_lossy().into_owned();
    let mut fields = raw.trim_start_matches('\n').split('\0').filter(|f| !f.is_empty());
    let mut files = Vec::new();
    while let Some(code) = fields.next() {
        let status = code.chars().next().unwrap_or('M');
        let Some(first) = fields.next() else { break };
        let file = if status == 'R' || status == 'C' {
            let Some(new) = fields.next() else { break };
            GitCommitFile { path: absolute(new), orig_path: Some(absolute(first)), status }
        } else {
            GitCommitFile { path: absolute(first), orig_path: None, status }
        };
        files.push(file);
    }
    files
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
    use super::{
        classify_switch_error, parse_branches, parse_log, parse_name_status, parse_stash_list, parse_stash_subject,
        parse_status, stash_file_diff, stash_name_status, stash_ref, try_switch, GitChange,
    };
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

        let log = parse_log(&super::git(&dir, &["log", "--format=%H%x00%h%x00%s%x00%an%x00%at%x00%D%x1e"]).unwrap());
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].subject, "init");
        assert!(log[0].refs.iter().any(|r| r.contains("main")));

        let files = parse_name_status(
            &super::git(&dir, &["show", "--root", "--format=", "--name-status", "-z", "-M", &log[0].hash]).unwrap(),
            &dir,
        );
        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|f| f.status == 'A'));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_local_and_remote_branches_without_the_remote_head_alias() {
        let raw = "refs/heads/main\0origin/main\0*\n\
                   refs/heads/feature/x\0\0 \n\
                   refs/remotes/origin/HEAD\0\0 \n\
                   refs/remotes/origin/main\0\0 \n";
        let branches = parse_branches(raw);

        assert_eq!(branches.len(), 3);
        assert!(branches[0].is_current && !branches[0].is_remote);
        assert_eq!(branches[0].upstream.as_deref(), Some("origin/main"));
        assert_eq!(branches[1].name, "feature/x");
        assert!(branches[2].is_remote && branches[2].name == "origin/main");
    }

    #[test]
    fn reads_log_records_with_refs() {
        let raw = "aaa111\0aaa\0feat: x, y\0Ana\01700000000\0HEAD -> main, origin/main\x1e\n\
                   bbb222\0bbb\0first\0Ana\01690000000\0\x1e\n";
        let log = parse_log(raw);

        assert_eq!(log.len(), 2);
        assert_eq!(log[0].subject, "feat: x, y");
        assert_eq!(log[0].refs, vec!["HEAD -> main", "origin/main"]);
        assert_eq!(log[1].timestamp, 1690000000);
        assert!(log[1].refs.is_empty());
    }

    #[test]
    fn reads_commit_files_including_renames() {
        let raw = "\nM\0src/a.ts\0R090\0old name.ts\0new name.ts\0A\0b.ts\0";
        let files = parse_name_status(raw, Path::new("/repo"));

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].path, "/repo/src/a.ts");
        assert_eq!(files[1].status, 'R');
        assert_eq!(files[1].orig_path.as_deref(), Some("/repo/old name.ts"));
        assert_eq!(files[1].path, "/repo/new name.ts");
        assert_eq!(files[2].status, 'A');
    }

    #[test]
    fn explains_why_a_switch_was_refused() {
        let changes = classify_switch_error(
            "error: Your local changes to the following files would be overwritten by checkout:\n\
             \tsrc/app.ts\n\tREADME.md\n\
             Please commit your changes or stash them before you switch branches.\nAborting",
        );
        assert_eq!(changes.kind, "local-changes");
        assert_eq!(changes.files, vec!["src/app.ts", "README.md"]);

        let untracked = classify_switch_error(
            "error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.txt\nAborting",
        );
        assert_eq!(untracked.kind, "untracked-files");
        assert_eq!(untracked.files, vec!["notes.txt"]);

        let conflicts = classify_switch_error("src/a.ts: needs merge\nerror: you need to resolve your current index first");
        assert_eq!(conflicts.kind, "unresolved-conflicts");
        assert_eq!(conflicts.files, vec!["src/a.ts"]);

        assert_eq!(classify_switch_error("fatal: something else").kind, "other");
    }

    #[test]
    fn a_real_switch_blocked_by_local_changes_is_explained() {
        let dir = std::env::temp_dir().join(format!("code-editor-switch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(super::git(&dir, args).is_ok(), "git {args:?} failed");
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("app.ts"), "v1").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "one"]);
        run(&["switch", "-q", "-c", "other"]);
        std::fs::write(dir.join("app.ts"), "v2").unwrap();
        run(&["commit", "-q", "-am", "two"]);
        run(&["switch", "-q", "main"]);
        std::fs::write(dir.join("app.ts"), "my unsaved work").unwrap();

        let outcome = try_switch(&dir, "other");
        assert!(!outcome.switched);
        let block = outcome.blocked.unwrap();
        assert_eq!(block.kind, "local-changes");
        assert_eq!(block.files, vec!["app.ts"]);

        // Stashing clears the way, and the work is kept in the stash.
        run(&["stash", "push", "--include-untracked", "-m", "t"]);
        assert!(try_switch(&dir, "other").switched);
        assert!(super::git(&dir, &["stash", "list"]).unwrap().contains("t"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn flags_merge_conflicts() {
        let raw = "u UU N... 100644 100644 100644 100644 a b c src/merge.ts\0";
        let status = parse_status(raw, Path::new("/repo"));

        assert!(status.changes[0].conflicted);
        assert_eq!(status.changes[0].path, "/repo/src/merge.ts");
    }

    #[test]
    fn formats_the_stash_ref() {
        assert_eq!(stash_ref(0), "stash@{0}");
        assert_eq!(stash_ref(3), "stash@{3}");
    }

    #[test]
    fn splits_a_custom_stash_message_from_its_branch() {
        let (branch, message) = parse_stash_subject("On feature/x: fix the thing");
        assert_eq!(branch.as_deref(), Some("feature/x"));
        assert_eq!(message, "fix the thing");
    }

    #[test]
    fn splits_the_default_wip_message_from_its_branch() {
        let (branch, message) = parse_stash_subject("WIP on main: 1a2b3c4 previous subject");
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(message, "1a2b3c4 previous subject");
    }

    #[test]
    fn falls_back_when_the_subject_has_no_recognizable_prefix() {
        let (branch, message) = parse_stash_subject("something odd");
        assert_eq!(branch, None);
        assert_eq!(message, "something odd");
    }

    #[test]
    fn parses_a_stash_list_with_two_entries() {
        let raw = "stash@{0}\0On main: wip feature\01700000000\x1e\n\
                   stash@{1}\0WIP on main: 1a2b3c4 older commit\01690000000\x1e\n";
        let stashes = parse_stash_list(raw);

        assert_eq!(stashes.len(), 2);
        assert_eq!(stashes[0].index, 0);
        assert_eq!(stashes[0].branch.as_deref(), Some("main"));
        assert_eq!(stashes[0].message, "wip feature");
        assert_eq!(stashes[0].timestamp, 1700000000);
        assert_eq!(stashes[1].index, 1);
        assert_eq!(stashes[1].message, "1a2b3c4 older commit");
    }

    #[test]
    fn skips_a_stash_list_record_missing_its_timestamp() {
        let raw = "stash@{0}\0On main: wip feature\x1e\nstash@{1}\0On main: ok\01690000000\x1e\n";
        let stashes = parse_stash_list(raw);

        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 1);
    }

    #[test]
    fn stashes_created_by_real_git_round_trip() {
        let dir = std::env::temp_dir().join(format!("code-editor-stash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| assert!(super::git(&dir, args).is_ok(), "git {args:?} failed");
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("tracked.txt"), "old").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-q", "-m", "init"]);

        std::fs::write(dir.join("tracked.txt"), "new").unwrap();
        std::fs::write(dir.join("fresh.txt"), "untracked").unwrap();
        run(&["stash", "push", "-u", "-m", "my message"]);

        let list = parse_stash_list(&super::git(&dir, &["stash", "list", "--format=%gd%x00%s%x00%at%x1e"]).unwrap());
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].message, "my message");

        let raw = stash_name_status(&dir, "stash@{0}").unwrap();
        let files = parse_name_status(&raw, &dir);
        let names: Vec<_> = files.iter().map(|f| f.path.clone()).collect();
        assert!(names.iter().any(|p| p.ends_with("tracked.txt")));
        assert!(names.iter().any(|p| p.ends_with("fresh.txt")));

        let tracked_diff = stash_file_diff("stash@{0}", &dir, "tracked.txt", &dir, "tracked.txt").unwrap();
        assert_eq!(tracked_diff.before.as_deref(), Some("old"));
        assert_eq!(tracked_diff.after.as_deref(), Some("new"));

        let untracked_diff = stash_file_diff("stash@{0}", &dir, "fresh.txt", &dir, "fresh.txt").unwrap();
        assert_eq!(untracked_diff.before, None);
        assert_eq!(untracked_diff.after.as_deref(), Some("untracked"));

        // Working tree is back to HEAD until the stash is brought back.
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "old");
        assert!(!dir.join("fresh.txt").exists());

        run(&["stash", "pop", "-q"]);
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "new");
        assert!(dir.join("fresh.txt").exists());
        assert!(super::git(&dir, &["stash", "list"]).unwrap().trim().is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
