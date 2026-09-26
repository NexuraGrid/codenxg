use super::shell::{host_os, HostOs};
use crate::state::WorkspaceState;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Language servers the editor knows how to run, first match wins. Only these
/// are ever spawned: the webview names a language, never a command.
const SERVERS: &[(&str, &[(&str, &[&str])])] = &[
    ("php", &[("intelephense", &["--stdio"])]),
    (
        "python",
        &[
            ("pyright-langserver", &["--stdio"]),
            ("basedpyright-langserver", &["--stdio"]),
            ("pylsp", &[]),
        ],
    ),
    // jdtls also gets `-data <dir>` (see data_dir_args).
    ("java", &[("jdtls", &[])]),
];

/// Shown when nothing is installed for a language.
const INSTALL_HINTS: &[(&str, &str)] = &[
    ("php", "npm install -g intelephense"),
    ("python", "npm install -g pyright"),
    ("java", "brew install jdtls   (needs Java 21+)"),
];

// Sent to the webview when the server process ends, so it can stop waiting.
const EXITED_NOTIFICATION: &str = r#"{"jsonrpc":"2.0","method":"$/codenxg/serverExited"}"#;

#[derive(Default)]
pub struct LspRegistry {
    servers: Mutex<HashMap<String, LspServer>>,
}

struct LspServer {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

/// Starts (or restarts) the server for `language` in the workspace folder and
/// returns its name. Messages from the server arrive on `on_message`.
#[tauri::command(async)]
pub fn lsp_start(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    workspace: State<'_, WorkspaceState>,
    language: String,
    on_message: Channel<String>,
) -> Result<String, String> {
    let root = workspace
        .root
        .read()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("No workspace is open")?;
    let candidates = SERVERS
        .iter()
        .find(|(id, _)| *id == language)
        .map(|(_, candidates)| *candidates)
        .ok_or_else(|| format!("No language server is configured for {language}"))?;

    let resolved = match host_os() {
        // npm/pip global installs on Windows are `.cmd`/`.bat` shims, not the
        // login-shell/nvm dance `resolve_binary` does for Unix.
        HostOs::Windows => {
            let path_var = std::env::var("PATH").unwrap_or_default();
            candidates.iter().find_map(|(name, args)| {
                resolve_binary_windows(name, &path_var, &|p| Path::new(p).is_file()).map(|(binary, is_shim)| (*name, binary, is_shim, *args))
            })
        }
        HostOs::Unix => candidates
            .iter()
            .find_map(|(name, args)| resolve_binary(name).map(|binary| (*name, binary.to_string_lossy().into_owned(), false, *args))),
    };
    let Some((name, binary, is_shim, args)) = resolved else {
        let hint = INSTALL_HINTS.iter().find(|(id, _)| *id == language).map_or("", |(_, h)| h);
        return Err(format!("not-installed:{hint}"));
    };

    stop(&registry, &language);

    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    let (program, full_args) = command_for_binary(&binary, is_shim, &comspec, args);

    let mut command = Command::new(&program);
    command
        .args(&full_args)
        .args(data_dir_args(name, &root))
        .current_dir(&root)
        .env("PATH", path_with(Path::new(&binary)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("Couldn't start {name}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    // Servers log to stderr; it must be drained or a chatty one blocks.
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }

    registry
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(language.clone(), LspServer { child, stdin: Arc::new(Mutex::new(stdin)) });

    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(message)) = read_message(&mut reader) {
            if on_message.send(message).is_err() {
                break;
            }
        }
        // Reap the process so it doesn't linger as a zombie.
        if let Ok(mut servers) = app.state::<LspRegistry>().servers.lock() {
            if let Some(mut server) = servers.remove(&language) {
                let _ = server.child.wait();
            }
        }
        let _ = on_message.send(EXITED_NOTIFICATION.to_string());
    });

    Ok(name.to_string())
}

