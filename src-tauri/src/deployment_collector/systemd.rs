//! systemd collector — `list-units` then a batched `systemctl show`.

use std::collections::BTreeMap;

use super::model::{
    is_app_path, is_config_path, is_host_project_path, push_unique, DeploymentInstance,
};
use crate::remote::run_on_linux;
use crate::safe::Capability;
use crate::ssh::SshSessionManager;

/// 单次 `systemctl show` 的单元上限（`safe::Capability::SystemdShowUnits` 的上限）。
const SHOW_BATCH: usize = 40;
/// 最多 show 多少个单元（5 批 × 40），给单元极多的机器设上限。
const MAX_UNITS: usize = 200;

pub(crate) async fn collect_systemd(
    session_id: &str,
    mgr: &SshSessionManager,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    // 第一步：列出全部 service 单元。
    let listing = run_on_linux(mgr, session_id, &Capability::ListServices).await?;
    let units = crate::systemd::parse_list_units(&listing);
    let names: Vec<String> = units
        .iter()
        .take(MAX_UNITS)
        .map(|u| u.unit.clone())
        .collect();
    let mut instances = Vec::new();

    // 第二步：批量 show（白名单校验单元名）。
    for chunk in names.chunks(SHOW_BATCH) {
        let output = run_on_linux(
            mgr,
            session_id,
            &Capability::SystemdShowUnits {
                units: chunk.to_vec(),
            },
        )
        .await?;
        for (unit_name, props) in parse_systemd_show(&output) {
            let Some(unit) = units.iter().find(|u| u.unit == unit_name) else {
                continue;
            };
            if let Some(instance) =
                systemd_instance(&unit_name, unit.active.as_str(), unit.sub.as_str(), &props)
            {
                instances.push(instance);
            }
        }
    }
    Ok(instances)
}

/// 解析 `systemctl show unit1 unit2 …` 的输出：单元之间用空行分隔，
/// 每行 `Key=Value`。返回 `(Id, 属性表)` 列表。
pub fn parse_systemd_show(output: &str) -> Vec<(String, BTreeMap<String, String>)> {
    let mut blocks: Vec<BTreeMap<String, String>> = Vec::new();
    let mut current: BTreeMap<String, String> = BTreeMap::new();
    for line in output.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            current.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    blocks
        .into_iter()
        .filter_map(|props| {
            let id = props.get("Id")?.clone();
            Some((id, props))
        })
        .collect()
}

/// 从单个单元的 show 属性构造实例。只保留"业务服务"：
/// WorkingDirectory 或 ExecStart 里的路径落在业务根下（见 `model::APP_ROOTS`）。
pub fn systemd_instance(
    unit: &str,
    active: &str,
    sub: &str,
    props: &BTreeMap<String, String>,
) -> Option<DeploymentInstance> {
    let working_directory = props
        .get("WorkingDirectory")
        .map(String::as_str)
        .unwrap_or("");
    let exec_start = props.get("ExecStart").map(String::as_str).unwrap_or("");
    let fragment = props.get("FragmentPath").map(String::as_str).unwrap_or("");
    let env_files = props
        .get("EnvironmentFiles")
        .map(String::as_str)
        .unwrap_or("");

    let exec_paths = extract_exec_paths(exec_start);
    let business = is_app_path(working_directory) || exec_paths.iter().any(|p| is_app_path(p));
    if !business {
        return None;
    }

    let mut source_paths: Vec<String> = Vec::new();
    let mut working_directories: Vec<String> = Vec::new();
    if is_host_project_path(working_directory) {
        working_directories.push(working_directory.to_string());
        source_paths.push(working_directory.to_string());
    }
    for path in &exec_paths {
        // ExecStart 指向的是可执行/JAR 文件；其所在目录才是项目候选。
        if let Some(parent) = std::path::Path::new(path).parent() {
            let parent = parent.to_string_lossy().to_string();
            if is_host_project_path(&parent) {
                push_unique(&mut source_paths, parent);
            }
        }
    }

    let mut config_files: Vec<String> = Vec::new();
    if is_config_path(fragment) {
        config_files.push(fragment.to_string());
    }
    for token in env_files.split_whitespace() {
        // `EnvironmentFiles=/srv/app/.env (ignore_errors=no)` —— 取以 / 开头的
        // 去掉括号注记后的路径 token。
        let token = token.trim_start_matches('(');
        if is_config_path(token) {
            config_files.push(token.to_string());
        }
    }

    let source_known = !source_paths.is_empty();
    Some(DeploymentInstance {
        id: format!("systemd:{unit}"),
        kind: "systemd".into(),
        name: unit.to_string(),
        status: format!("{active}/{sub}"),
        ports: Vec::new(), // systemd show 不提供监听端口；由证据阶段补充
        working_directories,
        config_files,
        source_paths,
        source_known,
        detail: if exec_start.is_empty() {
            format!("单元 {unit}")
        } else {
            format!("单元 {unit} · {exec_start}")
        },
    })
}

/// 从 ExecStart 提取绝对路径 token（去掉 systemd 的 `(unquoted; …)` 注记）。
pub fn extract_exec_paths(exec_start: &str) -> Vec<String> {
    let trimmed = match exec_start.find(" (unquoted") {
        Some(idx) => &exec_start[..idx],
        None => exec_start,
    };
    trimmed
        .split_whitespace()
        .filter(|token| token.starts_with('/'))
        .map(str::to_string)
        .collect()
}
