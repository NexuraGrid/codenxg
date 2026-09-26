/// Makes `codenxg` runnable from a terminal and, on Linux, adds the app to the
/// launcher. Returns a message describing what was set up.
#[tauri::command(async)]
pub fn install_cli() -> Result<String, String> {
    install()
}

/// Wrapper for `~/.local/bin/codenxg`. `setsid -f` detaches the app so the
/// terminal gets its prompt back; it can't be done from inside the AppImage,
/// whose runtime unmounts the app as soon as the launched process exits.
#[cfg(target_os = "linux")]
fn launcher_script(appimage: &std::path::Path) -> String {
    let quoted = format!("'{}'", appimage.display().to_string().replace('\'', "'\\''"));
    format!("#!/bin/sh\nexec setsid -f {quoted} \"$@\" >/dev/null 2>&1 </dev/null\n")
}

#[cfg(target_os = "linux")]
fn install() -> Result<String, String> {
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    // Set by the AppImage runtime. Packaged installs (.deb/.rpm) already put
    // `codenxg` on PATH, and a dev build has nothing stable to point at.
    let appimage = std::env::var_os("APPIMAGE")
        .map(PathBuf::from)
        .ok_or("This is only needed for the AppImage build; other installs already provide `codenxg`.")?;
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("HOME is not set")?;

    let bin_dir = home.join(".local/bin");
    std::fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let link = bin_dir.join("codenxg");
    // Remove first: an older install may have left a symlink to the AppImage,
    // and writing through it would overwrite the app itself.
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    std::fs::write(&link, launcher_script(&appimage)).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&link, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;

    let icon_dir = home.join(".local/share/icons/hicolor/128x128/apps");
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;
    std::fs::write(icon_dir.join("codenxg.png"), include_bytes!("../../icons/128x128.png"))
        .map_err(|e| e.to_string())?;

    let apps_dir = home.join(".local/share/applications");
    std::fs::create_dir_all(&apps_dir).map_err(|e| e.to_string())?;
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName=CodeNXG\nComment=Code editor\nExec=\"{}\"\nIcon=codenxg\nCategories=Development;TextEditor;\nTerminal=false\n",
        appimage.display()
    );
    std::fs::write(apps_dir.join("codenxg.desktop"), entry).map_err(|e| e.to_string())?;

    let on_path = std::env::var("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d == bin_dir))
        .unwrap_or(false);
    Ok(if on_path {
        "Installed. Run `codenxg .` in any terminal; it returns the prompt right away. Run this again if you move the AppImage.".into()
    } else {
        "Installed, but ~/.local/bin is not on your PATH. Add it to your shell config, then run `codenxg .`.".into()
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::launcher_script;
    use std::path::Path;

    #[test]
    fn launcher_quotes_paths_with_spaces_and_quotes() {
        let script = launcher_script(Path::new("/home/a b/it's/CodeNXG.AppImage"));
        assert!(script.contains(r"exec setsid -f '/home/a b/it'\''s/CodeNXG.AppImage' "));
        assert!(script.starts_with("#!/bin/sh\n"));
    }
}

#[cfg(windows)]
fn install() -> Result<String, String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // SetEnvironmentVariable(..., 'User') also notifies running programs, so
    // new terminals pick the change up. The folder travels in an env var to
    // keep it out of the script text.
    const SCRIPT: &str = "$d = $env:CODENXG_DIR; \
        $p = [Environment]::GetEnvironmentVariable('Path', 'User'); \
        $parts = @(); if ($p) { $parts = @($p -split ';' | Where-Object { $_ }) }; \
        if ($parts -notcontains $d) { \
            [Environment]::SetEnvironmentVariable('Path', (($parts + $d) -join ';'), 'User') }";

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("Could not locate the install folder")?;
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
        .env("CODENXG_DIR", dir)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not update the PATH".into());
    }
    Ok("Installed. Open a new terminal and run `codenxg .`.".into())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn install() -> Result<String, String> {
    Err("Not supported on this platform".into())
}
