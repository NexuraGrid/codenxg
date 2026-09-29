//! Local images for the Markdown preview. The asset protocol stays off; this
//! serves only image files, only from inside the open workspace, and only up
//! to a size cap, as raw bytes the webview turns into a `blob:` URL.

use crate::state::WorkspaceState;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::ipc::Response;
use tauri::State;

pub(crate) const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS: [&str; 9] = [
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif",
];

#[tauri::command(async)]
pub fn read_image_data(state: State<'_, WorkspaceState>, path: String) -> Result<Response, String> {
    let root = state
        .root
        .read()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or_else(|| "No workspace is open".to_string())?;
    let image = resolve_image(&root, Path::new(&path))?;
    read_capped(&image, MAX_IMAGE_BYTES).map(Response::new)
}

fn has_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// The real file behind `path` when it's an image inside `root`. Unlike the
/// lexical workspace check used for editing, this canonicalizes both sides,
/// so `..` segments and symlinks can't lead outside the workspace, and the
/// file it finally lands on must itself be an image.
fn resolve_image(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Image path must be absolute".into());
    }
    if !has_image_extension(path) {
        return Err("Not an image file".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = path
        .canonicalize()
        .map_err(|_| "Image not found".to_string())?;
    // Path::starts_with compares whole components: "/ws" never matches "/ws-other".
    if !target.starts_with(&root) {
        return Err("Image is outside the workspace".into());
    }
    if !has_image_extension(&target) || !target.is_file() {
        return Err("Not an image file".into());
    }
    Ok(target)
}

fn read_capped(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let too_big = || format!("Image is larger than {} MB", max_bytes / 1_048_576);
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > max_bytes {
        return Err(too_big());
    }
    // The size check above can race a file still being written: cap the read too.
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_big());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{read_capped, resolve_image};
    use std::path::PathBuf;

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("code-editor-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    /// A workspace with `docs/logo.PNG` and `notes.txt`, next to an outside
    /// folder holding `secret.png`.
    fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = scratch_dir(label);
        let root = base.join("ws");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("docs/logo.PNG"), b"png").unwrap();
        std::fs::write(root.join("notes.txt"), b"text").unwrap();
        std::fs::write(outside.join("secret.png"), b"secret").unwrap();
        (base, root, outside)
    }

    #[test]
    fn serves_an_image_inside_the_workspace() {
        let (base, root, _) = fixture("img-ok");
        let resolved = resolve_image(&root, &root.join("docs/logo.PNG")).unwrap();
        assert_eq!(resolved, root.join("docs/logo.PNG"));
        // `..` that stays inside is fine.
        assert!(resolve_image(&root, &root.join("docs/../docs/logo.PNG")).is_ok());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_traversal_out_of_the_workspace() {
        let (base, root, _) = fixture("img-traversal");
        let escaping = root.join("docs/../../outside/secret.png");
        assert_eq!(
            resolve_image(&root, &escaping).unwrap_err(),
            "Image is outside the workspace"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_non_images_relative_paths_folders_and_missing_files() {
        let (base, root, _) = fixture("img-kinds");
        assert!(resolve_image(&root, &root.join("notes.txt")).is_err());
        assert!(resolve_image(&root, &PathBuf::from("docs/logo.PNG")).is_err());
        assert!(resolve_image(&root, &root.join("nope.png")).is_err());
        std::fs::create_dir_all(root.join("folder.png")).unwrap();
        assert!(resolve_image(&root, &root.join("folder.png")).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_or_disguise_a_non_image() {
        let (base, root, outside) = fixture("img-symlink");
        std::os::unix::fs::symlink(outside.join("secret.png"), root.join("link.png")).unwrap();
        assert_eq!(
            resolve_image(&root, &root.join("link.png")).unwrap_err(),
            "Image is outside the workspace"
        );
        std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();
        assert!(resolve_image(&root, &root.join("dir/secret.png")).is_err());
        std::os::unix::fs::symlink(root.join("notes.txt"), root.join("fake.png")).unwrap();
        assert_eq!(
            resolve_image(&root, &root.join("fake.png")).unwrap_err(),
            "Not an image file"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn caps_the_size() {
        let (base, root, _) = fixture("img-size");
        let big = root.join("big.png");
        std::fs::write(&big, vec![0u8; 11]).unwrap();
        assert!(read_capped(&big, 10).is_err());
        assert_eq!(read_capped(&big, 11).unwrap().len(), 11);
        std::fs::remove_dir_all(base).unwrap();
    }
}
