mod db;
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
