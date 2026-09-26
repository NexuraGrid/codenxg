mod commands;
mod state;

use commands::fs::{
    create_entry, delete_entry, list_files, move_entry, read_dir, read_file, rename_entry, trash_entry,
    write_file,
};
use commands::watcher::{watch_dirs, watch_start, WatcherState};
use commands::workspace::set_workspace;
use commands::git::{
    git_branches, git_checkout, git_commit, git_commit_files, git_create_branch, git_discard, git_fetch, git_init,
    git_log, git_pull, git_push, git_show_at, git_show_head, git_stage, git_stash_and_switch, git_status, git_unstage,
};
use commands::terminal::{close_terminal, create_terminal, resize_terminal, write_to_terminal};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(state::TerminalRegistry::default())
        .manage(state::WorkspaceState::default())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            set_workspace,
            watch_start,
            watch_dirs,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_init,
            git_show_head,
            git_branches,
            git_checkout,
            git_create_branch,
            git_fetch,
            git_log,
            git_commit_files,
            git_show_at,
            git_stash_and_switch,
            read_dir,
            read_file,
            write_file,
            create_entry,
            rename_entry,
            move_entry,
            trash_entry,
            delete_entry,
            list_files,
            create_terminal,
            write_to_terminal,
            resize_terminal,
            close_terminal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
