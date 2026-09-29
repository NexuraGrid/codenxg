use super::shell::{host_os, HostOs};
use crate::state::WorkspaceState;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// A server binary and the arguments it is launched with.
type ServerCandidate = (&'static str, &'static [&'static str]);

/// Language servers the editor knows how to run, first match wins. Only these
/// are ever spawned: the webview names a language, never a command. Keys are
/// Monaco language ids.
const SERVERS: &[(&str, &[ServerCandidate])] = &[
    ("php", &[("intelephense", &["--stdio"])]),
    (
        "python",
        &[
            ("pyright-langserver", &["--stdio"]),
            ("basedpyright-langserver", &["--stdio"]),
            ("pylsp", &[]),
        ],
    ),
    // jdtls also gets `-data <dir>` (see data_dir_args). Without one on PATH,
    // the managed install from lsp_install is used (see managed_jdtls_launch).
    ("java", &[("jdtls", &[])]),
    // gopls speaks stdio by default and shells out to the `go` command.
    ("go", &[("gopls", &[])]),
    ("rust", &[("rust-analyzer", &[])]),
    ("c", &[("clangd", &[])]),
    ("cpp", &[("clangd", &[])]),
    ("yaml", &[("yaml-language-server", &["--stdio"])]),
    ("shell", &[("bash-language-server", &["start"])]),
    // 2.x in its non-hybrid mode: it serves TypeScript inside .vue files
    // itself (3.x needs a TypeScript server plugin next to it).
    ("vue", &[("vue-language-server", &["--stdio"])]),
];

/// How `lsp_install` installs a language's server.
#[derive(Debug, PartialEq, Eq)]
enum Install {
    /// `program args…`, where `program` is a developer tool (npm, go,
    /// rustup) found the same way a server binary is.
    Run {
        program: &'static str,
        args: &'static [&'static str],
    },
    /// jdtls has no package-manager recipe: the official build is downloaded
    /// into the app data folder and launched with `java` directly.
    ManagedJdtls,
    /// No cross-platform one-click install; `hint` says what to run.
    Manual { hint: &'static str },
}

/// One allow-listed install per language: the webview only ever names a
/// language, never a command.
#[derive(Debug)]
struct Recipe {
    language: &'static str,
    install: Install,
    /// The program the install needs; reported as `tool-missing:<tool>:<requires>`.
    tool: &'static str,
    /// What that tool is and where to get it, for the "requires X" message.
    requires: &'static str,
}

const NODE: &str = "Node.js with npm (https://nodejs.org)";
const JAVA: &str = "Java 25 or newer (e.g. Eclipse Temurin, https://adoptium.net)";
const JDTLS_URL: &str =
    "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz";
// Current jdtls snapshots are built against Java 25 (their core bundles
// require `osgi.ee JavaSE 25`, even though the bundled jdtls.py still checks
// for 21): on 21 the OSGi framework starts but jdt.core never resolves.
const JAVA_MIN_MAJOR: u32 = 25;

const fn npm(language: &'static str, args: &'static [&'static str]) -> Recipe {
    Recipe {
        language,
        install: Install::Run {
            program: "npm",
            args,
        },
        tool: "npm",
        requires: NODE,
    }
}

const fn manual(language: &'static str, hint: &'static str) -> Recipe {
    Recipe {
        language,
        install: Install::Manual { hint },
        tool: "",
        requires: "",
    }
}

const CLANGD_HINT: &str =
    "sudo apt install clangd   (Fedora: dnf install clang-tools-extra · Arch: pacman -S clang · macOS: xcode-select --install · Windows: winget install LLVM.LLVM)";

const RECIPES: &[Recipe] = &[
    npm("php", &["install", "-g", "intelephense"]),
    npm("python", &["install", "-g", "pyright"]),
    Recipe {
        language: "go",
        install: Install::Run {
            program: "go",
            args: &["install", "golang.org/x/tools/gopls@latest"],
        },
        tool: "go",
        requires: "Go (https://go.dev/dl)",
    },
    Recipe {
        language: "java",
        install: Install::ManagedJdtls,
        tool: "java",
        requires: JAVA,
    },
    Recipe {
        language: "rust",
        install: Install::Run {
            program: "rustup",
            args: &["component", "add", "rust-analyzer"],
        },
        tool: "rustup",
        requires: "rustup (https://rustup.rs)",
    },
    // clangd ships with LLVM, which every platform packages differently.
    manual("c", CLANGD_HINT),
    manual("cpp", CLANGD_HINT),
    npm("yaml", &["install", "-g", "yaml-language-server"]),
    npm("shell", &["install", "-g", "bash-language-server"]),
    // TypeScript too: the Vue server loads it from `typescript.tsdk`.
    npm(
        "vue",
        &["install", "-g", "@vue/language-server@2", "typescript"],
    ),
];

fn recipe_for(language: &str) -> Option<&'static Recipe> {
    RECIPES.iter().find(|r| r.language == language)
}

/// What an install runs, as shown to (and copyable by) the user.
fn install_display(recipe: &Recipe) -> String {
    match &recipe.install {
        Install::Run { program, args } => format!("{program} {}", args.join(" ")),
        Install::ManagedJdtls => format!("download {JDTLS_URL}"),
        Install::Manual { hint } => hint.to_string(),
    }
}

/// The `not-installed:` error lsp_start returns; `installable:` marks the
/// languages lsp_install can handle, so the webview can offer the button.
fn not_installed_error(language: &str) -> String {
    match recipe_for(language) {
        Some(
            recipe @ Recipe {
                install: Install::Manual { .. },
                ..
            },
        ) => format!("not-installed:{}", install_display(recipe)),
        Some(recipe) => format!("not-installed:installable:{}", install_display(recipe)),
        None => "not-installed:".to_string(),
    }
}

/// The error for an install (or managed server) whose required tool isn't there.
fn tool_missing(recipe: &Recipe) -> String {
    format!("tool-missing:{}:{}", recipe.tool, recipe.requires)
}

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

/// What lsp_start reports back: the server's name and, for servers whose
/// `initialize` options depend on the machine (Vue's TypeScript path), those.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LspStarted {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    initialization_options: Option<serde_json::Value>,
}

/// Everything needed to spawn one server.
struct Launch {
    name: &'static str,
    program: String,
    args: Vec<String>,
    path: OsString,
    initialization_options: Option<serde_json::Value>,
}

/// Starts (or restarts) the server for `language` in the workspace folder.
/// Messages from the server arrive on `on_message`.
#[tauri::command(async)]
pub fn lsp_start(
    app: AppHandle,
    registry: State<'_, LspRegistry>,
    workspace: State<'_, WorkspaceState>,
    language: String,
    on_message: Channel<String>,
) -> Result<LspStarted, String> {
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

    let launch = find_launch(&app, &language, candidates, &root)?;

    stop(&registry, &language);

    let mut command = Command::new(&launch.program);
    crate::appimage::clean_command(&mut command);
    command
        .args(&launch.args)
        .args(data_dir_args(launch.name, &root))
        .current_dir(&root)
        .env("PATH", &launch.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let name = launch.name;
    let mut child = command
        .spawn()
        .map_err(|e| format!("Couldn't start {name}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    // Servers log to stderr; it must be drained or a chatty one blocks.
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }

    registry.servers.lock().map_err(|e| e.to_string())?.insert(
        language.clone(),
        LspServer {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
        },
    );

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

    Ok(LspStarted {
        name: name.to_string(),
        initialization_options: launch.initialization_options,
    })
}

/// The first installed candidate for `language`, then (Java only) the managed
/// jdtls install. `not-installed:…` when there's nothing to run.
fn find_launch(
    app: &AppHandle,
    language: &str,
    candidates: &[(&'static str, &'static [&'static str])],
    root: &Path,
) -> Result<Launch, String> {
    let found = candidates
        .iter()
        .find_map(|(name, args)| {
            locate(name).map(|(binary, is_shim)| (*name, binary, is_shim, *args))
        })
        // rustup puts a `rust-analyzer` proxy in ~/.cargo/bin even when the
        // component isn't installed; it only fails once run.
        .filter(|(_, binary, _, _)| language != "rust" || runs(binary));
    if let Some((name, binary, is_shim, args)) = found {
        let initialization_options = match language {
            // Without a TypeScript to load the Vue server fails to initialize;
            // the one-click install brings one along.
            "vue" => Some(vue_initialization_options(
                &find_tsdk(root, Path::new(&binary))
                    .ok_or_else(|| not_installed_error(language))?,
            )),
            _ => None,
        };
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let (program, full_args) = command_for_binary(&binary, is_shim, &comspec, args);
        return Ok(Launch {
            name,
            program,
            args: full_args,
            path: server_path(language, &binary),
            initialization_options,
        });
    }
    if language == "java" {
        if let Some(launch) = managed_jdtls_launch(app)? {
            return Ok(launch);
        }
    }
    Err(not_installed_error(language))
}

/// Whether `binary --version` succeeds.
fn runs(binary: &str) -> bool {
    let mut command = Command::new(binary);
    crate::appimage::clean_command(&mut command);
    hide_console(&mut command);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Installs the language server for `language` with its fixed, allow-listed
/// recipe (see RECIPES). Errors are readable text, except `not-installable`
/// (no one-click recipe) and `tool-missing:<tool>:<what to install>`.
#[tauri::command]
pub async fn lsp_install(app: AppHandle, language: String) -> Result<(), String> {
    let recipe = recipe_for(&language).ok_or("not-installable")?;
    match &recipe.install {
        Install::Run { program, args } => {
            let (program, args) = (*program, *args);
            tauri::async_runtime::spawn_blocking(move || run_install(recipe, program, args))
                .await
                .map_err(|e| e.to_string())?
        }
        Install::ManagedJdtls => install_jdtls(&app, recipe).await,
        Install::Manual { .. } => Err("not-installable".to_string()),
    }
}

fn run_install(recipe: &Recipe, program: &str, args: &[&str]) -> Result<(), String> {
    let (binary, is_shim) = locate(program).ok_or_else(|| tool_missing(recipe))?;
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    let (program_path, full_args) = command_for_binary(&binary, is_shim, &comspec, args);

    let mut command = Command::new(&program_path);
    crate::appimage::clean_command(&mut command);
    hide_console(&mut command);
    // npm is a `#!/usr/bin/env node` script: node must be on the child's PATH.
    let output = command
        .args(&full_args)
        .env("PATH", path_with(Path::new(&binary)))
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Couldn't run {program}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let mut log = String::from_utf8_lossy(&output.stderr).into_owned();
    if log.trim().is_empty() {
        log = String::from_utf8_lossy(&output.stdout).into_owned();
    }
    Err(format!(
        "{program} {} failed ({}):\n{}",
        args.join(" "),
        output.status,
        tail(&log, 12)
    ))
}

/// A console program started from the GUI would otherwise flash a window on Windows.
fn hide_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// The last `lines` non-empty lines of `text` — npm's useful error is at the end.
fn tail(text: &str, lines: usize) -> String {
    let kept: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    kept[kept.len().saturating_sub(lines)..].join("\n")
}

// ---- Managed jdtls -------------------------------------------------------

fn managed_jdtls_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("lsp").join("jdtls"))
        .map_err(|e| e.to_string())
}

/// Downloads and unpacks the official jdtls build (after checking for a
/// usable Java, so nobody downloads 50 MB they can't run).
async fn install_jdtls(app: &AppHandle, recipe: &'static Recipe) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || find_java(recipe))
        .await
        .map_err(|e| e.to_string())??;
    let target = managed_jdtls_dir(app)?;

    // reqwest is built without a bundled TLS provider (as the updater does).
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let download_error =
        |e: reqwest::Error| format!("Couldn't download jdtls from {JDTLS_URL}: {e}");
    let bytes = reqwest::Client::new()
        .get(JDTLS_URL)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(download_error)?
        .bytes()
        .await
        .map_err(download_error)?;

    tauri::async_runtime::spawn_blocking(move || unpack_jdtls(&bytes, &target))
        .await
        .map_err(|e| e.to_string())?
}

/// Unpacks a jdtls `.tar.gz` into `target`, replacing any previous install
/// only once the new one is complete.
fn unpack_jdtls(archive: &[u8], target: &Path) -> Result<(), String> {
    let staging = target.with_extension("partial");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    // `unpack` refuses entries that would land outside `staging` (`..`, absolute paths).
    tar::Archive::new(flate2::read::GzDecoder::new(archive))
        .unpack(&staging)
        .map_err(|e| format!("Couldn't unpack jdtls: {e}"))?;
    if launcher_jar(&staging).is_none() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("The downloaded jdtls archive has no Equinox launcher".to_string());
    }
    let _ = std::fs::remove_dir_all(target);
    std::fs::rename(&staging, target).map_err(|e| e.to_string())
}

/// `plugins/org.eclipse.equinox.launcher_<version>.jar` (not the per-platform
/// `launcher.<ws>.<os>` fragments).
fn launcher_jar(home: &Path) -> Option<PathBuf> {
    std::fs::read_dir(home.join("plugins"))
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                n.starts_with("org.eclipse.equinox.launcher_") && n.ends_with(".jar")
            })
        })
}

