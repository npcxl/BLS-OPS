//! Project discovery commands (P3 read-only): the five-stage
//! deployment-instance-first pipeline plus its status/result queries.

use tauri::{Emitter, State};

use crate::state::AppState;

/// 从部署实例输出解析 `path\tfile` 行，累积到 path → 标志名集合。
fn collect_markers(
    output: &str,
    markers_by_path: &mut std::collections::BTreeMap<String, Vec<String>>,
) {
    for line in output.lines() {
        let mut parts = line.splitn(2, '\t');
        let Some(path) = parts.next() else { continue };
        let Some(file) = parts.next() else { continue };
        if path.is_empty() || file.is_empty() {
            continue;
        }
        let entry = markers_by_path.entry(path.to_string()).or_default();
        let file = file.to_string();
        if !entry.contains(&file) {
            entry.push(file);
        }
    }
}

/// 候选路径与部署实例的双向前缀关联：候选目录是实例源码目录（或其父/子目录），
/// 就建立运行时关联 —— 这取代旧的 ps/systemctl 文本匹配。
/// 找出与该目录相关的部署实例：既给出评分用的运行时关联，也给出 UI 展示用的
/// 实例详情（运行位置、镜像、服务、配置文件路径）。
///
/// **操作系统自带的实例（sshd / cron / containerd / kubelet / k8s 沙箱容器）
/// 不参与项目发现** —— 它们不是用户部署的东西。
fn instance_links_for_path(
    instances: &[crate::deployment_collector::DeploymentInstance],
    path: &str,
) -> (
    Vec<crate::project_discovery::RuntimeLink>,
    Vec<crate::project_discovery::CandidateInstance>,
) {
    let mut links = Vec::new();
    let mut linked = Vec::new();
    for instance in instances {
        if instance.system_owned {
            continue;
        }
        let related = instance
            .source_paths
            .iter()
            .chain(instance.working_directories.iter())
            .any(|p| {
                p == path
                    || path.starts_with(&format!("{p}/"))
                    || p.starts_with(&format!("{path}/"))
            });
        if !related {
            continue;
        }
        let kind = match instance.kind.as_str() {
            "docker" => crate::project_discovery::RuntimeKind::Docker,
            "systemd" => crate::project_discovery::RuntimeKind::Systemd,
            "nginx" => crate::project_discovery::RuntimeKind::Nginx,
            _ => crate::project_discovery::RuntimeKind::Process,
        };
        links.push(crate::project_discovery::RuntimeLink {
            kind,
            name: instance.name.clone(),
            status: Some(instance.status.clone()),
            ports: instance.ports.clone(),
            source: "deployment_instance".into(),
            runtime: instance.runtime,
            service: instance.service.clone(),
        });
        linked.push(crate::project_discovery::CandidateInstance {
            id: instance.id.clone(),
            kind: instance.kind.clone(),
            name: instance.name.clone(),
            status: instance.status.clone(),
            runtime: instance.runtime,
            image: instance.image.clone(),
            service: instance.service.clone(),
            ports: instance.ports.clone(),
            config_files: instance.config_files.clone(),
            working_directories: instance.working_directories.clone(),
            detail: instance.detail.clone(),
        });
    }
    (links, linked)
}

/// 刷新一条扫描任务的进度。全部阶段共用；`current` 是正在处理的路径。
async fn set_progress(
    registry: &crate::project_discovery::ScanRegistry,
    task_id: &str,
    phase: &str,
    percent: u8,
    checked: u32,
    discovered: usize,
    current: Option<String>,
    warnings: u32,
) {
    if let Some(status) = registry.tasks.lock().await.get_mut(task_id) {
        status.progress.phase = phase.into();
        status.progress.progress = percent;
        status.progress.checked_directories = checked;
        status.progress.discovered_candidates = discovered as u32;
        status.progress.current_path = current;
        status.progress.warnings = warnings;
    }
}

