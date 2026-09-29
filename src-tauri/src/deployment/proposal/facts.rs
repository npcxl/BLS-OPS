//! 把 P5.1 的识别结果（`ArtifactInspection`）翻译成方案引擎要的"服务事实"。
//!
//! # 为什么需要这一层
//!
//! 方案引擎不直接依赖 `ArtifactInspection`：那会把"识别"与"规划"耦合起来，
//! 也让规则引擎的单测必须造一份完整的识别结果。中间隔一层 [`ServiceFacts`]，
//! 只留几个数（端口 / 健康检查目标 / 环境变量名 / 制品是否被安全扫描挡住）。
//!
//! # 匹配链是**精确字符串**，没有猜测
//!
//! ```text
//! ServiceUnit.artifact_id ─▶ ArtifactRecord.source_ref
//!   ─▶ 来源引用相同的 ArtifactImportTask ─▶ 它的 ArtifactInspection
//!     ─▶ name + source_path 与服务对得上的那个候选
//!        （source_path 由 deploy_path 去掉环境 deploy_root 得到）
//! ```
//!
//! 任何一环对不上就**返回空事实** —— 宁可少给（方案会如实写"端口未定 /
// 需要确认健康检查"），也不猜一个看起来合理的端口塞进生产方案。
//!
//! 候选名可能因为环境内重名去重而被改写过，因此名字对不上时退一步**只按
//! `source_path` 匹配**（仍是精确相等，不是模糊匹配）。

use super::rules::ServiceFacts;
use crate::deployment::artifact::model::{ArtifactImportTask, ServiceCandidate};
use crate::deployment::model::{ArtifactRecord, ServiceUnit};

/// 从"服务 + 它的制品 + 产生该制品的导入任务"里还原出服务事实。
pub fn derive_service_facts(
    services: &[ServiceUnit],
    artifacts: &[ArtifactRecord],
    tasks: &[ArtifactImportTask],
    deploy_root: Option<&str>,
) -> Vec<ServiceFacts> {
    let mut out: Vec<ServiceFacts> = Vec::new();
    for service in services {
        let Some(artifact_id) = service.artifact_id.as_deref() else {
            continue;
        };
        let Some(artifact) = artifacts.iter().find(|item| item.id == artifact_id) else {
            continue;
        };
        // 同一个来源引用可能有多次导入（重试 / 重导），取最近的那次 ——
        // 用 `created_at` 而不是数组顺序，避免依赖查询的排序细节。
        let Some(task) = tasks
            .iter()
            .filter(|task| {
                task.inspection.is_some() && task.source.source_ref() == artifact.source_ref
            })
            .max_by_key(|task| task.created_at)
        else {
            continue;
        };
        let Some(inspection) = task.inspection.as_ref() else {
            continue;
        };
        let Some(sub_path) = relative_under(deploy_root, service.deploy_path.as_deref()) else {
            continue;
        };
        let candidate = inspection
            .services
            .iter()
            .find(|candidate| candidate.name == service.name && candidate.source_path == sub_path)
            .or_else(|| {
                inspection
                    .services
                    .iter()
                    .find(|candidate| candidate.source_path == sub_path)
            });
        let Some(candidate) = candidate else {
            continue;
        };

        let blocking = task
            .security
            .as_ref()
            .and_then(|report| report.findings.iter().find(|finding| finding.blocking));
        out.push(ServiceFacts {
            service_unit_id: service.id.clone(),
            ports: candidate.ports.clone(),
            health_target: health_target(candidate),
            env_keys: if candidate.env_keys.is_empty() {
                inspection
                    .env_keys
                    .iter()
                    .map(|guess| guess.key.clone())
                    .collect()
            } else {
                candidate.env_keys.clone()
            },
            artifact_blocked: blocking.is_some(),
            artifact_blocked_reason: blocking.map(|finding| {
                // 种类用 snake_case 键（与前端 `FINDING_KIND_LABELS` 同一套取值），
                // 这样前端能直接翻译"是哪种阻断项"，不用去解析自由文本。
                let kind = serde_json::to_value(finding.kind)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_else(|| "finding".to_string());
                format!("{kind} @ {}: {}", finding.location, finding.detail)
            }),
        });
    }
    out.sort_by(|left, right| left.service_unit_id.cmp(&right.service_unit_id));
    out.dedup_by(|left, right| left.service_unit_id == right.service_unit_id);
    out
}

/// 识别出来的健康检查目标。
///
/// `http` 给路径（引擎据此选 `HttpHealthCheck`），`tcp` / `container` 给
/// `host:port`。识别没给就返回 `None` —— 方案会如实转成"需要确认"的问题。
fn health_target(candidate: &ServiceCandidate) -> Option<String> {
    candidate
        .health
        .iter()
        .map(|guess| guess.target.trim())
        .find(|target| !target.is_empty())
        .map(str::to_string)
}

/// `deploy_path` 相对 `deploy_root` 的那一段（与候选的 `source_path` 对齐）。
///
/// 不落在根目录之下就返回 `None`：那说明这条服务不是这次导入建出来的，
/// **不能**拿别的候选去凑。
fn relative_under(root: Option<&str>, path: Option<&str>) -> Option<String> {
    let path = path?.trim();
    let root = root.unwrap_or("").trim_end_matches('/');
    if root.is_empty() {
        return Some(path.trim_start_matches('/').to_string());
    }
    let trimmed = path.trim_end_matches('/');
    if trimmed == root {
        return Some(String::new());
    }
    trimmed
        .strip_prefix(&format!("{root}/"))
        .map(str::to_string)
}