/// The jdtls configuration folder for a platform (`std::env::consts` names).
fn jdtls_config_dir(os: &str, arch: &str) -> &'static str {
    match (os, arch) {
        ("windows", _) => "config_win",
        ("macos", "aarch64") => "config_mac_arm",
        ("macos", _) => "config_mac",
        (_, "aarch64") => "config_linux_arm",
        _ => "config_linux",
    }
}

/// The `java` arguments the official `jdtls` Python wrapper uses, minus the
/// Python: the shared configuration stays read-only, per-user state goes
/// elsewhere, and `-data` is appended by data_dir_args.
fn jdtls_args(home: &Path, jar: &Path, config_dir: &str) -> Vec<String> {
    let config = home.join(config_dir);
    vec![
        "-Declipse.application=org.eclipse.jdt.ls.core.id1".into(),
        "-Dosgi.bundles.defaultStartLevel=4".into(),
        "-Declipse.product=org.eclipse.jdt.ls.core.product".into(),
        "-Dosgi.checkConfiguration=true".into(),
        format!(
            "-Dosgi.sharedConfiguration.area={}",
            config.to_string_lossy()
        ),
        "-Dosgi.sharedConfiguration.area.readOnly=true".into(),
        "-Dosgi.configuration.cascaded=true".into(),
        "--add-modules=ALL-SYSTEM".into(),
        "--add-opens".into(),
        "java.base/java.util=ALL-UNNAMED".into(),
        "--add-opens".into(),
        "java.base/java.lang=ALL-UNNAMED".into(),
        "-jar".into(),
        jar.to_string_lossy().into_owned(),
    ]
}