fn scan_status(
    id: &str,
    server_id: &str,
    state: crate::project_discovery::ScanState,
) -> crate::project_discovery::ProjectScanStatus {
    crate::project_discovery::ProjectScanStatus {
        id: id.into(),
        server_id: server_id.into(),
        state,
        progress: crate::project_discovery::ScanProgress {
            phase: "候选发现".into(),
            progress: 0,
            checked_directories: 0,
            discovered_candidates: 0,
            current_path: None,
            warnings: 0,
        },
        error: None,
        started_at: crate::project_discovery::chrono_like_now(),
        finished_at: None,
    }
}

#[tauri::command]
pub async fn project_scan_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    server_id: String,
    incremental: Option<bool>,
) -> Result<crate::project_discovery::ProjectScanStatus, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let status = scan_status(
        &id,
        &server_id,
        crate::project_discovery::ScanState::Running,
    );
    let cancel = state.project_scans.start(status.clone()).await?;
    let registry = state.project_scans.clone();
    let ssh = state.ssh.clone();
    let app_handle = app.clone();
    let sid = session_id.clone();
    let server = server_id.clone();
    // 扫描开始前把该服务器上既有的人工复核结论读入内存，让"确认/忽略"
    // 在重扫后依然生效，而不是每次都被打回待确认。
    let review_map: std::collections::HashMap<String, crate::project_discovery::ReviewState> = {
        match state.db.open().ok().and_then(|conn| {
            crate::db::list_project_reviews(&conn, &server)
                .ok()
                .map(|rows| {
                    rows.into_iter()
                        .map(|r| {
                            (
                                r.path.clone(),
                                crate::project_discovery::ReviewState::from_db_str(&r.review),
                            )
                        })
                        .collect::<std::collections::HashMap<_, _>>()
                })
        }) {
            Some(map) => map,
            None => std::collections::HashMap::new(),
        }
    };
    tauri::async_runtime::spawn(async move {
        let result = async {
            // ---- 阶段 1（0→15%）：能力识别前置 ----
            // 先搞清楚服务器装了什么，再决定启用哪些收集器。未安装的组件
            // （Docker/Nginx/…）不会产生任何探测命令。
            set_progress(&registry, &id, "能力识别", 5, 0, 0, None, 0).await;
            let profile = match crate::capability_probe::probe_capabilities(&sid, &ssh).await {
                Ok(p) => p,
                Err(e) => return Err(format!("服务器能力识别失败：{e}")),
            };

            let mut warnings = profile.warnings.clone();
            // ---- 阶段 2（15→35%）：部署实例枚举（第一轮核心）----
            // Docker/systemd/Nginx 收集器只按能力图谱启用；每个实例深入查
            // ID、路径、端口与配置。
            set_progress(
                &registry,
                &id,
                "部署实例枚举",
                18,
                0,
                0,
                None,
                warnings.len() as u32,
            )
            .await;
            let instances =
                crate::deployment_collector::collect_instances(&sid, &ssh, &profile, &mut warnings)
                    .await;
            let known = instances.iter().filter(|i| i.source_known).count();
            warnings.push(format!(
                "发现 {} 个部署实例（{} 个可关联源码，{} 个源码未知）",
                instances.len(),
                known,
                instances.len() - known
            ));
            set_progress(
                &registry,
                &id,
                "部署实例枚举",
                35,
                instances.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;

            // ---- 阶段 3（35→65%）：定向 marker 扫描 ----
            // 只扫实例给出的候选目录（find -name 项目标志），不再全量枚举文件。
            let mut targeted: Vec<String> = Vec::new();
            for instance in &instances {
                for path in instance
                    .source_paths
                    .iter()
                    .chain(instance.working_directories.iter())
                {
                    if !targeted.contains(path) {
                        targeted.push(path.clone());
                    }
                }
            }
            let mut markers_by_path: std::collections::BTreeMap<String, Vec<String>> =
                std::collections::BTreeMap::new();
            let chunk_size = 16;
            let chunks = targeted.chunks(chunk_size).count().max(1);
            for (index, chunk) in targeted.chunks(chunk_size).enumerate() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("扫描已取消".to_string());
                }
                match crate::remote::run_capability(
                    &ssh,
                    &sid,
                    &crate::safe::Capability::ProjectDirMarkers {
                        paths: chunk.to_vec(),
                    },
                )
                .await
                {
                    Ok(output) => collect_markers(&output, &mut markers_by_path),
                    Err(error) => warnings.push(format!("定向扫描失败（{error}）")),
                }
                set_progress(
                    &registry,
                    &id,
                    "部署实例路径定向扫描",
                    35 + (((index + 1) * 30 / chunks) as u8),
                    chunk.len() as u32 * (index as u32 + 1),
                    0,
                    chunk.first().cloned(),
                    warnings.len() as u32,
                )
                .await;
            }

            // ---- 阶段 4（65→85%）：第二轮固定根 marker 扫描 ----
            // 补充"已上传但未部署"的源码：只在 /home /srv /opt /var/www /data
            // 中查找项目标志文件。
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("扫描已取消".to_string());
            }
            set_progress(
                &registry,
                &id,
                "补充源码扫描",
                68,
                targeted.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;
            match crate::remote::run_capability(
                &ssh,
                &sid,
                &crate::safe::Capability::ProjectMarkerScan,
            )
            .await
            {
                Ok(output) => collect_markers(&output, &mut markers_by_path),
                Err(error) => warnings.push(format!("补充源码扫描失败（{error}）")),
            }
            set_progress(
                &registry,
                &id,
                "补充源码扫描",
                85,
                targeted.len() as u32,
                0,
                None,
                warnings.len() as u32,
            )
            .await;

            // ---- 阶段 5（85→100%）：评分、合并与图谱 ----
            let total = markers_by_path.len().max(1) as u32;
            let mut candidates = Vec::new();
            for (index, (path, markers)) in markers_by_path.into_iter().enumerate() {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("扫描已取消".to_string());
                }
                let (runtime_links, linked_instances) = instance_links_for_path(&instances, &path);
                set_progress(
                    &registry,
                    &id,
                    if runtime_links.is_empty() {
                        "候选评分"
                    } else {
                        "运行服务关联"
                    },
                    85 + (((index as u32 + 1) * 15 / total) as u8),
                    index as u32 + 1,
                    candidates.len(),
                    Some(path.clone()),
                    warnings.len() as u32,
                )
                .await;
                let input = crate::project_discovery::CandidateInput {
                    path: path.clone(),
                    name: path.rsplit('/').next().unwrap_or("项目").into(),
                    server_id: server.clone(),
                    markers,
                    source: "deployment_instance_scan".into(),
                    runtime_links,
                    instances: linked_instances,
                    modules: Vec::new(),
                    env_names: Vec::new(),
                    ports: Vec::new(),
                    review: review_map
                        .get(&path)
                        .copied()
                        .unwrap_or(crate::project_discovery::ReviewState::Pending),
                };
                if let Some(candidate) = crate::project_discovery::score_candidate(
                    input,
                    &crate::project_discovery::chrono_like_now().to_string(),
                ) {
                    candidates.push(candidate);
                }
            }
            let candidates = crate::project_discovery::merge_candidates(candidates);

            set_progress(
                &registry,
                &id,
                "完成",
                100,
                total,
                candidates.len(),
                None,
                warnings.len() as u32,
            )
            .await;

            let result = crate::project_discovery::ProjectScanResult {
                scan_id: id.clone(),
                server_id: server.clone(),
                candidates,
                warnings,
                completed_at: crate::project_discovery::chrono_like_now(),
                incremental: incremental.unwrap_or(false),
                capability: Some(profile),
                instances,
            };
            registry
                .results
                .lock()
                .await
                .insert(id.clone(), result.clone());
            let _ = app_handle.emit(&format!("project-scan-result-{id}"), &result);
            Ok::<(), String>(())
        }
        .await;
        let final_state = if result.is_ok() {
            crate::project_discovery::ScanState::Completed
        } else if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            crate::project_discovery::ScanState::Cancelled
        } else {
            crate::project_discovery::ScanState::Failed
        };
        let final_error = result.as_ref().err().cloned();
        registry
            .finish(&id, &server, final_state, final_error)
            .await;
    });
    Ok(status)
}

