/// Makes `codenxg` runnable from a terminal and, on Linux, adds the app to the
/// launcher. Returns a message describing what was set up.
#[tauri::command(async)]
pub fn install_cli() -> Result<String, String> {
    install()
}

#[cfg(target_os = "linux")]
fn install() -> Result<String, String> {
    use std::os::unix::fs::symlink;
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
    // Replace a stale link from an earlier location of the AppImage.
    if link.symlink_metadata().is_ok() {
        std::fs::remove_file(&link).map_err(|e| e.to_string())?;
    }
    symlink(&appimage, &link).map_err(|e| e.to_string())?;

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
        "Installed. Run `codenxg .` in any terminal. Run this again if you move the AppImage.".into()
    } else {
        "Installed, but ~/.local/bin is not on your PATH. Add it to your shell config, then run `codenxg .`.".into()
    })
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
