use super::workspace::{ensure_below_workspace, ensure_in_workspace};
use crate::state::WorkspaceState;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

// Minimal noise filter so the tree doesn't choke on node_modules/.git/target.
// A full .gitignore-aware filter belongs to the file-watcher phase, not here.
const SKIP_ENTRIES: [&str; 3] = [".git", "node_modules", "target"];

// `async` keeps these off the main thread: reads under /mnt/c go through
// WSL's 9P bridge and are slow enough to freeze the window otherwise.
#[tauri::command(async)]
pub fn read_dir(state: State<'_, WorkspaceState>, path: String) -> Result<Vec<FileEntry>, String> {
    let path = ensure_in_workspace(&state, &path)?;
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    // One unreadable entry (permissions, a racing delete) must not hide the
    // rest of the folder.
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();

        if SKIP_ENTRIES.contains(&name.as_str()) {
            continue;
        }

        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        result.push(FileEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
        });
    }

    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
}

#[tauri::command(async)]
pub fn read_file(state: State<'_, WorkspaceState>, path: String) -> Result<String, String> {
    let path = ensure_in_workspace(&state, &path)?;
    read_text(&path, MAX_OPEN_BYTES)
}

// Monaco keeps the whole text (plus tokens) in memory and freezes on huge
// files; a multi-GB log would also stall the IPC bridge. Also the cap search
// uses to skip huge files, so a match can always be opened afterwards.
pub(crate) const MAX_OPEN_BYTES: u64 = 16 * 1024 * 1024;

fn read_text(path: &Path, max_bytes: u64) -> Result<String, String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size > max_bytes {
        return Err(format!(
            "the file is {:.1} MB; files over {} MB are not opened",
            size as f64 / 1_048_576.0,
            max_bytes / 1_048_576
        ));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_file(
    state: State<'_, WorkspaceState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let path = ensure_in_workspace(&state, &path)?;
    write_atomic(&path, content.as_bytes()).map_err(|e| e.to_string())
}

/// Writes to a temp file next to `path` and renames it over the target, so a
/// crash mid-save leaves either the old file or the new one, never half of it.
/// No fsync: on /mnt/c it goes through WSL's 9P bridge and made Ctrl+S lag;
/// the rename alone already protects against the app crashing mid-write.
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    // Write through a symlink instead of replacing the link with a plain file.
    let target = match std::fs::canonicalize(path) {
        Ok(real) => real,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => path.to_path_buf(),
        Err(e) => return Err(e),
    };
    let parent = target
        .parent()
        .ok_or_else(|| std::io::Error::other("Invalid path"))?;
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::other("Invalid path"))?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));

    let result = (|| {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(content)?;
        // Keep the original mode so saving a script doesn't drop its +x bit.
        if let Ok(metadata) = std::fs::metadata(&target) {
            std::fs::set_permissions(&temp, metadata.permissions())?;
        }
        std::fs::rename(&temp, &target)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Creates an empty file or a folder named `name` inside `parent` and returns
/// its full path. Never overwrites: an existing entry is an error.
#[tauri::command(async)]
pub fn create_entry(
    state: State<'_, WorkspaceState>,
    parent: String,
    name: String,
    is_dir: bool,
) -> Result<String, String> {
    let parent = ensure_in_workspace(&state, &parent)?;
    create(&parent, &name, is_dir)
}

fn create(parent: &Path, name: &str, is_dir: bool) -> Result<String, String> {
    let name = validate_entry_name(name)?;
    let path = parent.join(name);

    let created = if is_dir {
        std::fs::create_dir(&path)
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(|_| ())
    };

    created.map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => format!("\"{name}\" already exists here"),
        _ => e.to_string(),
    })?;

    Ok(path.to_string_lossy().to_string())
}

/// Renames a file or folder in place (same parent) and returns its new path.
/// Refuses to replace a different existing entry.
#[tauri::command(async)]
pub fn rename_entry(
    state: State<'_, WorkspaceState>,
    path: String,
    new_name: String,
) -> Result<String, String> {
    let source = ensure_below_workspace(&state, &path)?;
    rename(&source, &new_name)
}

