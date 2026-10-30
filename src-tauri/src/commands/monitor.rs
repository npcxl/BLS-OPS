//! Server monitoring commands — read-only Linux metrics over the live session.
//!
//! Every command here takes only a `session_id`: the commands that run on the
//! server are a fixed table inside `monitor.rs`, so the WebView cannot ask for
//! an arbitrary shell string.

use tauri::State;

use crate::monitor::{
    CpuMetrics, DiskMetrics, MemoryMetrics, MonitorSnapshot, NetworkMetrics, ProcessInfo,
    SystemInfo,
};
use crate::ops_error::{OpsError, OpsResult};
use crate::state::AppState;

/// 监控读取全是只读采集：失败重试有意义，阶段统一 `monitor`。
fn metrics_error(error: impl ToString) -> OpsError {
    OpsError::from_stage("monitor", error).retryable()
}

#[tauri::command]
pub async fn monitor_system_info(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<SystemInfo> {
    crate::monitor::collect_system_info(&state.ssh, &session_id)
        .await
        .map_err(metrics_error)
}

#[tauri::command]
pub async fn monitor_cpu(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<CpuMetrics> {
    crate::monitor::collect_cpu(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(metrics_error)
}

#[tauri::command]
pub async fn monitor_memory(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<MemoryMetrics> {
    crate::monitor::collect_memory(&state.ssh, &session_id)
        .await
        .map_err(metrics_error)
}

#[tauri::command]
pub async fn monitor_disks(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<Vec<DiskMetrics>> {
    crate::monitor::collect_disks(&state.ssh, &session_id)
        .await
        .map_err(metrics_error)
}

#[tauri::command]
pub async fn monitor_network(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<Vec<NetworkMetrics>> {
    crate::monitor::collect_network(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(metrics_error)
}

#[tauri::command]
pub async fn monitor_processes(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<Vec<ProcessInfo>> {
    crate::monitor::collect_processes(&state.ssh, &session_id)
        .await
        .map_err(metrics_error)
}

/// The one call the monitoring page is built around: every headline metric in
/// a single round trip.
#[tauri::command]
pub async fn monitor_snapshot(
    state: State<'_, AppState>,
    session_id: String,
) -> OpsResult<MonitorSnapshot> {
    crate::monitor::collect_snapshot(&state.ssh, &state.monitor, &session_id)
        .await
        .map_err(metrics_error)
}