#[tauri::command(async)]
pub fn lsp_send(registry: State<'_, LspRegistry>, language: String, message: String) -> Result<(), String> {
    // Hold the registry lock only to find the pipe: a server busy indexing can
    // leave a write blocked, and that must not stall the other languages.
    let stdin = {
        let servers = registry.servers.lock().map_err(|e| e.to_string())?;
        let server = servers.get(&language).ok_or_else(|| format!("{language} server is not running"))?;
        Arc::clone(&server.stdin)
    };
    let mut stdin = stdin.lock().map_err(|e| e.to_string())?;
    write_message(&mut *stdin, &message).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn lsp_stop(registry: State<'_, LspRegistry>, language: String) -> Result<(), String> {
    stop(&registry, &language);
    Ok(())
}

fn stop(registry: &LspRegistry, language: &str) {
    let removed = registry.servers.lock().ok().and_then(|mut servers| servers.remove(language));
    if let Some(mut server) = removed {
        let _ = server.child.kill();
        let _ = server.child.wait();
    }
}

/// One LSP message: `Content-Length: N` headers, a blank line, N bytes of JSON.
/// Ok(None) at end of stream.
fn read_message(reader: &mut impl BufRead) -> std::io::Result<Option<String>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let mut body = vec![0; length.unwrap_or(0)];
    reader.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

fn write_message(writer: &mut impl Write, json: &str) -> std::io::Result<()> {
    write!(writer, "Content-Length: {}\r\n\r\n{json}", json.len())?;
    writer.flush()
}

/// Finds a server binary on Unix. GUI launches don't inherit the shell's
/// PATH, and npm globals under nvm are only on PATH once the shell rc has
/// run. (Windows has its own resolve_binary_windows below: no login shell,
/// no nvm, and a `.cmd`/`.bat` shim needs different handling to spawn.)
fn resolve_binary(name: &str) -> Option<PathBuf> {
    find_in_path(name, &std::env::var("PATH").unwrap_or_default())
        .or_else(|| from_login_shell(name))
        .or_else(|| from_nvm(name))
}

fn find_in_path(name: &str, path_var: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var).map(|dir| dir.join(name)).find(|p| is_executable(p))
}

