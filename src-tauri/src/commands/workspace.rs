use crate::state::WorkspaceState;
use std::path::{Component, Path, PathBuf};
use tauri::State;

/// Opens `path` as the workspace. Every later filesystem and terminal command
/// is checked against it.
#[tauri::command(async)]
pub fn set_workspace(state: State<'_, WorkspaceState>, path: String) -> Result<(), String> {
    let root = normalize(Path::new(&path));
    if !root.is_dir() {
        return Err(format!("\"{path}\" is not a folder"));
    }
    *state.root.write().map_err(|e| e.to_string())? = Some(root);
    Ok(())
}

/// Resolves `path` against the open workspace, rejecting anything outside it.
pub fn ensure_in_workspace(state: &WorkspaceState, path: &str) -> Result<PathBuf, String> {
    let root = state.root.read().map_err(|e| e.to_string())?;
    let root = root.as_ref().ok_or_else(|| "No workspace is open".to_string())?;
    check_inside(root, Path::new(path))
}

/// Like `ensure_in_workspace`, but also refuses the workspace root itself:
/// deleting, moving or trashing the open folder is never what the user meant.
pub fn ensure_below_workspace(state: &WorkspaceState, path: &str) -> Result<PathBuf, String> {
    let resolved = ensure_in_workspace(state, path)?;
    let root = state.root.read().map_err(|e| e.to_string())?;
    if root.as_deref() == Some(resolved.as_path()) {
        return Err("Can't do that to the workspace folder itself".into());
    }
    Ok(resolved)
}

// Lexical on purpose: the frontend builds every path from the root string it
// passed in, and new files don't exist yet, so canonicalize() can't be used.
fn check_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let resolved = normalize(path);
    // Path::starts_with compares whole components: "/ws" never matches "/ws-other".
    if resolved.is_absolute() && resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err("Path is outside the workspace".into())
    }
}

/// Resolves `.` and `..` without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{check_inside, normalize};
    use std::path::{Path, PathBuf};

    #[test]
    fn normalize_resolves_dot_and_dot_dot() {
        assert_eq!(normalize(Path::new("/ws/src/./a/../b.ts")), PathBuf::from("/ws/src/b.ts"));
        assert_eq!(normalize(Path::new("/ws/../..")), PathBuf::from("/"));
    }

    #[test]
    fn accepts_the_root_and_paths_inside_it() {
        let root = Path::new("/ws");
        assert!(check_inside(root, Path::new("/ws")).is_ok());
        assert_eq!(check_inside(root, Path::new("/ws/src/./a.ts")), Ok(PathBuf::from("/ws/src/a.ts")));
    }

    #[test]
    fn rejects_escapes_siblings_and_relative_paths() {
        let root = Path::new("/ws");
        for bad in ["/ws/a/../../etc/passwd", "/ws-other/x", "/etc", "ws/a.ts", "../ws/a.ts"] {
            assert!(check_inside(root, Path::new(bad)).is_err(), "{bad:?} should be rejected");
        }
    }
}
