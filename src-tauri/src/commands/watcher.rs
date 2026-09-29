use super::workspace::ensure_in_workspace;
use crate::state::WorkspaceState;
use notify::{Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;

// Bursts (git checkout, a formatter over many files) arrive as one batch.
const DEBOUNCE: Duration = Duration::from_millis(150);
// Only for folders where the kernel can't notify us (see needs_polling).
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Watches only the folders the UI shows (expanded in the tree, or holding an
/// open file), one level deep — never the whole project or node_modules.
#[derive(Default)]
pub struct WatcherState {
    inner: Mutex<Option<ActiveWatcher>>,
}

struct ActiveWatcher {
    watcher: Box<dyn Watcher + Send>,
    watched: HashSet<PathBuf>,
}

/// (Re)starts watching for the open workspace. Changed paths are sent to
/// `on_change` in debounced batches. Starts with nothing watched.
#[tauri::command(async)]
pub fn watch_start(
    state: State<'_, WatcherState>,
    workspace: State<'_, WorkspaceState>,
    on_change: Channel<Vec<String>>,
) -> Result<(), String> {
    let root = workspace_root(&workspace)?;
    let (tx, rx) = mpsc::channel::<PathBuf>();

    let handler = move |result: notify::Result<Event>| {
        if let Ok(event) = result {
            if is_relevant(&event.kind) {
                for path in event.paths {
                    let _ = tx.send(path);
                }
            }
        }
    };

    let watcher: Box<dyn Watcher + Send> = if needs_polling(&root, &read_mounts()) {
        let config = Config::default().with_poll_interval(POLL_INTERVAL);
        Box::new(PollWatcher::new(handler, config).map_err(|e| e.to_string())?)
    } else {
        Box::new(RecommendedWatcher::new(handler, Config::default()).map_err(|e| e.to_string())?)
    };

    // Replacing the old watcher drops its sender, which ends its batch thread.
    *state.inner.lock().map_err(|e| e.to_string())? = Some(ActiveWatcher {
        watcher,
        watched: HashSet::new(),
    });
    std::thread::spawn(move || forward_batches(rx, on_change));
    Ok(())
}

/// Makes `dirs` the exact set of watched folders.
#[tauri::command(async)]
pub fn watch_dirs(
    state: State<'_, WatcherState>,
    workspace: State<'_, WorkspaceState>,
    dirs: Vec<String>,
) -> Result<(), String> {
    let wanted: HashSet<PathBuf> = dirs
        .iter()
        .filter_map(|dir| ensure_in_workspace(&workspace, dir).ok())
        .collect();

    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let Some(active) = guard.as_mut() else {
        return Err("The file watcher is not running".into());
    };

    for dir in active
        .watched
        .difference(&wanted)
        .cloned()
        .collect::<Vec<_>>()
    {
        let _ = active.watcher.unwatch(&dir);
        active.watched.remove(&dir);
    }
    for dir in wanted
        .difference(&active.watched)
        .cloned()
        .collect::<Vec<_>>()
    {
        // A folder deleted a moment ago can't be watched; the UI drops it soon.
        if active
            .watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .is_ok()
        {
            active.watched.insert(dir);
        }
    }
    Ok(())
}

fn workspace_root(workspace: &WorkspaceState) -> Result<PathBuf, String> {
    let root = workspace.root.read().map_err(|e| e.to_string())?;
    root.clone()
        .ok_or_else(|| "No workspace is open".to_string())
}

fn forward_batches(rx: Receiver<PathBuf>, on_change: Channel<Vec<String>>) {
    // recv() fails once the watcher (and its sender) is dropped.
    while let Ok(first) = rx.recv() {
        let mut batch = HashSet::from([first]);
        let deadline = Instant::now() + DEBOUNCE;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(path) => {
                    batch.insert(path);
                }
                Err(_) => break,
            }
        }
        let paths = batch
            .into_iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        if on_change.send(paths).is_err() {
            return;
        }
    }
}

// Reads (Access) are dropped: otherwise the editor re-reading a changed file
// would report it as changed again. The poll watcher reports content edits as
// a write-time metadata change, so Modify is kept whole.
fn is_relevant(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
    )
}

fn read_mounts() -> String {
    std::fs::read_to_string("/proc/self/mounts").unwrap_or_default()
}

// inotify never fires on WSL's Windows drives (9P) or network filesystems, not
// even for changes made from Linux, so those folders are polled instead.
const POLLED_FILESYSTEMS: [&str; 7] = ["9p", "v9fs", "drvfs", "nfs", "nfs4", "cifs", "smb3"];

/// True when `path` lives on a filesystem without change notifications,
/// judged by the most specific mount point containing it.
fn needs_polling(path: &Path, mounts: &str) -> bool {
    mounts
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let mount_point = unescape_mount(fields.nth(1)?);
            let fs_type = fields.next()?;
            path.starts_with(&mount_point)
                .then_some((mount_point, fs_type))
        })
        .max_by_key(|(mount_point, _)| mount_point.components().count())
        .is_some_and(|(_, fs_type)| POLLED_FILESYSTEMS.contains(&fs_type))
}

// /proc/mounts writes spaces and tabs in paths as octal escapes (\040, \011).
fn unescape_mount(raw: &str) -> PathBuf {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let digits: String = chars.clone().take(3).collect();
            if let Ok(code) = u8::from_str_radix(&digits, 8) {
                out.push(code as char);
                chars.nth(2);
                continue;
            }
        }
        out.push(c);
    }
    PathBuf::from(out)
}

#[cfg(test)]
mod tests {
    use super::{is_relevant, needs_polling, unescape_mount};
    use notify::event::{AccessKind, CreateKind, MetadataKind, ModifyKind};
    use notify::EventKind;
    use std::path::{Path, PathBuf};

    const WSL_MOUNTS: &str = "\
/dev/sdc / ext4 rw,relatime 0 0
C:\\134 /mnt/c 9p rw,noatime,aname=drvfs 0 0
none /mnt/wsl tmpfs rw,relatime 0 0
/dev/sdd /mnt/c/Users/me/linux-disk ext4 rw 0 0";

    #[test]
    fn polls_the_windows_drive_but_not_the_linux_disk() {
        assert!(needs_polling(
            Path::new("/mnt/c/Users/me/code/app"),
            WSL_MOUNTS
        ));
        assert!(!needs_polling(Path::new("/home/me/code/app"), WSL_MOUNTS));
    }

    #[test]
    fn the_most_specific_mount_point_wins() {
        assert!(!needs_polling(
            Path::new("/mnt/c/Users/me/linux-disk/app"),
            WSL_MOUNTS
        ));
    }

    #[test]
    fn mount_points_match_whole_components() {
        assert!(!needs_polling(Path::new("/mnt/cache/app"), WSL_MOUNTS));
    }

    #[test]
    fn unknown_mounts_fall_back_to_native_notifications() {
        assert!(!needs_polling(Path::new("/anything"), ""));
    }

    #[test]
    fn decodes_escaped_spaces_in_mount_points() {
        assert_eq!(
            unescape_mount("/mnt/my\\040drive"),
            PathBuf::from("/mnt/my drive")
        );
        assert_eq!(unescape_mount("/plain"), PathBuf::from("/plain"));
    }

    #[test]
    fn keeps_changes_and_drops_reads() {
        assert!(is_relevant(&EventKind::Create(CreateKind::File)));
        assert!(is_relevant(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::WriteTime
        ))));
        assert!(!is_relevant(&EventKind::Access(AccessKind::Any)));
    }
}
