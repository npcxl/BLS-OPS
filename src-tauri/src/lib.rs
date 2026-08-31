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
            eprintln!("[setup] db_path = {:?}", db_path);
            let app_db = db::AppDb::new(db_path.clone());
            if let Err(e) = app_db.init() {
                eprintln!("[setup] DB init failed: {:#}", e);
                return Err(e.into());
            }
            eprintln!("[setup] DB init OK at {:?}", db_path);
            app.manage(state::AppState::new(app_db));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::server_list,
            commands::server_get,
            commands::server_save,
            commands::server_delete,
            commands::credential_list,
            commands::credential_save,
            commands::credential_delete,
            commands::known_host_list,
            commands::known_host_get,
            commands::known_host_save,
            commands::known_host_confirm,
            commands::audit_log_list,
            commands::audit_log_record,
            commands::history_record,
            commands::history_list,
            commands::credential_save_secret,
            commands::credential_get_secret,
            commands::credential_delete_secret,
            commands::ssh_connect,
            commands::ssh_input,
            commands::ssh_resize,
            commands::ssh_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
