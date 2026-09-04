//! 服务器运行环境探测（只读）。
//!
//! 终端的智能提示需要知道"这台机器上 Nginx 到底跑在哪儿"：宿主机、
//! Docker 容器、还是 Docker Compose。探测全部只读 —— 只列容器、在候选
//! 容器里问一句有没有 nginx 可执行文件，**绝不修改服务器**。

use tauri::State;

use crate::env_probe;
use crate::state::AppState;

/// 探测当前 SSH 会话所在服务器的 Nginx 运行环境。
///
/// 前端负责缓存（见 `use-server-environment`）：打开建议时先用缓存、后台
/// 刷新，绝不每敲一个字符就跑一次 `docker ps`。
#[tauri::command]
pub async fn probe_nginx_environment(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<env_probe::NginxEnvironment, String> {
    env_probe::probe_nginx_environment(&state.ssh, &session_id)
        .await
        .map_err(|error| error.to_string())
}
