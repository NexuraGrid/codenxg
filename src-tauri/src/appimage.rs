//! The AppImage bundles its own libwayland, built for an older Mesa than
//! rolling distros ship: WebKit then fails with EGL_BAD_PARAMETER and the
//! window never draws. Preloading the system's copy fixes it, and a preload
//! only takes effect at process start, so the app re-executes itself once.

use std::ffi::OsString;
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
    use super::preload_value;
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
}
