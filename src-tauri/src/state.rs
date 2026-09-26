use portable_pty::{Child, MasterPty};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use tauri::ipc::Channel;

pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct TerminalSession {
    pub master: Box<dyn MasterPty + Send>,
    /// Locked on its own: a write blocked on a full PTY buffer must not hold
    /// the registry lock and freeze every other terminal.
    pub writer: SharedWriter,
    pub child: Box<dyn Child + Send + Sync>,
    /// Swappable so a remounted terminal view can reattach to a live shell.
    pub channels: Arc<Mutex<SessionChannels>>,
}

pub struct SessionChannels {
    pub output: Channel<String>,
    /// Fired once when the shell exits (typing `exit`, or the tab is closed).
    pub exit: Channel<()>,
}

#[derive(Default)]
pub struct TerminalRegistry {
    pub sessions: Mutex<HashMap<String, TerminalSession>>,
}

/// The folder open in the editor. Filesystem and terminal commands refuse
/// paths outside it, so a compromised webview can't reach the rest of the disk.
#[derive(Default)]
pub struct WorkspaceState {
    pub root: RwLock<Option<PathBuf>>,
}
