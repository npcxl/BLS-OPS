/// 整机配置备份 / 恢复（服务器、分组、凭据元数据、指纹、项目、设置）。
pub mod backup;
/// First/second-layer server capability recognition — the P3 pipeline start.
pub mod capability_probe;
/// P4 Linux 命令智能中心：知识库、检索与安全执行（P4.0–P4.3）。
pub mod command_center;
mod commands;
/// 高性能数据库工作台（MySQL 原生协议、SSH 隧道、查询任务、CSV 导出）。
pub mod database;
/// 本地 SQLite 持久化。`pub` 是为了让 `tests/` 里的真实集成测试能用与
/// 生产完全相同的 schema/迁移，而不是在测试里手抄一份建表 SQL。
pub mod db;
/// P5.0 智能部署中心领域模型（应用/环境/服务/方案图/运行/版本）。
///
/// 只建模与校验，**不执行任何部署**：模型里没有任何自由文本命令字段，
/// 校验层拒绝一切含 shell 元字符的输入（见模块文档）。
pub mod deployment;
/// Fourth-layer deployment adapter registry.
pub mod deployment_adapter;
/// Round 1 of project discovery: enumerate real deployment instances.
pub mod deployment_collector;
/// On-demand directory-size calculation (SFTP `du` / recursive walk).
pub mod dirsize;
/// Container and image management over the live session (P3-1.3).
pub mod docker;
/// 编辑器历史版本（保存前把旧内容留在本机，支持查看与恢复）。
pub mod editor_history;
/// 本地编辑器同步（VS Code/Cursor 等编辑远程文件，保存自动回传服务器）。
pub mod editor_sync;
/// 服务器运行环境探测（Nginx 在宿主机 / Docker / Compose）。纯逻辑 + 只读采集。
pub mod env_probe;
/// journald log querying (P3-1.2).
pub mod journal;
mod keyring;
/// Public so the integration tests in `tests/` can drive the real monitoring
/// layer against an in-process SSH server.
pub mod monitor;
/// Nginx site and configuration management (P3-1.4).
pub mod nginx;
pub mod output_adapter;
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
/// 文件传输任务中心（上传 / 下载队列，可取消、可重试）。
pub mod transfer;
/// 远程回收站（删除先移动，可恢复）。
pub mod trash;
/// 系统托盘：点 X 隐藏窗口到托盘（不退出），托盘恢复/退出。
mod tray;
/// 实例业务分类器：应用服务 / 基础设施 / 系统组件 / 待归类 四个互斥集合。
/// 只在后端做判定，React 只展示结果。纯逻辑，零 I/O。
pub mod workload_class;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 需要一个进程级 CryptoProvider。reqwest（updater）与 mysql_async
    // 共用同一个 rustls；这里显式安装 ring，避免第一次数据库 TLS 握手时
    // rustls 因“没有默认 provider”而 panic。重复安装返回 Err，忽略即可。
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        // Native open/save dialogs: the file panel needs "upload" to work from
        // a click, not only from a drag & drop.
        .plugin(tauri_plugin_dialog::init())
        // Opens external links (e.g. the GitHub releases page from the updater
        // panel) in the user's real browser. A bare `<a target="_blank">` is a
        // no-op inside the Tauri WebView, which is why the manual-download link
        // used to do nothing. It only ever *opens URLs* — it never launches an
        // installer, so the "no shell.open" rule of the updater still holds.
        .plugin(tauri_plugin_opener::init())
        // Clipboard via Rust instead of `navigator.clipboard`: the WebView's
        // async clipboard API makes WebView2 raise a native permission prompt
        // ("http://tauri.localhost wants to see text and images copied to the
        // clipboard") on every paste. Reading/writing from the Rust side needs
        // no such permission and never prompts.
        .plugin(tauri_plugin_clipboard_manager::init())
        // P5.1 auto-update. Signature verification is **always on**: the public
        // key ships inside `tauri.conf.json` (plugins.updater.pubkey) and is
        // embedded into the binary by `generate_context!`, so a `.sig` it does
        // not match aborts the install. No frontend switch can bypass it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Only used to relaunch the app once an update has been installed.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // 窗口毛玻璃（Windows Acrylic）。
            //
            // 为什么必须在这一层做：CSS 的 `backdrop-filter` 只能模糊 WebView
            // **内部**的内容，模糊不了窗口背后的桌面 —— 纯 CSS 永远做不出磨砂。
            // Acrylic 由 DWM 把窗口背后的桌面模糊掉，页面上的半透明底色只负责
            // 染色（`--app` 的 alpha 越小越透）。
            //
            // 失败不致命：某些 Windows 版本 / 远程桌面会话不支持 Acrylic，
            // 此时退化成普通的半透明背景，界面仍然可用。
            #[cfg(target_os = "windows")]
            {
                use tauri::window::{Effect, EffectState, EffectsBuilder};
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let effects = EffectsBuilder::new()
                        .effect(Effect::Acrylic)
                        .state(EffectState::Active)
                        .build();
                    if let Err(error) = window.set_effects(effects) {
                        eprintln!("[setup] acrylic unavailable, falling back: {error}");
                    }
                }
            }
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
            tray::init(app)?;
            Ok(())
        })
        // 点 X = 隐藏到托盘（SSH 会话保持），**绝不退出**；真正的退出只走
        // 托盘菜单 Quit（tray.rs → app.exit）。这是用户裁决的交互，勿回退。
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            // diagnostics
            commands::app_info,
            // 配置备份 / 恢复（整机迁移）
            commands::backup_export,
            commands::backup_preview,
            commands::backup_import,
            // 外部链接兜底：opener 插件失败时由 Rust 调系统命令打开
            commands::open_external_url,
            // tray menu labels follow the frontend locale
            commands::tray_set_labels,
            // servers
            commands::server_list,
            commands::server_get,
            commands::server_save,
            commands::server_delete,
            commands::server_set_favorite,
            commands::server_move_to_group,
            commands::server_test_connection,
            commands::group_list,
            commands::group_save,
            commands::group_delete,
            // credentials — note: there is deliberately no way to read a secret
            // back into the WebView.
            commands::credential_list,
            commands::credential_save,
            commands::credential_delete,
            // 私钥文件导入：受限读取（大小 + 私钥格式），只返回内容、不落库。
            commands::credential_read_private_key_file,
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
            commands::ssh_cd,
            commands::ssh_resize,
            commands::ssh_set_encoding,
            commands::ssh_get_encoding,
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
            commands::sftp_save_editor_file,
            commands::editor_history_list,
            commands::editor_history_read,
            commands::sftp_read_binary,
            commands::sftp_download_file,
            // 文件传输任务中心
            commands::transfer_upload,
            commands::transfer_download,
            commands::transfer_list,
            commands::transfer_cancel,
            commands::transfer_retry,
            commands::transfer_clear_finished,
            // 回收站：删除默认移动，恢复与永久删除分开
            commands::trash_move,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            // editor sync — open remote files/folders with a local editor
            // (VS Code / Cursor / …) and push saves back over SFTP
            commands::editor_list_available,
            commands::editor_sync_open,
            commands::editor_sync_close,
            commands::editor_sync_list,
            // vscode remote-ssh — open a remote folder in the user's editor
            commands::vscode_open_remote_folder,
            // directory size (on-demand, background)
            commands::directory_size_start,
            commands::directory_size_cancel,
            commands::directory_size_status,
            commands::directory_size_status_many,
            // services — systemd (P3-1.1)
            commands::service_list,
            commands::service_action,
            commands::service_status,
            // log centre — journald (P3-1.2)
            commands::journal_query,
            commands::journal_disk_usage,
            // command centre (P4.0–P4.3)
            commands::command_search,
            commands::command_execute,
            commands::command_probe_tools,
            commands::command_toggle_favorite,
            commands::command_favorites,
            commands::command_catalog_meta,
            commands::command_param_values,
            commands::command_match_text,
            // docker (P3-1.3)
            commands::docker_snapshot,
            commands::docker_logs,
            commands::docker_inspect_container,
            commands::docker_container_action,
            commands::docker_image_remove,
            commands::docker_prune,
            // server environment probing (read-only, drives terminal suggestions)
            commands::probe_nginx_environment,
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
            commands::project_merge_set,
            commands::project_merges_list,
            // legacy project records retained as P5 foundation
            commands::project_list,
            commands::project_get,
            commands::project_save,
            commands::project_delete,
            // deployment IPC is intentionally not exposed in P3; retained as P5 foundation
            //
            // ---- P5.0 智能部署中心（结构化模型 CRUD） ----
            //
            // 全部是"读写自己的 SQLite 模型"：不连 SSH、不跑命令、不产生运行记录。
            // `deployment_run_*` / `deployment_release_*` 只读（执行留给后续阶段）。
            commands::deployment_application_list,
            commands::deployment_application_get,
            commands::deployment_application_save,
            commands::deployment_application_delete,
            commands::deployment_environment_list,
            commands::deployment_environment_get,
            commands::deployment_environment_save,
            commands::deployment_environment_delete,
            commands::deployment_service_unit_list,
            commands::deployment_service_unit_get,
            commands::deployment_service_unit_save,
            commands::deployment_service_unit_delete,
            commands::deployment_service_unit_link_project,
            commands::deployment_service_unit_unlink_project,
            commands::deployment_service_units_for_project,
            commands::deployment_service_relation_list,
            commands::deployment_service_relation_save,
            commands::deployment_service_relation_delete,
            commands::deployment_capacity_get,
            commands::deployment_capacity_save,
            commands::deployment_domain_list,
            commands::deployment_domain_save,
            commands::deployment_domain_delete,
            commands::deployment_config_list,
            commands::deployment_config_save,
            commands::deployment_config_delete,
            commands::deployment_secret_list,
            commands::deployment_secret_save,
            commands::deployment_secret_delete,
            commands::deployment_artifact_list,
            commands::deployment_artifact_save,
            commands::deployment_artifact_delete,
            commands::deployment_plan_list,
            commands::deployment_plan_get,
            commands::deployment_plan_save,
            commands::deployment_plan_delete,
            commands::deployment_run_list,
            commands::deployment_run_get,
            commands::deployment_release_list,
            commands::deployment_release_get,
            commands::deployment_release_save,
            commands::deployment_release_delete,
            commands::deployment_release_active,
            // ---- P5.1 制品导入与多服务识别 ----
            //
            // 分析阶段只读本地文件（+ 服务器目录的只读清单），**不执行任何上传内容**；
            // 上传只在用户点"上传"时发生，且走 `.part` + 哈希校验 + 原子改名。
            commands::deployment_artifact_import_start,
            commands::deployment_artifact_import_status,
            commands::deployment_artifact_import_list,
            commands::deployment_artifact_import_cancel,
            commands::deployment_artifact_import_retry,
            commands::deployment_artifact_import_confirm,
            commands::deployment_artifact_import_delete,
            commands::deployment_artifact_upload,
            // ---- P5.2 部署方案生成（确定性规则引擎 + 知识库；AI 可选）----
            //
            // 只读输入 + 只写本机 SQLite；`confirm` 落成的是一份 **draft** 计划
            // （审批标记原样保留），批准与执行属于后续阶段。
            commands::deployment_proposal_generate,
            commands::deployment_proposal_list,
            commands::deployment_proposal_get,
            commands::deployment_proposal_confirm,
            commands::deployment_proposal_reject,
            commands::deployment_proposal_delete,
            commands::deployment_policy_get,
            commands::deployment_policy_save,
            // ---- P5.5 AI 提供方（密钥只进钥匙串，SQLite 只有引用）----
            commands::ai_provider_list,
            commands::ai_provider_get,
            commands::ai_provider_save,
            commands::ai_provider_delete,
            commands::ai_provider_set_default,
            commands::ai_provider_test,
            // ---- P5.5 用户知识库 ----
            commands::deployment_knowledge_list,
            commands::deployment_knowledge_get,
            commands::deployment_knowledge_save,
            commands::deployment_knowledge_versions,
            commands::deployment_knowledge_restore,
            commands::deployment_knowledge_archive,
            commands::deployment_knowledge_usage,
            commands::deployment_knowledge_search_test,
            commands::deployment_knowledge_update_meta,
            commands::deployment_knowledge_import_markdown,
            // ---- P5.6 用户 Memory（主界面以它为主，Knowledge 在高级管理）----
            commands::deployment_memory_list,
            commands::deployment_memory_upsert,
            commands::deployment_memory_set_status,
            commands::deployment_memory_delete,
            commands::deployment_memory_clear,
            commands::deployment_memory_record_result,
            // ---- P5.5 AI 复核（后台任务 + 事件；不阻塞确定性方案）----
            commands::deployment_proposal_ai_review,
            commands::deployment_proposal_ai_review_status,
            commands::deployment_proposal_ai_review_cancel,
            // ---- P5.6 统一部署会话（"确认并开始部署"的唯一入口）----
            commands::deployment_session_create,
            commands::deployment_session_get,
            commands::deployment_session_list,
            commands::deployment_session_events,
            commands::deployment_session_ask,
            commands::deployment_session_answer,
            commands::deployment_session_confirm_and_start,
            // P5.6：AI 分析（组装提示词 → 七道校验 → 确定性计划图；**不部署**）。
            commands::deployment_session_analyze,
            // ---- P5.3 类型化 Workflow Engine ----
            //
            // 预检与运行：所有远程命令都经 `safe::Capability`，所有动作都是
            // 类型化枚举（没有命令字符串），Secret 只从钥匙串读取且不进日志。
            commands::deployment_run_preflight,
            commands::deployment_run_start,
            commands::deployment_run_approve_node,
            commands::deployment_run_resume,
            commands::deployment_run_cancel,
            commands::deployment_run_rollback,
            // ---- P5.4 DNS / SSL 指导（V1：只指引与验证，不调服务商 API）----
            commands::deployment_dns_guidance,
            commands::deployment_ssl_plan,
            // ---- 数据库工作台（MySQL 原生协议）----
            //
            // 密码只在钥匙串；查询结果走 pull 批次；取消走独立控制连接。
            commands::db_profile_list,
            commands::db_profile_get,
            commands::db_profile_save,
            commands::db_profile_delete,
            commands::db_test_connection,
            commands::db_connect,
            commands::db_session_info,
            commands::db_disconnect,
            commands::db_profile_status,
            commands::db_profile_close,
            commands::db_use_database,
            commands::db_metadata_databases,
            commands::db_metadata_tables,
            commands::db_metadata_table,
            commands::db_metadata_invalidate,
            commands::db_table_browse,
            commands::db_read_cell,
            commands::db_query_start,
            commands::db_query_next,
            commands::db_query_cancel,
            commands::db_query_release,
            commands::db_query_state,
            commands::db_mutate_apply,
            commands::db_pick_export_path,
            commands::db_export_start,
            commands::db_export_status,
            commands::db_export_outcome,
            commands::db_export_cancel,
            commands::db_export_remove,
            commands::db_history_list,
            commands::db_history_record,
            commands::db_history_clear,
            commands::db_open_sql_file,
            commands::db_save_sql_file,
            commands::db_module_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS：窗口隐藏后点 Dock 图标也要能把主窗口唤回来
            // （Windows 走托盘单击恢复，见 tray.rs）。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app_handle);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}