#[tauri::command]
pub async fn project_scan_cancel(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<bool, String> {
    Ok(state.project_scans.cancel(&scan_id).await)
}

#[tauri::command]
pub async fn project_scan_status(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<Option<crate::project_discovery::ProjectScanStatus>, String> {
    Ok(state
        .project_scans
        .tasks
        .lock()
        .await
        .get(&scan_id)
        .cloned())
}

#[tauri::command]
pub async fn project_scan_result(
    state: State<'_, AppState>,
    scan_id: String,
) -> Result<Option<crate::project_discovery::ProjectScanResult>, String> {
    Ok(state
        .project_scans
        .results
        .lock()
        .await
        .get(&scan_id)
        .cloned())
}

/// 单独获取服务器能力图谱（第一/二层），供前端在扫描前展示"这是一台什么服务器"。
/// 这是 P3 流水线的起点，绝不执行任何未安装组件（Docker/Nginx/…）的命令。
#[tauri::command]
pub async fn capability_profile(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<crate::capability_probe::ServerCapabilityProfile, String> {
    if !state.ssh.is_connected(&session_id).await {
        return Err("SSH 会话不存在或已断开，请先连接服务器".into());
    }
    crate::capability_probe::probe_capabilities(&session_id, &state.ssh)
        .await
        .map_err(|e| e.to_string())
}

/// 写入一条人工复核结论（"确认项目"或"忽略目录"）。结论按 `(server_id, path)`
/// 存进数据库，下次扫描沿用 —— 重扫不会把已确认的/已忽略的目录打回待确认。
#[tauri::command]
pub async fn project_review_set(
    state: State<'_, AppState>,
    server_id: String,
    path: String,
    review: crate::project_discovery::ReviewState,
    name: Option<String>,
    project_type: Option<String>,
    note: Option<String>,
) -> Result<crate::db::ProjectReviewRecord, String> {
    let conn = state.db.open().map_err(|e| e.to_string())?;
    let now = crate::db::AppDb::now();
    let record = crate::db::ProjectReviewRecord {
        server_id: server_id.clone(),
        path: path.clone(),
        review: review.to_db_str().to_string(),
        name: name.unwrap_or_default(),
        project_type: project_type.unwrap_or_default(),
        note: note.unwrap_or_default(),
        created_at: now,
        updated_at: now,
    };
    crate::db::upsert_project_review(&conn, &record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// 列出某台服务器上全部人工复核结论，供前端在扫描前后展示"已确认/已忽略"。
#[tauri::command]
pub async fn project_review_list(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<crate::db::ProjectReviewRecord>, String> {
    let conn = state.db.open().map_err(|e| e.to_string())?;
    crate::db::list_project_reviews(&conn, &server_id).map_err(|e| e.to_string())
}

/// 针对**一个具体项目**做部署准备检查（源码完整性 / 构建 / 启动 / 端口 /
/// 环境变量 / 依赖服务 / 网关 / 回滚）。基础设施（MySQL、Redis、Nginx 站点）
/// 会被直接判定为 Blocked，因为它不是要部署的业务项目。
///
/// 复用最近一次扫描结果里的 `ServerCapabilityProfile` 与项目候选，因此无需
/// 重新连接服务器；找不到对应项目时返回错误，由前端提示先扫描。
#[tauri::command]
pub async fn project_readiness_check(
    state: State<'_, AppState>,
    server_id: String,
    scan_id: String,
    candidate_path: String,
) -> Result<crate::project_readiness::ProjectReadinessReport, String> {
    let results = state.project_scans.results.lock().await;
    let scan = results
        .get(&scan_id)
        .ok_or_else(|| "找不到对应的扫描结果，请先重新扫描".to_string())?;
    if scan.server_id != server_id {
        return Err("扫描结果不属于该服务器".to_string());
    }
    let profile = scan
        .capability
        .as_ref()
        .ok_or_else(|| "扫描未覆盖服务器能力信息，请重新扫描".to_string())?;
    let candidate = scan
        .candidates
        .iter()
        .find(|c| c.path == candidate_path)
        .ok_or_else(|| "候选列表里没有该项目，请重新扫描".to_string())?;
    Ok(crate::project_readiness::assess_project_readiness(
        &candidate.path,
        &candidate.markers,
        &candidate.detected_ports,
        &candidate.deploy_instances,
        &candidate.project_type,
        candidate.project_kind,
        profile,
    ))
}