/// The managed jdtls, if lsp_install put one in the app data folder. Needs a
/// Java of at least JAVA_MIN_MAJOR to run: `tool-missing:java:…` otherwise.
fn managed_jdtls_launch(app: &AppHandle) -> Result<Option<Launch>, String> {
    let home = managed_jdtls_dir(app)?;
    let Some(jar) = launcher_jar(&home) else {
        return Ok(None);
    };
    let recipe = recipe_for("java").ok_or("not-installable")?;
    let java = find_java(recipe)?;
    let config = jdtls_config_dir(std::env::consts::OS, std::env::consts::ARCH);
    Ok(Some(Launch {
        name: "jdtls",
        args: jdtls_args(&home, &jar, config),
        path: path_with(Path::new(&java)),
        program: java,
        initialization_options: None,
    }))
}

/// A `java` of at least JAVA_MIN_MAJOR: $JAVA_HOME's, then the usual lookup.
fn find_java(recipe: &Recipe) -> Result<String, String> {
    let exe = if host_os() == HostOs::Windows {
        "java.exe"
    } else {
        "java"
    };
    let java = std::env::var_os("JAVA_HOME")
        .map(|home| PathBuf::from(home).join("bin").join(exe))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| locate("java").map(|(binary, _)| binary))
        .ok_or_else(|| tool_missing(recipe))?;

    let mut command = Command::new(&java);
    crate::appimage::clean_command(&mut command);
    hide_console(&mut command);
    let output = command
        .arg("-version")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| tool_missing(recipe))?;
    // `java -version` prints to stderr.
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    match java_major(&text) {
        Some(major) if major >= JAVA_MIN_MAJOR => Ok(java),
        Some(major) => Err(format!("{}; found Java {major}", tool_missing(recipe))),
        None => Err(tool_missing(recipe)),
    }
}

