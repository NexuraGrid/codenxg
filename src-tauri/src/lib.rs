mod appimage;
mod commands;
mod state;

use commands::cli_install::install_cli;
use commands::fs::{
    create_entry, delete_entry, list_files, move_entry, read_dir, read_file, rename_entry,
    trash_entry, write_file,
};
use commands::git::{
    git_branches, git_checkout, git_commit, git_commit_files, git_create_branch, git_discard,
    git_fetch, git_init, git_log, git_pull, git_push, git_show_at, git_show_head, git_stage,
    git_stash_and_switch, git_stash_apply, git_stash_drop, git_stash_file_diff, git_stash_files,
    git_stash_list, git_stash_pop, git_stash_push, git_status, git_unstage,
};
use commands::image::read_image_data;
use commands::launch::{folder_from_args, launch_folder};
use commands::lsp::{lsp_install, lsp_send, lsp_start, lsp_stop, LspRegistry};
use commands::search::{search_in_workspace, write_search_files};
use commands::settings::{
    read_settings, read_workspaces_state, write_settings, write_workspaces_state,
};
use commands::terminal::{close_terminal, create_terminal, resize_terminal, write_to_terminal};
use commands::watcher::{watch_dirs, watch_start, WatcherState};
use commands::workspace::set_workspace;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    appimage::prefer_system_wayland();
    tauri::Builder::default()
        // Must be first: a second `codenxg <folder>` hands its folder to the
        // running window instead of opening another one.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            if let Some(folder) = folder_from_args(&args, &cwd) {
                let _ = app.emit("open-folder", folder);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state::TerminalRegistry::default())
        .manage(state::WorkspaceState::default())
        .manage(WatcherState::default())
        .manage(LspRegistry::default())
        .invoke_handler(tauri::generate_handler![
            set_workspace,
            launch_folder,
            install_cli,
            appimage::updates_supported,
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
            git_stash_list,
            git_stash_push,
            git_stash_apply,
            git_stash_pop,
            git_stash_drop,
            git_stash_files,
            git_stash_file_diff,
            lsp_start,
            lsp_install,
            lsp_send,
            lsp_stop,
            read_dir,
            read_file,
            read_image_data,
            write_file,
            create_entry,
            rename_entry,
            move_entry,
            trash_entry,
            delete_entry,
            list_files,
            search_in_workspace,
            write_search_files,
            create_terminal,
            write_to_terminal,
            resize_terminal,
            close_terminal,
            read_settings,
            write_settings,
            read_workspaces_state,
            write_workspaces_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