fn rename(source: &Path, new_name: &str) -> Result<String, String> {
    let new_name = validate_entry_name(new_name)?;
    let parent = source
        .parent()
        .ok_or_else(|| "Can't rename the filesystem root".to_string())?;
    let target = parent.join(new_name);

    if target == source {
        return Ok(source.to_string_lossy().to_string());
    }
    // On a case-insensitive disk (NTFS under /mnt/c) "app.ts" -> "App.ts"
    // resolves to the entry being renamed, which is fine. Anything else that
    // already exists would be overwritten by fs::rename.
    if std::fs::symlink_metadata(&target).is_ok() && !is_same_entry(source, &target) {
        return Err(format!("\"{new_name}\" already exists here"));
    }

    std::fs::rename(source, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Moves a file or folder into `target_dir` (drag and drop in the explorer)
/// and returns its new path. Never overwrites and never moves a folder into
/// itself or one of its own subfolders.
#[tauri::command(async)]
pub fn move_entry(
    state: State<'_, WorkspaceState>,
    path: String,
    target_dir: String,
) -> Result<String, String> {
    let source = ensure_below_workspace(&state, &path)?;
    let target_dir = ensure_in_workspace(&state, &target_dir)?;
    move_into(&source, &target_dir)
}

fn move_into(source: &Path, target_dir: &Path) -> Result<String, String> {
    ensure_deletable(source)?;
    let name = source
        .file_name()
        .ok_or_else(|| "Invalid path".to_string())?
        .to_owned();

    // Path::starts_with compares whole components: "src" never matches "src-tauri".
    if target_dir.starts_with(source) {
        return Err("Can't move a folder into itself".into());
    }
    if !target_dir.is_dir() {
        return Err("The destination is not a folder".into());
    }

    let target = target_dir.join(&name);
    if target == source {
        return Ok(source.to_string_lossy().to_string());
    }
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(format!(
            "\"{}\" already exists in the destination",
            name.to_string_lossy()
        ));
    }

    std::fs::rename(source, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Moves a file or folder to the system trash (recoverable), as VS Code does.
#[tauri::command(async)]
pub fn trash_entry(state: State<'_, WorkspaceState>, path: String) -> Result<(), String> {
    let path = ensure_below_workspace(&state, &path)?;
    ensure_deletable(&path)?;
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Permanent delete: only offered after moving to the trash failed.
#[tauri::command(async)]
pub fn delete_entry(state: State<'_, WorkspaceState>, path: String) -> Result<(), String> {
    let path = ensure_below_workspace(&state, &path)?;
    let target = path.as_path();
    ensure_deletable(target)?;
    // symlink_metadata: a symlink to a folder is removed as a link, never
    // followed into the folder it points at.
    let metadata = std::fs::symlink_metadata(target).map_err(|e| e.to_string())?;
    let removed = if metadata.is_dir() {
        std::fs::remove_dir_all(target)
    } else {
        std::fs::remove_file(target)
    };
    removed.map_err(|e| e.to_string())
}

fn ensure_deletable(path: &Path) -> Result<(), String> {
    if path.parent().is_none() || path.as_os_str().is_empty() {
        return Err("Refusing to delete a filesystem root".into());
    }
    Ok(())
}

#[cfg(unix)]
fn is_same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(a), std::fs::symlink_metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_same_entry(a: &Path, b: &Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

fn validate_entry_name(raw: &str) -> Result<&str, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("A name is required".into());
    }
    if name == "." || name == ".." {
        return Err(format!("\"{name}\" is not a valid name"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("Names can't contain / or \\".into());
    }
    Ok(name)
}

// Folders that are almost never opened by hand but can hold hundreds of
// thousands of files; walking them would make Ctrl+E crawl on /mnt/c.
const SKIP_WHEN_LISTING: [&str; 14] = [
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".ruff_cache",
    ".mypy_cache",
    ".pytest_cache",
    "vendor",
    ".codegraph",
    ".idea",
];
const MAX_LISTED_FILES: usize = 20_000;

#[derive(Serialize)]
pub struct FileList {
    pub files: Vec<String>,
    pub truncated: bool,
}

/// Every file under `root` for quick open: honours .gitignore (also outside
/// git repos) and skips heavy generated folders. Walks folders in parallel,
/// which matters on /mnt/c where every read crosses WSL's 9P bridge.
#[tauri::command(async)]
pub fn list_files(state: State<'_, WorkspaceState>, root: String) -> Result<FileList, String> {
    let root = ensure_in_workspace(&state, &root)?;
    Ok(walk_files(&root, MAX_LISTED_FILES))
}

/// A `.gitignore`-aware walker over `root` that also skips the noisy/heavy
/// folders above. Shared with search, so both features see the same files.
pub(crate) fn workspace_walk_builder(root: &Path) -> ignore::WalkBuilder {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(false) // .env, .github: VS Code's quick open shows dotfiles too
        .require_git(false)
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            !(SKIP_ENTRIES.contains(&name.as_ref()) || SKIP_WHEN_LISTING.contains(&name.as_ref()))
        });
    builder
}

fn walk_files(root: &Path, max: usize) -> FileList {
    use ignore::WalkState;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    let files = Mutex::new(Vec::new());
    let truncated = AtomicBool::new(false);

    workspace_walk_builder(root).build_parallel().run(|| {
        Box::new(|entry| {
            // Unreadable entries (permissions, broken links) are skipped, not fatal.
            let Ok(entry) = entry else {
                return WalkState::Continue;
            };
            if !entry
                .file_type()
                .is_some_and(|t| t.is_file() || t.is_symlink())
            {
                return WalkState::Continue;
            }
            let mut files = files.lock().unwrap();
            if files.len() >= max {
                truncated.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            files.push(entry.path().to_string_lossy().into_owned());
            WalkState::Continue
        })
    });

    let mut files = files.into_inner().unwrap();
    // Threads finish in any order; keep the list stable between opens.
    files.sort_unstable();
    FileList {
        files,
        truncated: truncated.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use super::{move_into, read_text, rename, validate_entry_name, walk_files, write_atomic};
    use std::path::PathBuf;

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("code-editor-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rename_moves_the_entry_and_returns_the_new_path() {
        let dir = scratch_dir("rename");
        let old = dir.join("old.txt");
        std::fs::write(&old, "hi").unwrap();

        let new_path = rename(&old, "new.go").unwrap();

        assert_eq!(PathBuf::from(&new_path), dir.join("new.go"));
        assert!(!old.exists());
        assert_eq!(std::fs::read_to_string(&new_path).unwrap(), "hi");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn move_puts_the_entry_inside_the_target_folder() {
        let dir = scratch_dir("move");
        let file = dir.join("a.txt");
        let folder = dir.join("lib");
        std::fs::write(&file, "a").unwrap();
        std::fs::create_dir(&folder).unwrap();

        let moved = move_into(&file, &folder).unwrap();

        assert_eq!(PathBuf::from(&moved), folder.join("a.txt"));
        assert!(!file.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn move_refuses_a_folder_into_its_own_subfolder() {
        let dir = scratch_dir("move-into-self");
        let parent = dir.join("src");
        let child = parent.join("lib");
        std::fs::create_dir_all(&child).unwrap();

        assert!(move_into(&parent, &child).is_err());
        assert!(move_into(&parent, &parent).is_err());
        assert!(child.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn move_never_overwrites_in_the_destination() {
        let dir = scratch_dir("move-clash");
        let file = dir.join("a.txt");
        let folder = dir.join("lib");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(&file, "outer").unwrap();
        std::fs::write(folder.join("a.txt"), "inner").unwrap();

        assert!(move_into(&file, &folder).is_err());
        assert_eq!(
            std::fs::read_to_string(folder.join("a.txt")).unwrap(),
            "inner"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rename_never_overwrites_another_entry() {
        let dir = scratch_dir("rename-clash");
        let a = dir.join("a.txt");
        let b = dir.join("b.txt");
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();

        assert!(rename(&a, "b.txt").is_err());
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "b");
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn entries_in(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let dir = scratch_dir("atomic-overwrite");
        let file = dir.join("main.go");
        std::fs::write(&file, "old content that is longer").unwrap();

        write_atomic(&file, b"new").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");
        assert_eq!(entries_in(&dir), vec!["main.go"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn atomic_write_creates_a_missing_file() {
        let dir = scratch_dir("atomic-create");
        let file = dir.join("new.txt");

        write_atomic(&file, b"hi").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hi");
        assert_eq!(entries_in(&dir), vec!["new.txt"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch_dir("atomic-mode");
        let script = dir.join("run.sh");
        std::fs::write(&script, "echo old").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        write_atomic(&script, b"echo new").unwrap();

        let mode = std::fs::metadata(&script).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_through_a_symlink_keeps_the_link() {
        let dir = scratch_dir("atomic-link");
        let real = dir.join("real.txt");
        let link = dir.join("link.txt");
        std::fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_atomic(&link, b"new").unwrap();

        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(&real).unwrap(), "new");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_files_over_the_size_limit() {
        let dir = scratch_dir("size-limit");
        let file = dir.join("big.log");
        std::fs::write(&file, vec![b'x'; 2048]).unwrap();

        assert!(read_text(&file, 1024).unwrap_err().contains("not opened"));
        assert_eq!(read_text(&file, 4096).unwrap().len(), 2048);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn listing_honours_gitignore_and_skips_heavy_folders() {
        let dir = scratch_dir("listing");
        std::fs::write(dir.join(".gitignore"), "*.secret\ngenerated/\n").unwrap();
        std::fs::write(dir.join("keep.ts"), "").unwrap();
        std::fs::write(dir.join("key.secret"), "").unwrap();
        std::fs::write(dir.join(".env"), "").unwrap();
        for folder in ["generated", "node_modules", "src"] {
            std::fs::create_dir(dir.join(folder)).unwrap();
            std::fs::write(dir.join(folder).join("a.ts"), "").unwrap();
        }

        let names: Vec<String> = walk_files(&dir, 100)
            .files
            .iter()
            .map(|f| f.strip_prefix(&*dir.to_string_lossy()).unwrap().to_string())
            .collect();

        assert_eq!(names, vec!["/.env", "/.gitignore", "/keep.ts", "/src/a.ts"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn listing_stops_at_the_limit() {
        let dir = scratch_dir("listing-limit");
        for i in 0..5 {
            std::fs::write(dir.join(format!("{i}.txt")), "").unwrap();
        }

        let list = walk_files(&dir, 3);
        assert_eq!(list.files.len(), 3);
        assert!(list.truncated);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_and_trims_plain_names() {
        assert_eq!(validate_entry_name("  main.go "), Ok("main.go"));
        assert_eq!(validate_entry_name(".env"), Ok(".env"));
    }

    #[test]
    fn rejects_empty_dot_and_path_names() {
        for bad in ["", "   ", ".", "..", "a/b", "a\\b"] {
            assert!(
                validate_entry_name(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }
}