/// The major version in `java -version` output: `"21.0.2"` → 21, `"1.8.0_402"` → 8.
fn java_major(version_output: &str) -> Option<u32> {
    let rest = &version_output[version_output.find("version \"")? + "version \"".len()..];
    let version = &rest[..rest.find('"')?];
    let mut parts = version.split(['.', '-', '+', '_']);
    match parts.next()? {
        "1" => parts.next()?.parse().ok(),
        major => major.parse().ok(),
    }
}

// ---- Vue ------------------------------------------------------------------

/// `initialize` options for vue-language-server 2.x: its own (non-hybrid)
/// TypeScript support, loading TypeScript from `tsdk`.
fn vue_initialization_options(tsdk: &Path) -> serde_json::Value {
    serde_json::json!({
        "typescript": { "tsdk": tsdk.to_string_lossy() },
        "vue": { "hybridMode": false },
    })
}

/// TypeScript's `lib` folder for the Vue server: the project's own first,
/// then one installed globally next to the server.
fn find_tsdk(root: &Path, server_binary: &Path) -> Option<PathBuf> {
    tsdk_candidates(root, server_binary)
        .into_iter()
        .find(|dir| dir.join("typescript.js").is_file())
}

fn tsdk_candidates(root: &Path, server_binary: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![root.join("node_modules").join("typescript").join("lib")];
    // Unix: <prefix>/bin/vue-language-server links into
    // <prefix>/lib/node_modules/@vue/language-server/…; the node_modules
    // folder that holds the server also holds a global typescript.
    let real = server_binary
        .canonicalize()
        .unwrap_or_else(|_| server_binary.to_path_buf());
    candidates.extend(
        real.ancestors()
            .filter(|dir| dir.file_name().is_some_and(|n| n == "node_modules"))
            .map(|dir| dir.join("typescript").join("lib")),
    );
    if let Some(bin) = server_binary.parent() {
        // Windows: <prefix>\vue-language-server.cmd with <prefix>\node_modules.
        candidates.push(bin.join("node_modules").join("typescript").join("lib"));
        candidates.push(
            bin.join("..")
                .join("lib")
                .join("node_modules")
                .join("typescript")
                .join("lib"),
        );
    }
    candidates
}

