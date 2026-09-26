//! The AppImage bundles its own libwayland, built for an older Mesa than
//! rolling distros ship: WebKit then fails with EGL_BAD_PARAMETER and the
//! window never draws. Preloading the system's copy fixes it, and a preload
//! only takes effect at process start, so the app re-executes itself once.

use std::ffi::{OsStr, OsString};
use std::path::Path;

const GUARD: &str = "CODENXG_WAYLAND_REEXEC";
const SYSTEM_LIBS: &[&str] = &[
    "/usr/lib/libwayland-client.so.0",
    "/usr/lib64/libwayland-client.so.0",
    "/usr/lib/x86_64-linux-gnu/libwayland-client.so.0",
    "/lib/x86_64-linux-gnu/libwayland-client.so.0",
];

fn preload_value(lib: &Path, existing: Option<OsString>) -> OsString {
    let mut value = OsString::from(lib);
    if let Some(existing) = existing.filter(|e| !e.is_empty()) {
        value.push(":");
        value.push(existing);
    }
    value
}

/// No-op outside an AppImage, when already re-executed, or when the system
/// has no libwayland to prefer.
// Set by the AppImage runtime or by `prefer_system_wayland`: meaningless to
// (or harmful for) anything the editor launches.
const OWN_VARS: &[&str] = &["APPDIR", "APPIMAGE", "ARGV0", "OWD", GUARD];

/// Environment edits for programs the editor launches (terminal, git, language
/// servers): `Some` sets a value, `None` removes the variable. The AppImage
/// points LD_LIBRARY_PATH, PYTHONHOME, PATH and friends at its own bundled
/// copies, so without this a shell's `git` loads the wrong libpcre and its
/// `python` looks for a standard library that isn't there. Empty outside an
/// AppImage.
pub fn child_env_changes() -> Vec<(OsString, Option<OsString>)> {
    changes_for(&std::env::vars_os().collect::<Vec<_>>())
}

fn changes_for(vars: &[(OsString, OsString)]) -> Vec<(OsString, Option<OsString>)> {
    let Some(appdir) = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    let mut changes = Vec::new();
    for (key, value) in vars {
        let name = key.to_string_lossy();
        if OWN_VARS.contains(&name.as_ref()) {
            changes.push((key.clone(), None));
        } else if name == "LD_PRELOAD" {
            let kept = keep_entries(value, |entry| !SYSTEM_LIBS.contains(&entry));
            push_change(&mut changes, key, value, kept);
        } else if value.to_string_lossy().contains(&appdir) {
            let kept = keep_entries(value, |entry| !entry.starts_with(&appdir));
            push_change(&mut changes, key, value, kept);
        }
    }
    changes
}

fn keep_entries(value: &OsStr, keep: impl Fn(&str) -> bool) -> Option<OsString> {
    let value = value.to_string_lossy();
    let kept: Vec<&str> = value.split(':').filter(|entry| !entry.is_empty() && keep(entry)).collect();
    (!kept.is_empty()).then(|| OsString::from(kept.join(":")))
}

fn push_change(changes: &mut Vec<(OsString, Option<OsString>)>, key: &OsStr, old: &OsStr, new: Option<OsString>) {
    if new.as_deref() != Some(old) {
        changes.push((key.to_os_string(), new));
    }
}

/// `value` (a PATH-style list) without the AppImage's own directories.
pub fn without_appdir(value: OsString) -> OsString {
    let Some(appdir) = std::env::var("APPDIR").ok() else {
        return value;
    };
    keep_entries(&value, |entry| !entry.starts_with(&appdir)).unwrap_or_default()
}

pub fn clean_command(command: &mut std::process::Command) {
    for (key, value) in child_env_changes() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
}

pub fn clean_pty_command(command: &mut portable_pty::CommandBuilder) {
    for (key, value) in child_env_changes() {
        match value {
            Some(value) => command.env(key, value),
            None => command.env_remove(key),
        };
    }
}

#[cfg(target_os = "linux")]
pub fn prefer_system_wayland() {
    use std::os::unix::process::CommandExt;

    if std::env::var_os("APPIMAGE").is_none() || std::env::var_os(GUARD).is_some() {
        return;
    }
    let Some(lib) = SYSTEM_LIBS.iter().map(Path::new).find(|p| p.exists()) else {
        return;
    };
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let preload = preload_value(lib, std::env::var_os("LD_PRELOAD"));
    // exec only returns on failure; the app then starts as it would have.
    let error = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .env(GUARD, "1")
        .env("LD_PRELOAD", preload)
        .exec();
    eprintln!("Could not restart with the system libwayland: {error}");
}

#[cfg(not(target_os = "linux"))]
pub fn prefer_system_wayland() {}

#[cfg(test)]
mod tests {
    use super::{changes_for, preload_value};
    use std::ffi::OsString;
    use std::path::Path;

    #[test]
    fn keeps_an_existing_preload_after_ours() {
        let lib = Path::new("/usr/lib/libwayland-client.so.0");
        assert_eq!(preload_value(lib, None), OsString::from("/usr/lib/libwayland-client.so.0"));
        assert_eq!(
            preload_value(lib, Some("/x/y.so".into())),
            OsString::from("/usr/lib/libwayland-client.so.0:/x/y.so")
        );
        assert_eq!(preload_value(lib, Some("".into())), OsString::from("/usr/lib/libwayland-client.so.0"));
    }

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn nothing_changes_outside_an_appimage() {
        assert!(changes_for(&vars(&[("PATH", "/usr/bin"), ("PYTHONHOME", "/opt/py")])).is_empty());
    }

    #[test]
    fn only_the_appimage_entries_are_dropped() {
        let changes = changes_for(&vars(&[
            ("APPDIR", "/tmp/.mount_x"),
            ("APPIMAGE", "/home/u/App.AppImage"),
            ("PATH", "/tmp/.mount_x/usr/bin/:/usr/bin:/home/u/bin"),
            ("PYTHONHOME", "/tmp/.mount_x/usr/"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_x/usr/lib/"),
            ("LD_PRELOAD", "/usr/lib/libwayland-client.so.0:/opt/mine.so"),
            ("HOME", "/home/u"),
        ]));
        let get = |name: &str| changes.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        assert_eq!(get("PATH"), Some(Some("/usr/bin:/home/u/bin".into())));
        assert_eq!(get("PYTHONHOME"), Some(None));
        assert_eq!(get("LD_LIBRARY_PATH"), Some(None));
        assert_eq!(get("LD_PRELOAD"), Some(Some("/opt/mine.so".into())));
        assert_eq!(get("APPDIR"), Some(None));
        assert_eq!(get("APPIMAGE"), Some(None));
        assert_eq!(get("HOME"), None);
    }
}
