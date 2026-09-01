mod commands;
mod db;
mod keyring;
/// Public so the integration tests in `tests/` can drive the real monitoring
/// layer against an in-process SSH server.
pub mod monitor;
/// Public so the integration tests in `tests/` can drive the real SSH layer.
pub mod ssh;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let base_dir = dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .unwrap_or_else(|| {
                    std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
                });
            let db_path = base_dir.join("ops-workbench").join("ops-workbench.sqlite3");
            let app_db = db::AppDb::new(db_path.clone());
            if let Err(e) = app_db.init() {
                eprintln!("[setup] DB init failed: {:#}", e);
                return Err(e.into());
            }
            app.manage(state::AppState::new(app_db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // diagnostics
            commands::app_info,
            // servers
            commands::server_list,
            commands::server_get,
            commands::server_save,
            commands::server_delete,
            commands::server_set_favorite,
            commands::server_test_connection,
            commands::group_list,
            commands::group_save,
            commands::group_delete,
            // credentials — note: there is deliberately no way to read a secret
            // back into the WebView.
            commands::credential_list,
            commands::credential_save,
            commands::credential_delete,
            // known hosts
            commands::known_host_list,
            commands::known_host_get,
            commands::known_host_delete,
            commands::known_host_trust,
            // sessions / history / audit
            commands::session_list,
            commands::session_stats,
            commands::history_record,
            commands::history_list,
            commands::audit_log_list,
            // ssh
            commands::ssh_connect,
            commands::ssh_connect_monitor,
            commands::ssh_input,
            commands::ssh_resize,
            commands::ssh_keepalive,
            commands::ssh_status,
            commands::ssh_disconnect,
            // monitoring — read-only Linux metrics, fixed built-in commands
            commands::monitor_system_info,
            commands::monitor_cpu,
            commands::monitor_memory,
            commands::monitor_disks,
            commands::monitor_network,
            commands::monitor_processes,
            commands::monitor_snapshot,
            // sftp — file browsing and management over the live session
            commands::sftp_open,
            commands::sftp_list_dir,
            commands::sftp_realpath,
            commands::sftp_stat,
            commands::sftp_close,
            commands::sftp_upload,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_copy,
            commands::sftp_mkdir,
            commands::sftp_touch,
            commands::sftp_read_file,
            commands::sftp_write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
