mod commands;
mod db;
mod keyring;
mod ssh;
mod state;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let base_dir = dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
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
            commands::ssh_input,
            commands::ssh_resize,
            commands::ssh_keepalive,
            commands::ssh_status,
            commands::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