fn from_login_shell(name: &str) -> Option<PathBuf> {
    // -i as well as -l: nvm is loaded from .bashrc, which only runs interactively.
    let output = Command::new("bash")
        .args(["-lic", &format!("command -v {name}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .map(PathBuf::from)
        .find(|p| is_executable(p))
}

fn from_nvm(name: &str) -> Option<PathBuf> {
    let versions = PathBuf::from(std::env::var("HOME").ok()?).join(".nvm/versions/node");
    std::fs::read_dir(versions)
        .ok()?
        .flatten()
        .map(|version| version.path().join("bin").join(name))
        .find(|p| is_executable(p))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Finds a server binary on Windows: no login shell, no nvm — just PATH,
/// trying the same extensions `PATHEXT` normally would. Also reports whether
/// what it found is a `.cmd`/`.bat` shim, which needs different handling to
/// spawn (see command_for_binary).
///
/// Deliberately plain string handling throughout, not `std::path` — `Path`'s
/// `\`-as-separator and `env::split_paths`'s `;`-as-list-separator behaviour
/// only apply when actually *compiled* for Windows, which would make this
/// untestable with a fake Windows-shaped PATH on any other host (including
/// this project's Linux CI). `exists` is likewise injected.
fn resolve_binary_windows(name: &str, path_var: &str, exists: &dyn Fn(&str) -> bool) -> Option<(String, bool)> {
    const EXTENSIONS: &[&str] = &["exe", "cmd", "bat"];
    path_var.split(';').map(str::trim).filter(|dir| !dir.is_empty()).find_map(|dir| {
        let dir = dir.trim_end_matches(['\\', '/']);
        EXTENSIONS.iter().find_map(|ext| {
            let candidate = format!("{dir}\\{name}.{ext}");
            exists(&candidate).then(|| (candidate, *ext != "exe"))
        })
    })
}

/// A `.cmd`/`.bat` shim (npm's global-install launcher on Windows) can't be
/// spawned directly by `Command::new` — Windows only knows how to run a
/// batch file through `cmd.exe`, so it's wrapped as `cmd /C <shim> <args>`.
/// A plain `.exe` (as some servers ship) is spawned as-is.
fn command_for_binary(binary: &str, is_shim: bool, comspec: &str, extra_args: &[&str]) -> (String, Vec<String>) {
    if is_shim {
        let mut args = vec!["/C".to_string(), binary.to_string()];
        args.extend(extra_args.iter().map(|s| s.to_string()));
        (comspec.to_string(), args)
    } else {
        (binary.to_string(), extra_args.iter().map(|s| s.to_string()).collect())
    }
}

// npm-installed servers start with `#!/usr/bin/env node`: node lives next to
// them (nvm), so that folder goes first on the child's PATH.
fn path_with(binary: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = binary.parent().map(Path::to_path_buf).into_iter().collect();
    dirs.extend(std::env::split_paths(&std::env::var("PATH").unwrap_or_default()));
    std::env::join_paths(dirs).unwrap_or_default()
}

// jdtls insists on a writable workspace-data folder, one per project.
fn data_dir_args(server: &str, root: &Path) -> Vec<String> {
    if server != "jdtls" {
        return Vec::new();
    }
    let cache = std::env::var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|_| std::env::var("HOME").map(|h| PathBuf::from(h).join(".cache")))
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = cache.join("codenxg/jdtls").join(format!("{:016x}", fnv1a(root.to_string_lossy().as_bytes())));
    vec!["-data".into(), dir.to_string_lossy().into_owned()]
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, b| (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3))
}

#[cfg(test)]
mod tests {
    use super::{command_for_binary, find_in_path, read_message, resolve_binary, resolve_binary_windows, write_message, SERVERS};
    use std::io::{BufReader, Cursor};

    #[test]
    fn frames_round_trip() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, r#"{"id":1,"text":"ñ"}"#).unwrap();
        write_message(&mut buffer, r#"{"id":2}"#).unwrap();

        let mut reader = BufReader::new(Cursor::new(buffer));
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), r#"{"id":1,"text":"ñ"}"#);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), r#"{"id":2}"#);
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn content_length_counts_bytes_not_characters() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, "\"ñ\"").unwrap();
        assert!(String::from_utf8(buffer).unwrap().starts_with("Content-Length: 4\r\n"));
    }

    #[test]
    fn tolerates_extra_headers_in_any_case() {
        let raw = "content-length: 2\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n{}";
        let mut reader = BufReader::new(Cursor::new(raw));
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), "{}");
    }

    #[test]
    fn finds_binaries_on_a_given_path() {
        assert!(find_in_path("sh", "/nonexistent:/bin").is_some());
        assert!(find_in_path("definitely-not-a-binary", "/bin").is_none());
    }

    #[test]
    fn every_language_has_an_install_hint() {
        for (language, _) in SERVERS {
            assert!(super::INSTALL_HINTS.iter().any(|(id, _)| id == language), "{language}");
        }
    }

    // End to end against a real server when one is installed (skipped otherwise).
    #[test]
    fn talks_to_a_real_language_server() {
        let Some(binary) = resolve_binary("pyright-langserver") else { return };
        let mut child = std::process::Command::new(&binary)
            .arg("--stdio")
            .env("PATH", super::path_with(&binary))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());

        write_message(
            &mut stdin,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}"#,
        )
        .unwrap();
        let response = loop {
            let message = read_message(&mut stdout).unwrap().expect("server closed");
            if message.contains(r#""id":1"#) {
                break message;
            }
        };
        let _ = child.kill();
        assert!(response.contains("capabilities"), "{response}");
    }

    fn exists_of(paths: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |p| paths.contains(&p)
    }

    #[test]
    fn resolve_binary_windows_prefers_exe_over_cmd_over_bat_within_a_directory() {
        let found = resolve_binary_windows(
            "intelephense",
            "C:\\a;C:\\b",
            &exists_of(&["C:\\a\\intelephense.cmd", "C:\\a\\intelephense.bat"]),
        );
        assert_eq!(found, Some(("C:\\a\\intelephense.cmd".to_string(), true)));
    }

    #[test]
    fn resolve_binary_windows_reports_a_plain_exe_as_not_a_shim() {
        let found = resolve_binary_windows("jdtls", "C:\\tools", &exists_of(&["C:\\tools\\jdtls.exe"]));
        assert_eq!(found, Some(("C:\\tools\\jdtls.exe".to_string(), false)));
    }

    #[test]
    fn resolve_binary_windows_searches_every_path_entry_in_order() {
        let found = resolve_binary_windows("pyright-langserver", "C:\\empty;C:\\npm", &exists_of(&["C:\\npm\\pyright-langserver.cmd"]));
        assert_eq!(found, Some(("C:\\npm\\pyright-langserver.cmd".to_string(), true)));
    }

    #[test]
    fn resolve_binary_windows_is_none_when_nothing_matches() {
        assert_eq!(resolve_binary_windows("nope", "C:\\a", &exists_of(&[])), None);
    }

    #[test]
    fn resolve_binary_windows_tolerates_a_trailing_separator_on_a_path_entry() {
        let found = resolve_binary_windows("intelephense", "C:\\npm\\", &exists_of(&["C:\\npm\\intelephense.cmd"]));
        assert_eq!(found, Some(("C:\\npm\\intelephense.cmd".to_string(), true)));
    }

    #[test]
    fn command_for_binary_wraps_a_shim_with_cmd_c() {
        let (program, args) = command_for_binary("C:\\npm\\intelephense.cmd", true, "C:\\Windows\\System32\\cmd.exe", &["--stdio"]);
        assert_eq!(program, "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(args, vec!["/C", "C:\\npm\\intelephense.cmd", "--stdio"]);
    }

    #[test]
    fn command_for_binary_spawns_a_plain_exe_directly() {
        let (program, args) = command_for_binary("C:\\tools\\jdtls.exe", false, "cmd.exe", &[]);
        assert_eq!(program, "C:\\tools\\jdtls.exe");
        assert!(args.is_empty());
    }
}
