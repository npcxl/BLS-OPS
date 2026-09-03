/// First/second-layer server capability recognition — the P3 pipeline start.
pub mod capability_probe;
mod commands;
mod db;
/// Fourth-layer deployment adapter registry.
pub mod deployment_adapter;
/// Round 1 of project discovery: enumerate real deployment instances.
pub mod deployment_collector;
/// On-demand directory-size calculation (SFTP `du` / recursive walk).
pub mod dirsize;
/// Container and image management over the live session (P3-1.3).
pub mod docker;
/// journald log querying (P3-1.2).
pub mod journal;
mod keyring;
/// Public so the integration tests in `tests/` can drive the real monitoring
/// layer against an in-process SSH server.
pub mod monitor;
/// Nginx site and configuration management (P3-1.4).
pub mod nginx;
pub mod project_discovery;
/// 项目级部署准备检查（针对单个项目，而非全局可行性图谱）。纯逻辑，无 I/O。
pub mod project_readiness;
/// Shared helpers for running fixed commands on a session.
pub mod remote;
/// The security boundary: every management command is built here (P3-2.4).
pub mod safe;
/// 服务识别目录与宿主路径归属判定（P3 只读判定的单一事实来源：
/// 镜像 / 单元 / 端口 → 服务，路径 → 系统目录还是项目根）。纯判定，零 I/O。
pub mod service_catalog;
/// Public so the integration tests in `tests/` can drive the real SSH layer.
pub mod ssh;
mod state;
/// systemd service management (P3-1.1).
pub mod systemd;
/// 实例业务分类器：应用服务 / 基础设施 / 系统组件 / 待归类 四个互斥集合。
/// 只在后端做判定，React 只展示结果。纯逻辑，零 I/O。
pub mod workload_class;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Native open/save dialogs: the file panel needs "upload" to work from
        // a click, not only from a drag & drop.
        .plugin(tauri_plugin_dialog::init())
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
            commands::sftp_read_binary,
            commands::sftp_download_file,
            // directory size (on-demand, background)
            commands::directory_size_start,
            commands::directory_size_cancel,
            commands::directory_size_status,
            // services — systemd (P3-1.1)
            commands::service_list,
            commands::service_action,
            commands::service_status,
            // log centre — journald (P3-1.2)
            commands::journal_query,
            commands::journal_disk_usage,
            // docker (P3-1.3)
            commands::docker_snapshot,
            commands::docker_logs,
            commands::docker_container_action,
            commands::docker_image_remove,
            commands::docker_prune,
            // nginx (P3-1.4)
            commands::nginx_sites,
            commands::nginx_config,
            commands::nginx_save_config,
            commands::nginx_test,
            commands::nginx_reload,
            commands::nginx_set_site_enabled,
            // project discovery (P3 read-only)
            commands::project_scan_start,
            commands::project_scan_cancel,
            commands::project_scan_status,
            commands::project_scan_result,
            commands::capability_profile,
            commands::project_review_set,
            commands::project_review_list,
            commands::project_readiness_check,
            commands::project_inventory_load,
            commands::confirmed_projects_list,
            // legacy project records retained as P5 foundation
            commands::project_list,
            commands::project_get,
            commands::project_save,
            commands::project_delete,
            // deployment IPC is intentionally not exposed in P3; retained as P5 foundation
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