#[tauri::command(async)]
pub fn lsp_send(
    registry: State<'_, LspRegistry>,
    language: String,
    message: String,
) -> Result<(), String> {
    // Hold the registry lock only to find the pipe: a server busy indexing can
    // leave a write blocked, and that must not stall the other languages.
    let stdin = {
        let servers = registry.servers.lock().map_err(|e| e.to_string())?;
        let server = servers
            .get(&language)
            .ok_or_else(|| format!("{language} server is not running"))?;
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
    let removed = registry
        .servers
        .lock()
        .ok()
        .and_then(|mut servers| servers.remove(language));
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

/// Finds a server binary or developer tool: `(path, is_shim)`, where a shim
/// is a Windows `.cmd`/`.bat` launcher (see command_for_binary).
fn locate(name: &str) -> Option<(String, bool)> {
    match host_os() {
        // npm/pip global installs on Windows are `.cmd`/`.bat` shims, not the
        // login-shell/nvm dance `resolve_binary` does for Unix.
        HostOs::Windows => {
            let env = |key: &str| std::env::var(key).ok();
            let mut search = std::env::var("PATH").unwrap_or_default();
            for dir in tool_dirs(HostOs::Windows, &env) {
                search.push(';');
                search.push_str(&dir);
            }
            resolve_binary_windows(name, &search, &|p| Path::new(p).is_file())
        }
        HostOs::Unix => {
            resolve_binary(name).map(|binary| (binary.to_string_lossy().into_owned(), false))
        }
    }
}

/// Finds a server binary on Unix. GUI launches don't inherit the shell's
/// PATH, and npm globals under nvm/fnm are only on PATH once the shell rc has
/// run. (Windows has its own resolve_binary_windows below: no login shell,
/// no nvm, and a `.cmd`/`.bat` shim needs different handling to spawn.)
fn resolve_binary(name: &str) -> Option<PathBuf> {
    find_in_path(name, &std::env::var("PATH").unwrap_or_default())
        .or_else(|| from_login_shell(name))
        .or_else(|| from_node_managers(name))
        .or_else(|| from_tool_dirs(name))
}

fn from_tool_dirs(name: &str) -> Option<PathBuf> {
    let env = |key: &str| std::env::var(key).ok();
    tool_dirs(HostOs::Unix, &env)
        .into_iter()
        .map(|dir| PathBuf::from(dir).join(name))
        .find(|p| is_executable(p))
}

/// Where developer tools install binaries that a GUI launch rarely has on
/// PATH: `go install` ($GOBIN, every $GOPATH entry's bin, ~/go/bin), rustup
/// ($CARGO_HOME/bin, ~/.cargo/bin), plus Homebrew on Unix and npm's global
/// folder on Windows. Plain strings with `env` injected, so the Windows
/// layout is testable on any host (see resolve_binary_windows).
fn tool_dirs(os: HostOs, env: &dyn Fn(&str) -> Option<String>) -> Vec<String> {
    let (sep, list_sep, home) = match os {
        HostOs::Windows => ('\\', ';', env("USERPROFILE")),
        HostOs::Unix => ('/', ':', env("HOME")),
    };
    let join =
        |dir: &str, child: &str| format!("{}{sep}{child}", dir.trim_end_matches(['/', '\\']));
    let mut dirs: Vec<String> = Vec::new();
    dirs.extend(env("GOBIN"));
    if let Some(gopath) = env("GOPATH") {
        dirs.extend(
            gopath
                .split(list_sep)
                .filter(|p| !p.is_empty())
                .map(|p| join(p, "bin")),
        );
    }
    dirs.extend(env("CARGO_HOME").map(|c| join(&c, "bin")));
    if let Some(home) = &home {
        dirs.push(join(home, &format!("go{sep}bin")));
        dirs.push(join(home, &format!(".cargo{sep}bin")));
    }
    match os {
        HostOs::Windows => dirs.extend(env("APPDATA").map(|a| join(&a, "npm"))),
        HostOs::Unix => {
            dirs.extend(home.map(|h| join(&h, ".linuxbrew/bin")));
            dirs.extend(
                [
                    "/home/linuxbrew/.linuxbrew/bin",
                    "/opt/homebrew/bin",
                    "/usr/local/bin",
                ]
                .map(String::from),
            );
        }
    }
    dirs
}

fn find_in_path(name: &str, path_var: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var)
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
}

fn from_login_shell(name: &str) -> Option<PathBuf> {
    // -i as well as -l: nvm is loaded from .bashrc, which only runs interactively.
    let mut command = Command::new("bash");
    crate::appimage::clean_command(&mut command);
    let output = command
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

/// Node version managers keep each Node (and its npm globals) in its own
/// folder: nvm's `versions/node/<v>/bin`, fnm's `node-versions/<v>/installation/bin`.
fn from_node_managers(name: &str) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/share"));
    let mut roots: Vec<(PathBuf, &str)> = vec![(home.join(".nvm/versions/node"), "bin")];
    let fnm_dirs = [
        std::env::var_os("FNM_DIR").map(PathBuf::from),
        Some(data_home.join("fnm")),
        Some(home.join(".fnm")),
        Some(home.join("Library/Application Support/fnm")),
    ];
    roots.extend(
        fnm_dirs
            .into_iter()
            .flatten()
            .map(|dir| (dir.join("node-versions"), "installation/bin")),
    );
    roots.into_iter().find_map(|(versions, bin)| {
        std::fs::read_dir(versions)
            .ok()?
            .flatten()
            .map(|version| version.path().join(bin).join(name))
            .find(|p| is_executable(p))
    })
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
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
fn resolve_binary_windows(
    name: &str,
    path_var: &str,
    exists: &dyn Fn(&str) -> bool,
) -> Option<(String, bool)> {
    const EXTENSIONS: &[&str] = &["exe", "cmd", "bat"];
    path_var
        .split(';')
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .find_map(|dir| {
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
fn command_for_binary(
    binary: &str,
    is_shim: bool,
    comspec: &str,
    extra_args: &[&str],
) -> (String, Vec<String>) {
    if is_shim {
        let mut args = vec!["/C".to_string(), binary.to_string()];
        args.extend(extra_args.iter().map(|s| s.to_string()));
        (comspec.to_string(), args)
    } else {
        (
            binary.to_string(),
            extra_args.iter().map(|s| s.to_string()).collect(),
        )
    }
}

// npm-installed servers start with `#!/usr/bin/env node`: node lives next to
// them (nvm), so that folder goes first on the child's PATH.
/// PATH for a server. gopls only works when it can run `go`, which may live
/// somewhere a GUI launch doesn't see (Homebrew, ~/sdk).
fn server_path(language: &str, binary: &str) -> std::ffi::OsString {
    let path = path_with(Path::new(binary));
    let go_dir = (language == "go" && matches!(host_os(), HostOs::Unix))
        .then(|| resolve_binary("go"))
        .flatten()
        .and_then(|go| go.parent().map(Path::to_path_buf));
    match go_dir {
        Some(dir) => {
            let mut dirs = vec![dir];
            dirs.extend(std::env::split_paths(&path));
            std::env::join_paths(dirs).unwrap_or(path)
        }
        None => path,
    }
}

fn path_with(binary: &Path) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = binary.parent().map(Path::to_path_buf).into_iter().collect();
    let path = crate::appimage::without_appdir(std::env::var_os("PATH").unwrap_or_default());
    dirs.extend(std::env::split_paths(&path));
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
    let dir = cache
        .join("codenxg/jdtls")
        .join(format!("{:016x}", fnv1a(root.to_string_lossy().as_bytes())));
    vec!["-data".into(), dir.to_string_lossy().into_owned()]
}

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |hash, b| {
        (hash ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        command_for_binary, find_in_path, install_display, java_major, jdtls_args,
        jdtls_config_dir, launcher_jar, not_installed_error, read_message, recipe_for,
        resolve_binary, resolve_binary_windows, tail, tool_dirs, tool_missing, tsdk_candidates,
        unpack_jdtls, vue_initialization_options, write_message, HostOs, Install, RECIPES, SERVERS,
    };
    use std::io::{BufReader, Cursor};
    use std::path::Path;

    #[test]
    fn frames_round_trip() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, r#"{"id":1,"text":"ñ"}"#).unwrap();
        write_message(&mut buffer, r#"{"id":2}"#).unwrap();

        let mut reader = BufReader::new(Cursor::new(buffer));
        assert_eq!(
            read_message(&mut reader).unwrap().unwrap(),
            r#"{"id":1,"text":"ñ"}"#
        );
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), r#"{"id":2}"#);
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn content_length_counts_bytes_not_characters() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, "\"ñ\"").unwrap();
        assert!(String::from_utf8(buffer)
            .unwrap()
            .starts_with("Content-Length: 4\r\n"));
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
    fn every_server_language_has_a_recipe() {
        for (language, _) in SERVERS {
            let recipe =
                recipe_for(language).unwrap_or_else(|| panic!("{language} has no install recipe"));
            let error = not_installed_error(language);
            assert!(error.len() > "not-installed:".len(), "{language}: {error}");
            match recipe.install {
                Install::Manual { hint } => assert!(!hint.is_empty(), "{language}"),
                _ => assert!(
                    !recipe.tool.is_empty() && !recipe.requires.is_empty(),
                    "{language} must say what it requires"
                ),
            }
        }
    }

    #[test]
    fn every_recipe_is_for_a_served_language() {
        for recipe in RECIPES {
            assert!(
                SERVERS.iter().any(|(id, _)| *id == recipe.language),
                "{} is not in SERVERS",
                recipe.language
            );
        }
    }

    #[test]
    fn run_recipes_require_the_program_they_run() {
        for recipe in RECIPES {
            if let Install::Run { program, .. } = recipe.install {
                assert_eq!(recipe.tool, program, "{}", recipe.language);
            }
        }
    }

    #[test]
    fn recipes_are_fixed_commands() {
        assert_eq!(
            install_display(recipe_for("php").unwrap()),
            "npm install -g intelephense"
        );
        assert_eq!(
            install_display(recipe_for("python").unwrap()),
            "npm install -g pyright"
        );
        assert_eq!(
            install_display(recipe_for("go").unwrap()),
            "go install golang.org/x/tools/gopls@latest"
        );
        assert_eq!(
            install_display(recipe_for("rust").unwrap()),
            "rustup component add rust-analyzer"
        );
        assert_eq!(
            install_display(recipe_for("vue").unwrap()),
            "npm install -g @vue/language-server@2 typescript"
        );
        assert_eq!(recipe_for("java").unwrap().install, Install::ManagedJdtls);
    }

    #[test]
    fn unknown_languages_have_no_recipe() {
        for language in [
            "",
            "PHP",
            "typescript",
            "php; rm -rf /",
            "npm install -g evil",
            "../java",
        ] {
            assert!(recipe_for(language).is_none(), "{language}");
        }
    }

    #[test]
    fn not_installed_error_marks_only_installable_languages() {
        assert_eq!(
            not_installed_error("php"),
            "not-installed:installable:npm install -g intelephense"
        );
        assert!(not_installed_error("java")
            .starts_with("not-installed:installable:download https://download.eclipse.org/"));
        assert!(not_installed_error("cpp").starts_with("not-installed:sudo apt install clangd   ("));
        assert_eq!(not_installed_error("nope"), "not-installed:");
    }

    #[test]
    fn tool_missing_names_the_tool_and_what_to_install() {
        assert_eq!(
            tool_missing(recipe_for("php").unwrap()),
            "tool-missing:npm:Node.js with npm (https://nodejs.org)"
        );
        assert!(tool_missing(recipe_for("java").unwrap()).starts_with("tool-missing:java:Java 25"));
        assert!(tool_missing(recipe_for("go").unwrap()).starts_with("tool-missing:go:Go "));
    }

    #[test]
    fn java_major_reads_old_and_new_version_strings() {
        assert_eq!(
            java_major("openjdk version \"21.0.2\" 2024-01-16\nOpenJDK Runtime"),
            Some(21)
        );
        assert_eq!(java_major("java version \"1.8.0_402\""), Some(8));
        assert_eq!(java_major("openjdk version \"17\" 2021-09-14"), Some(17));
        assert_eq!(java_major("openjdk version \"23-ea\""), Some(23));
        assert_eq!(java_major("command not found"), None);
    }

    #[test]
    fn jdtls_config_dir_matches_the_platform() {
        assert_eq!(jdtls_config_dir("linux", "x86_64"), "config_linux");
        assert_eq!(jdtls_config_dir("linux", "aarch64"), "config_linux_arm");
        assert_eq!(jdtls_config_dir("macos", "aarch64"), "config_mac_arm");
        assert_eq!(jdtls_config_dir("macos", "x86_64"), "config_mac");
        assert_eq!(jdtls_config_dir("windows", "x86_64"), "config_win");
    }

    #[test]
    fn jdtls_args_launch_the_equinox_jar_with_the_shared_config() {
        let args = jdtls_args(
            Path::new("/data/jdtls"),
            Path::new("/data/jdtls/plugins/launcher.jar"),
            "config_linux",
        );
        assert!(
            args.contains(&"-Dosgi.sharedConfiguration.area=/data/jdtls/config_linux".to_string())
        );
        assert_eq!(
            args[args.len() - 2..],
            [
                "-jar".to_string(),
                "/data/jdtls/plugins/launcher.jar".to_string()
            ]
        );
    }

    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("codenxg-lsp-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        for (path, data) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn unpack_jdtls_installs_an_archive_with_a_launcher() {
        let dir = scratch_dir("unpack");
        let target = dir.join("jdtls");
        std::fs::create_dir_all(target.join("stale")).unwrap();
        let archive = tar_gz(&[
            ("plugins/org.eclipse.equinox.launcher_1.7.0.jar", b"jar"),
            (
                "plugins/org.eclipse.equinox.launcher.gtk.linux.x86_64_1.2.jar",
                b"fragment",
            ),
            ("config_linux/config.ini", b"x"),
        ]);
        unpack_jdtls(&archive, &target).unwrap();
        assert_eq!(
            launcher_jar(&target).unwrap().file_name().unwrap(),
            "org.eclipse.equinox.launcher_1.7.0.jar"
        );
        assert!(
            !target.join("stale").exists(),
            "the previous install is replaced"
        );
        assert!(!target.with_extension("partial").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unpack_jdtls_keeps_the_old_install_when_the_archive_is_wrong() {
        let dir = scratch_dir("reject");
        let target = dir.join("jdtls");
        std::fs::create_dir_all(target.join("plugins")).unwrap();
        std::fs::write(
            target.join("plugins/org.eclipse.equinox.launcher_1.0.jar"),
            b"old",
        )
        .unwrap();
        assert!(unpack_jdtls(&tar_gz(&[("README", b"no launcher")]), &target).is_err());
        assert!(unpack_jdtls(b"not a tarball", &target).is_err());
        assert!(launcher_jar(&target).is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tool_dirs_cover_go_and_cargo_installs_on_unix() {
        let env = |key: &str| match key {
            "HOME" => Some("/home/u".to_string()),
            "GOPATH" => Some("/gp1:/gp2".to_string()),
            "CARGO_HOME" => Some("/opt/cargo".to_string()),
            _ => None,
        };
        let dirs = tool_dirs(HostOs::Unix, &env);
        for expected in [
            "/gp1/bin",
            "/gp2/bin",
            "/opt/cargo/bin",
            "/home/u/go/bin",
            "/home/u/.cargo/bin",
            "/opt/homebrew/bin",
        ] {
            assert!(
                dirs.contains(&expected.to_string()),
                "{expected} missing from {dirs:?}"
            );
        }
    }

    #[test]
    fn tool_dirs_cover_go_cargo_and_npm_on_windows() {
        let env = |key: &str| match key {
            "USERPROFILE" => Some("C:\\Users\\u".to_string()),
            "GOBIN" => Some("D:\\gobin".to_string()),
            "APPDATA" => Some("C:\\Users\\u\\AppData\\Roaming".to_string()),
            _ => None,
        };
        let dirs = tool_dirs(HostOs::Windows, &env);
        for expected in [
            "D:\\gobin",
            "C:\\Users\\u\\go\\bin",
            "C:\\Users\\u\\.cargo\\bin",
            "C:\\Users\\u\\AppData\\Roaming\\npm",
        ] {
            assert!(
                dirs.contains(&expected.to_string()),
                "{expected} missing from {dirs:?}"
            );
        }
        assert!(!dirs.iter().any(|d| d.contains("homebrew")));
    }

    #[test]
    fn go_install_output_is_found_in_home_go_bin() {
        let home = scratch_dir("gohome");
        let bin = home.join("go/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let gopls = bin.join("gopls");
        std::fs::write(&gopls, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&gopls, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let home_str = home.to_string_lossy().into_owned();
        let env = |key: &str| (key == "HOME").then(|| home_str.clone());
        let found = tool_dirs(HostOs::Unix, &env)
            .into_iter()
            .map(|d| Path::new(&d).join("gopls"))
            .find(|p| p.is_file());
        assert_eq!(found, Some(gopls));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn tsdk_prefers_the_project_then_the_global_node_modules() {
        let dir = scratch_dir("tsdk").canonicalize().unwrap();
        let server =
            dir.join("prefix/lib/node_modules/@vue/language-server/bin/vue-language-server.js");
        std::fs::create_dir_all(server.parent().unwrap()).unwrap();
        std::fs::write(&server, "").unwrap();
        let candidates = tsdk_candidates(&dir.join("project"), &server);
        assert_eq!(
            candidates[0],
            dir.join("project/node_modules/typescript/lib")
        );
        assert!(
            candidates.contains(&dir.join("prefix/lib/node_modules/typescript/lib")),
            "{candidates:?}"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn vue_runs_in_non_hybrid_mode() {
        let options = vue_initialization_options(Path::new("/ts/lib"));
        assert_eq!(options["vue"]["hybridMode"], false);
        assert_eq!(options["typescript"]["tsdk"], "/ts/lib");
    }

    #[test]
    fn tail_keeps_the_last_non_empty_lines() {
        assert_eq!(tail("a\n\nb\nc\n\n", 2), "b\nc");
        assert_eq!(tail("only", 5), "only");
    }

    // End to end against a real server when one is installed (skipped otherwise).
    #[test]
    fn talks_to_a_real_language_server() {
        let Some(binary) = resolve_binary("pyright-langserver") else {
            return;
        };
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
        let _ = child.wait();
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
        let found =
            resolve_binary_windows("jdtls", "C:\\tools", &exists_of(&["C:\\tools\\jdtls.exe"]));
        assert_eq!(found, Some(("C:\\tools\\jdtls.exe".to_string(), false)));
    }

    #[test]
    fn resolve_binary_windows_searches_every_path_entry_in_order() {
        let found = resolve_binary_windows(
            "pyright-langserver",
            "C:\\empty;C:\\npm",
            &exists_of(&["C:\\npm\\pyright-langserver.cmd"]),
        );
        assert_eq!(
            found,
            Some(("C:\\npm\\pyright-langserver.cmd".to_string(), true))
        );
    }

    #[test]
    fn resolve_binary_windows_is_none_when_nothing_matches() {
        assert_eq!(
            resolve_binary_windows("nope", "C:\\a", &exists_of(&[])),
            None
        );
    }

    #[test]
    fn resolve_binary_windows_tolerates_a_trailing_separator_on_a_path_entry() {
        let found = resolve_binary_windows(
            "intelephense",
            "C:\\npm\\",
            &exists_of(&["C:\\npm\\intelephense.cmd"]),
        );
        assert_eq!(found, Some(("C:\\npm\\intelephense.cmd".to_string(), true)));
    }

    #[test]
    fn command_for_binary_wraps_a_shim_with_cmd_c() {
        let (program, args) = command_for_binary(
            "C:\\npm\\intelephense.cmd",
            true,
            "C:\\Windows\\System32\\cmd.exe",
            &["--stdio"],
        );
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
