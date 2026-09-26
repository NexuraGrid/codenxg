use super::fs::write_atomic;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// Settings and the remembered per-workspace tab list are both small JSON blobs
// that live in the OS app-config folder (not localStorage): they survive a
// webview data wipe and are easy to back up or inspect by hand.
const SETTINGS_FILE: &str = "settings.json";
const WORKSPACES_STATE_FILE: &str = "workspaces-state.json";

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `None` when the file was never written yet — the frontend falls back to
/// defaults, this is not an error.
fn read_named_file(dir: &Path, name: &str) -> Result<Option<String>, String> {
    match std::fs::read_to_string(dir.join(name)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_named_file(dir: &Path, name: &str, content: &str) -> Result<(), String> {
    write_atomic(&dir.join(name), content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn read_settings(app: AppHandle) -> Result<Option<String>, String> {
    read_named_file(&config_dir(&app)?, SETTINGS_FILE)
}

#[tauri::command(async)]
pub fn write_settings(app: AppHandle, content: String) -> Result<(), String> {
    write_named_file(&config_dir(&app)?, SETTINGS_FILE, &content)
}

#[tauri::command(async)]
pub fn read_workspaces_state(app: AppHandle) -> Result<Option<String>, String> {
    read_named_file(&config_dir(&app)?, WORKSPACES_STATE_FILE)
}

#[tauri::command(async)]
pub fn write_workspaces_state(app: AppHandle, content: String) -> Result<(), String> {
    write_named_file(&config_dir(&app)?, WORKSPACES_STATE_FILE, &content)
}

#[cfg(test)]
mod tests {
    use super::{read_named_file, write_named_file};
    use std::path::PathBuf;

    fn scratch_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("code-editor-settings-{label}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_reads_as_none() {
        let dir = scratch_dir("missing");
        assert_eq!(read_named_file(&dir, "settings.json").unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_then_read_roundtrips() {
        let dir = scratch_dir("roundtrip");
        write_named_file(&dir, "settings.json", "{\"a\":1}").unwrap();
        assert_eq!(read_named_file(&dir, "settings.json").unwrap(), Some("{\"a\":1}".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn write_overwrites_atomically() {
        let dir = scratch_dir("overwrite");
        write_named_file(&dir, "settings.json", "first").unwrap();
        write_named_file(&dir, "settings.json", "second").unwrap();
        assert_eq!(read_named_file(&dir, "settings.json").unwrap(), Some("second".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn two_named_files_stay_independent() {
        let dir = scratch_dir("independent");
        write_named_file(&dir, "settings.json", "s").unwrap();
        write_named_file(&dir, "workspaces-state.json", "w").unwrap();
        assert_eq!(read_named_file(&dir, "settings.json").unwrap(), Some("s".to_string()));
        assert_eq!(read_named_file(&dir, "workspaces-state.json").unwrap(), Some("w".to_string()));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
