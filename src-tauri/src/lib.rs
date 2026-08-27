mod db;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let base_dir = dirs::data_local_dir()
                .or_else(dirs::data_dir)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")));
            let db_path = base_dir.join("ops-workbench").join("ops-workbench.sqlite3");
            let app_db = db::AppDb::new(db_path);
            app_db.init()?;
            app.manage(state::AppState::new(app_db));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
