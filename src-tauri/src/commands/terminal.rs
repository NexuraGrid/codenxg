use super::shell::{env_lookup, host_os, program_exists, resolve_shell, wants_term_env};
use super::workspace::ensure_in_workspace;
use crate::state::{SessionChannels, TerminalRegistry, TerminalSession, WorkspaceState};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

// Large reads mean fewer IPC messages when a command floods the terminal.
const READ_BUFFER_SIZE: usize = 64 * 1024;

// Every terminal command is `async`: Tauri runs synchronous commands on the
// main thread, so each keystroke would otherwise compete with the UI.
#[tauri::command(async)]
pub fn create_terminal(
    app: AppHandle,
    state: State<'_, TerminalRegistry>,
    workspace: State<'_, WorkspaceState>,
    id: String,
    cwd: String,
    rows: u16,
    cols: u16,
    shell_path: Option<String>,
    shell_args: Option<Vec<String>>,
    on_output: Channel<String>,
    on_exit: Channel<()>,
) -> Result<Option<String>, String> {
    let cwd = ensure_in_workspace(&workspace, &cwd)?;

    // StrictMode double-mounts and webview reloads call this for a session
    // that is already alive: reattach its output instead of spawning a shell.
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get(&id) {
            *session.channels.lock().map_err(|e| e.to_string())? = SessionChannels {
                output: on_output,
                exit: on_exit,
            };
            return Ok(None);
        }
    }

    let pty_system = native_pty_system();
    // Spawn at the size the frontend already measured: starting at 80x24 and
    // resizing right after makes the shell repaint its prompt (duplicates).
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let resolution = resolve_shell(
        host_os(),
        shell_path.as_deref(),
        &shell_args.unwrap_or_default(),
        &env_lookup,
        &program_exists,
    );
    let mut cmd = CommandBuilder::new(&resolution.shell.program);
    cmd.args(&resolution.shell.args);
    cmd.cwd(cwd);
    // Most CLI tools (and the shell's own prompt) probe TERM to decide what
    // they can draw; cmd.exe is the one shell here that doesn't use it.
    if wants_term_env(&resolution.shell.program) {
        cmd.env("TERM", "xterm-256color");
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Drop our copy of the slave end now that the child owns it — otherwise
    // the master's reader never sees EOF when the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let channels = Arc::new(Mutex::new(SessionChannels {
        output: on_output,
        exit: on_exit,
    }));

    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
                channels: Arc::clone(&channels),
            },
        );
    }

    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_BUFFER_SIZE];
        // A read can end in the middle of a multi-byte UTF-8 character; carry
        // the incomplete tail into the next read instead of emitting U+FFFD.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let chunk = take_decodable(&mut pending);
                    if chunk.is_empty() {
                        continue;
                    }
                    // A failed send means the webview went away (reload); keep
                    // reading so the shell never blocks on a full PTY buffer.
                    if let Ok(channels) = channels.lock() {
                        let _ = channels.output.send(chunk);
                    }
                }
                Err(_) => break,
            }
        }

        // The shell is gone: reap it (no zombie) and let the view drop its tab.
        // close_terminal may already have removed it; that's fine.
        let removed = app
            .state::<TerminalRegistry>()
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&id));
        if let Some(mut session) = removed {
            let _ = session.child.wait();
        }
        if let Ok(channels) = channels.lock() {
            let _ = channels.exit.send(());
        }
    });

    Ok(resolution.warning)
}

#[tauri::command(async)]
pub fn write_to_terminal(
    state: State<'_, TerminalRegistry>,
    id: String,
    data: String,
) -> Result<(), String> {
    // Only hold the registry lock to find the writer: the write itself can
    // block while the shell is busy, and must not stall other terminals.
    let writer = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions
            .get(&id)
            .ok_or_else(|| "terminal session not found".to_string())?;
        Arc::clone(&session.writer)
    };
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn resize_terminal(
    state: State<'_, TerminalRegistry>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get(&id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn close_terminal(state: State<'_, TerminalRegistry>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let removed = sessions.remove(&id);
    // Release the registry before waiting on the process.
    drop(sessions);
    if let Some(mut session) = removed {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

/// Drains the decodable part of `pending`. An incomplete sequence at the end
/// stays buffered for the next read; genuinely invalid bytes become U+FFFD.
fn take_decodable(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                return out;
            }
            Err(err) => {
                let valid = err.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).expect("prefix is valid UTF-8"));
                match err.error_len() {
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(len) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + len);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::take_decodable;

    #[test]
    fn keeps_split_multibyte_char_until_complete() {
        let prompt = "⋊> ok".as_bytes();
        let mut pending = prompt[..2].to_vec();

        assert_eq!(take_decodable(&mut pending), "");
        assert_eq!(pending, prompt[..2]);

        pending.extend_from_slice(&prompt[2..]);
        assert_eq!(take_decodable(&mut pending), "⋊> ok");
        assert!(pending.is_empty());
    }

    #[test]
    fn emits_complete_prefix_and_buffers_the_tail() {
        let bytes = "ab◦".as_bytes();
        let mut pending = bytes[..3].to_vec();

        assert_eq!(take_decodable(&mut pending), "ab");
        assert_eq!(pending, bytes[2..3]);
    }

    #[test]
    fn replaces_invalid_bytes_and_keeps_going() {
        let mut pending = vec![b'a', 0xFF, b'b'];

        assert_eq!(take_decodable(&mut pending), "a\u{FFFD}b");
        assert!(pending.is_empty());
    }
}
