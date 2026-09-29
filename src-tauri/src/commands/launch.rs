use super::workspace::normalize;
use std::path::{Path, PathBuf};

/// Folder a launch asked for (`codenxg .`, `codenxg ~/project`): the first
/// non-flag argument after the program name, made absolute against `cwd`.
pub fn folder_from_args(args: &[String], cwd: &str) -> Option<String> {
    let arg = args.iter().skip(1).find(|a| !a.starts_with('-'))?;
    let path = Path::new(arg);
    let absolute: PathBuf = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };
    let resolved = normalize(&absolute);
    resolved
        .is_dir()
        .then(|| resolved.to_string_lossy().into_owned())
}

/// The folder this process was launched with, if any.
#[tauri::command]
pub fn launch_folder() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().ok()?;
    folder_from_args(&args, &cwd.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::folder_from_args;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn dot_resolves_to_the_working_directory() {
        let cwd = std::env::temp_dir();
        let expected = cwd.to_string_lossy().into_owned();
        assert_eq!(
            folder_from_args(&args(&["codenxg", "."]), &expected),
            Some(expected)
        );
    }

    #[test]
    fn relative_folders_are_resolved_against_cwd() {
        let base = std::env::temp_dir().join("codenxg-launch-test");
        std::fs::create_dir_all(base.join("proj")).unwrap();
        let expected = base.join("proj").to_string_lossy().into_owned();
        let got = folder_from_args(&args(&["codenxg", "proj"]), &base.to_string_lossy());
        assert_eq!(got, Some(expected));
    }

    #[test]
    fn flags_and_missing_folders_are_ignored() {
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        assert_eq!(folder_from_args(&args(&["codenxg"]), &cwd), None);
        assert_eq!(folder_from_args(&args(&["codenxg", "--flag"]), &cwd), None);
        assert_eq!(
            folder_from_args(&args(&["codenxg", "does-not-exist-xyz"]), &cwd),
            None
        );
    }
}
