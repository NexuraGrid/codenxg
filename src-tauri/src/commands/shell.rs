use std::path::Path;

/// Which shell-resolution rules apply. Kept as data (not `cfg!(windows)`)
/// so the Windows branch is exercised by `cargo test` on every host.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum HostOs {
    Windows,
    Unix,
}

/// The OS this build runs on. `cfg!` rather than two `#[cfg]` bodies, so both
/// variants are constructed (no dead-code warning) whatever the target.
pub fn host_os() -> HostOs {
    if cfg!(windows) {
        HostOs::Windows
    } else {
        HostOs::Unix
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedShell {
    pub program: String,
    pub args: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ShellResolution {
    pub shell: ResolvedShell,
    /// Set when a configured shell was rejected (not found) and auto-detection took over.
    pub warning: Option<String>,
}

/// Chooses the shell to spawn a terminal with: the user's configured
/// program/args if it points at something that exists, otherwise the
/// platform default — Windows: `pwsh.exe` > `powershell.exe` > `%COMSPEC%`/
/// `cmd.exe`; Unix: `$SHELL` > `/bin/bash` > `/bin/sh`.
///
/// `env`/`exists` are injected rather than read from the real environment so
/// every branch, including the Windows one, is unit-testable on any host.
pub fn resolve_shell(
    os: HostOs,
    configured_program: Option<&str>,
    configured_args: &[String],
    env: &dyn Fn(&str) -> Option<String>,
    exists: &dyn Fn(&str) -> bool,
) -> ShellResolution {
    let configured = configured_program.map(str::trim).filter(|p| !p.is_empty());

    let Some(program) = configured else {
        return ShellResolution { shell: auto_detect(os, env, exists), warning: None };
    };

    if exists(program) {
        return ShellResolution {
            shell: ResolvedShell { program: program.to_string(), args: configured_args.to_vec() },
            warning: None,
        };
    }

    let fallback = auto_detect(os, env, exists);
    ShellResolution {
        warning: Some(format!("Configured shell \"{program}\" was not found; using \"{}\" instead.", fallback.program)),
        shell: fallback,
    }
}

fn auto_detect(os: HostOs, env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&str) -> bool) -> ResolvedShell {
    match os {
        HostOs::Windows => windows_default(env, exists),
        HostOs::Unix => unix_default(env, exists),
    }
}

fn windows_default(env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&str) -> bool) -> ResolvedShell {
    if exists("pwsh.exe") {
        return ResolvedShell { program: "pwsh.exe".into(), args: vec!["-NoLogo".into()] };
    }
    if exists("powershell.exe") {
        return ResolvedShell { program: "powershell.exe".into(), args: vec!["-NoLogo".into()] };
    }
    let comspec = non_empty(env("COMSPEC")).unwrap_or_else(|| "cmd.exe".to_string());
    ResolvedShell { program: comspec, args: Vec::new() }
}

fn unix_default(env: &dyn Fn(&str) -> Option<String>, exists: &dyn Fn(&str) -> bool) -> ResolvedShell {
    if let Some(shell) = non_empty(env("SHELL")) {
        return ResolvedShell { program: shell, args: Vec::new() };
    }
    if exists("/bin/bash") {
        return ResolvedShell { program: "/bin/bash".into(), args: Vec::new() };
    }
    ResolvedShell { program: "/bin/sh".into(), args: Vec::new() }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Whether TERM should be set for the resolved shell: cmd.exe doesn't use it
/// (and some batch scripts branch on its absence), pwsh/powershell/every
/// Unix shell benefit from it like any other terminal application.
///
/// Splits on both `/` and `\` by hand rather than `std::path::Path`: that
/// only recognises `\` as a separator when actually compiled for Windows, so
/// it can't be used to inspect a Windows-shaped path (e.g. a configured
/// `C:\Windows\System32\cmd.exe`) from a build running on Unix.
pub fn wants_term_env(program: &str) -> bool {
    let file_name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let stem = file_name.strip_suffix(".exe").or_else(|| file_name.strip_suffix(".EXE")).unwrap_or(file_name);
    !stem.eq_ignore_ascii_case("cmd")
}

/// True if `program` names something that actually exists: a direct file
/// check when it looks like a path (has a separator, or is absolute —
/// covers however a user typed a configured shell path), otherwise a PATH
/// search for a bare command name (covers auto-detecting "pwsh.exe").
pub fn program_exists(program: &str) -> bool {
    let path = Path::new(program);
    if program.contains('/') || program.contains('\\') || path.is_absolute() {
        return is_executable_file(path);
    }
    std::env::var("PATH")
        .ok()
        .map(|path_var| std::env::split_paths(&path_var).any(|dir| is_executable_file(&dir.join(program))))
        .unwrap_or(false)
}

fn is_executable_file(path: &Path) -> bool {
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

pub fn env_lookup(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |key| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.to_string())
    }

    fn exists_of(names: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |name| names.contains(&name)
    }

    #[test]
    fn windows_prefers_pwsh_when_present() {
        let resolution = resolve_shell(HostOs::Windows, None, &[], &env_of(&[]), &exists_of(&["pwsh.exe", "powershell.exe"]));
        assert_eq!(resolution.shell, ResolvedShell { program: "pwsh.exe".into(), args: vec!["-NoLogo".into()] });
        assert!(resolution.warning.is_none());
    }

    #[test]
    fn windows_falls_back_to_powershell_without_pwsh() {
        let resolution = resolve_shell(HostOs::Windows, None, &[], &env_of(&[]), &exists_of(&["powershell.exe"]));
        assert_eq!(resolution.shell, ResolvedShell { program: "powershell.exe".into(), args: vec!["-NoLogo".into()] });
    }

    #[test]
    fn windows_falls_back_to_comspec_without_either_powershell() {
        let resolution = resolve_shell(HostOs::Windows, None, &[], &env_of(&[("COMSPEC", "C:\\Windows\\System32\\cmd.exe")]), &exists_of(&[]));
        assert_eq!(resolution.shell, ResolvedShell { program: "C:\\Windows\\System32\\cmd.exe".into(), args: vec![] });
    }

    #[test]
    fn windows_defaults_comspec_to_cmd_exe_when_unset() {
        let resolution = resolve_shell(HostOs::Windows, None, &[], &env_of(&[]), &exists_of(&[]));
        assert_eq!(resolution.shell.program, "cmd.exe");
    }

    #[test]
    fn unix_uses_shell_env_var_when_set() {
        let resolution = resolve_shell(HostOs::Unix, None, &[], &env_of(&[("SHELL", "/usr/bin/zsh")]), &exists_of(&["/bin/bash"]));
        assert_eq!(resolution.shell, ResolvedShell { program: "/usr/bin/zsh".into(), args: vec![] });
    }

    #[test]
    fn unix_falls_back_to_bash_without_shell_env_var() {
        let resolution = resolve_shell(HostOs::Unix, None, &[], &env_of(&[]), &exists_of(&["/bin/bash"]));
        assert_eq!(resolution.shell.program, "/bin/bash");
    }

    #[test]
    fn unix_falls_back_to_sh_when_neither_is_available() {
        let resolution = resolve_shell(HostOs::Unix, None, &[], &env_of(&[]), &exists_of(&[]));
        assert_eq!(resolution.shell.program, "/bin/sh");
    }

    #[test]
    fn uses_the_configured_shell_and_args_when_it_exists() {
        let args = vec!["-l".to_string()];
        let resolution = resolve_shell(HostOs::Unix, Some("/usr/bin/fish"), &args, &env_of(&[]), &exists_of(&["/usr/bin/fish"]));
        assert_eq!(resolution.shell, ResolvedShell { program: "/usr/bin/fish".into(), args: vec!["-l".into()] });
        assert!(resolution.warning.is_none());
    }

    #[test]
    fn falls_back_and_warns_when_the_configured_shell_is_missing() {
        let resolution = resolve_shell(HostOs::Unix, Some("/usr/bin/fish"), &[], &env_of(&[("SHELL", "/bin/zsh")]), &exists_of(&[]));
        assert_eq!(resolution.shell.program, "/bin/zsh");
        assert_eq!(
            resolution.warning,
            Some("Configured shell \"/usr/bin/fish\" was not found; using \"/bin/zsh\" instead.".to_string())
        );
    }

    #[test]
    fn blank_configured_program_means_auto_detect() {
        let resolution = resolve_shell(HostOs::Unix, Some("   "), &[], &env_of(&[("SHELL", "/bin/zsh")]), &exists_of(&[]));
        assert_eq!(resolution.shell.program, "/bin/zsh");
        assert!(resolution.warning.is_none());
    }

    #[test]
    fn term_env_is_skipped_only_for_cmd() {
        assert!(!wants_term_env("cmd.exe"));
        assert!(!wants_term_env("C:\\Windows\\System32\\cmd.exe"));
        assert!(!wants_term_env("CMD.EXE"));
        assert!(wants_term_env("pwsh.exe"));
        assert!(wants_term_env("powershell.exe"));
        assert!(wants_term_env("/bin/bash"));
    }

    #[test]
    fn program_exists_checks_a_path_directly() {
        assert!(program_exists("/bin/sh"));
        assert!(!program_exists("/definitely/not/a/real/binary"));
    }

    #[test]
    fn program_exists_searches_path_for_a_bare_name() {
        assert!(program_exists("sh"));
        assert!(!program_exists("definitely-not-a-real-binary-name"));
    }
}
