//! 方案校验：**结构（JSON Schema）+ 能力 + 路径 + Secret + 权限 + 风险**。
//!
//! # 为什么不用 jsonschema 依赖
//!
//! 我们要校验的是**自己产出的固定结构**，不是任意用户的 schema。手写一遍
//! 有一件依赖库给不了的好处：**schema 常量与校验逻辑在同一个文件里**，
//! 改一处漏一处会立刻被测试抓住（`tests.rs` 里有一条对齐断言）。
//! 另外真正的重点是"有没有出现可执行的东西"，那本来就得手写。
//!
//! # 三层
//!
//! 1. [`validate_schema`] —— 必需字段齐不齐、类型对不对；
//! 2. [`validate_no_shell`] —— 递归扫禁用键与结构化字段里的 shell 元字符；
//! 3. [`validate_ai_text`] —— AI 文本里的命令片段（AI 输出用同一把尺子）。
//!
//! 结论一律是 [`ProposalViolation`]，并且**说清挡的是计划还是批准**。

use serde_json::Value;

use super::model::{ProposalStatus, ProposalValidation, ProposalViolation, ViolationKind};
use super::PROPOSAL_SCHEMA_VERSION;
use crate::deployment::model::RiskLevel;

/// 方案的 JSON Schema（draft 2020-12）。
///
/// 与 [`DeploymentProposal`](super::model::DeploymentProposal) 的字段一一对应，
/// `tests.rs` 会断言两边不漂移。
pub const PROPOSAL_JSON_SCHEMA: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "DeploymentProposal",
  "type": "object",
  "required": [
    "schema_version",
    "application_id",
    "server_id",
    "status",
    "summary",
    "assumptions",
    "unknowns",
    "recommended_topology",
    "alternative_topologies",
    "services",
    "dependencies",
    "capacity_recommendation",
    "domains",
    "workflow",
    "risks",
    "approvals",
    "rollback_strategy",
    "knowledge_references",
    "knowledge_conflicts",
    "validation",
    "inputs",
    "fingerprint"
  ],
  "properties": {
    "schema_version": { "type": "string", "const": "deployment-proposal/1" },
    "application_id": { "type": "string", "minLength": 1 },
    "server_id": { "type": "string", "minLength": 1 },
    "status": { "enum": ["draft", "confirmed", "rejected", "superseded"] },
    "summary": {
      "type": "object",
      "required": ["headline", "statements"],
      "properties": {
        "headline": { "type": "string", "minLength": 1 },
        "statements": { "type": "array" }
      }
    },
    "assumptions": { "type": "array" },
    "unknowns": { "type": "array" },
    "recommended_topology": {
      "type": "object",
      "required": ["id", "kind", "name", "feasible"],
      "properties": {
        "id": { "type": "string" },
        "kind": {
          "enum": [
            "static_nginx",
            "systemd_processes",
            "docker_compose",
            "docker_images",
            "hybrid_gateway"
          ]
        },
        "name": { "type": "string" },
        "feasible": { "type": "boolean" }
      }
    },
    "alternative_topologies": { "type": "array" },
    "services": { "type": "array" },
    "dependencies": { "type": "array" },
    "capacity_recommendation": {
      "type": "object",
      "required": ["vcpu", "memory_mb", "disk_gb", "headroom_percent"],
      "properties": {
        "vcpu": { "type": "number", "minimum": 0 },
        "memory_mb": { "type": "integer", "minimum": 0 },
        "disk_gb": { "type": "number", "minimum": 0 },
        "headroom_percent": { "type": "integer", "minimum": 0, "maximum": 100 }
      }
    },
    "domains": { "type": "array" },
    "workflow": {
      "type": "object",
      "required": ["nodes", "edges"],
      "properties": {
        "nodes": { "type": "array" },
        "edges": { "type": "array" }
      }
    },
    "risks": { "type": "array" },
    "approvals": { "type": "array" },
    "rollback_strategy": {
      "type": "object",
      "required": ["automatic", "steps"],
      "properties": {
        "automatic": { "type": "boolean" },
        "steps": { "type": "array" }
      }
    },
    "knowledge_references": { "type": "array" },
    "knowledge_conflicts": { "type": "array" },
    "validation": {
      "type": "object",
      "required": ["checks", "violations"],
      "properties": {
        "checks": { "type": "array" },
        "violations": { "type": "array" }
      }
    },
    "inputs": { "type": "object" },
    "fingerprint": {
      "type": "object",
      "required": [
        "engine_version",
        "prompt_version",
        "knowledge_version",
        "input_hash",
        "output_hash"
      ],
      "properties": {
        "engine_version": { "type": "string" },
        "prompt_version": { "type": "string" },
        "knowledge_version": { "type": "string" },
        "input_hash": { "type": "string", "minLength": 64, "maxLength": 64 },
        "output_hash": { "type": "string", "minLength": 64, "maxLength": 64 }
      }
    }
  }
}"#;

/// **绝不能出现在方案里的键名** —— 出现即等于塞了一条可执行命令。
///
/// 这里刻意**不含 `args` / `argv`**：P5.0 的 `ServiceRuntime::NativeProcess`
/// 有一个逐项校验（禁 shell 元字符）的 `args` 字段，它是模型的一部分，
/// 不是"自由命令"。真正该禁 `args` 的地方是计划节点的 `params_json` ——
/// 那由 [`validate_no_shell`] 里的 `validate_params_json` 负责，两边不重叠。
const BANNED_KEYS: &[&str] = &[
    "command",
    "cmd",
    "shell",
    "script",
    "exec",
    "entrypoint",
    "sh",
    "bash",
    "run",
    "pipeline",
];

/// AI 文本里不许出现的命令片段。
const AI_DENY_PATTERNS: &[&str] = &[
    "rm -rf",
    "| sh",
    "| bash",
    "bash -c",
    "sh -c",
    "chmod +x",
    "sudo ",
    "/bin/sh",
    "/bin/bash",
    "$(",
    "`",
    "```bash",
    "```sh",
    "```shell",
    "```powershell",
    "curl -s",
    "wget ",
    "eval ",
    "nc -",
    "mkfifo",
    "> /etc/",
    ">> /etc/",
];

/// AI 文本长度上限（每条）。
const MAX_AI_NOTE_CHARS: usize = 2000;

fn violation(
    kind: ViolationKind,
    severity: RiskLevel,
    source: &str,
    location: &str,
    detail: String,
) -> ProposalViolation {
    ProposalViolation {
        id: format!("v-{}-{}", kind.label().to_ascii_lowercase(), location),
        kind,
        severity,
        source: source.to_string(),
        location: location.to_string(),
        detail,
        blocks_plan: kind.blocks_plan(),
        blocks_approval: kind.blocks_approval(),
    }
}

/// 结构校验：必需字段齐不齐、类型对不对、常量字段一致不一致。
pub fn validate_schema(value: &Value) -> ProposalValidation {
    let mut validation = ProposalValidation::empty();
    let schema: Value =
        serde_json::from_str(PROPOSAL_JSON_SCHEMA).expect("内置 schema 必须是合法 JSON");
    let required = schema["required"].as_array().cloned().unwrap_or_default();
    let properties = schema["properties"].clone();

    let Some(object) = value.as_object() else {
        validation.violations.push(violation(
            ViolationKind::Schema,
            RiskLevel::Critical,
            "schema",
            "root",
            "方案不是一个 JSON 对象".to_string(),
        ));
        return validation;
    };

    for key in required {
        let Some(name) = key.as_str() else { continue };
        if !object.contains_key(name) {
            validation.violations.push(violation(
                ViolationKind::Schema,
                RiskLevel::Critical,
                "schema",
                name,
                format!("缺少必需字段 {name}"),
            ));
        }
    }

    // 类型 + 常量 + 数值范围（只校验 schema 里声明了的那些）。
    if let Some(properties) = properties.as_object() {
        for (name, rule) in properties {
            let Some(actual) = object.get(name) else {
                continue;
            };
            if rule["type"] == Value::String("array".into()) && !actual.is_array() {
                validation.violations.push(violation(
                    ViolationKind::Schema,
                    RiskLevel::High,
                    "schema",
                    name,
                    format!("{name} 应该是数组"),
                ));
            }
            if rule["type"] == Value::String("object".into()) && !actual.is_object() {
                validation.violations.push(violation(
                    ViolationKind::Schema,
                    RiskLevel::High,
                    "schema",
                    name,
                    format!("{name} 应该是对象"),
                ));
            }
            if let Some(expected) = rule["const"].as_str() {
                if actual.as_str() != Some(expected) {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 必须是 {expected}"),
                    ));
                }
            }
            if let Some(allowed) = rule["enum"].as_array() {
                if !allowed.iter().any(|item| item == actual) {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 的取值不在允许范围内"),
                    ));
                }
            }
            if let Some(minimum) = rule["minimum"].as_f64() {
                if actual.as_f64().is_some_and(|got| got < minimum) {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 小于允许的最小值 {minimum}"),
                    ));
                }
            }
            if let Some(maximum) = rule["maximum"].as_f64() {
                if actual.as_f64().is_some_and(|got| got > maximum) {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 大于允许的最大值 {maximum}"),
                    ));
                }
            }
            if let Some(min_length) = rule["minLength"].as_u64() {
                if actual
                    .as_str()
                    .is_some_and(|text| (text.chars().count() as u64) < min_length)
                {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 太短（至少 {min_length} 个字符）"),
                    ));
                }
            }
            if let Some(max_length) = rule["maxLength"].as_u64() {
                if actual
                    .as_str()
                    .is_some_and(|text| (text.chars().count() as u64) > max_length)
                {
                    validation.violations.push(violation(
                        ViolationKind::Schema,
                        RiskLevel::High,
                        "schema",
                        name,
                        format!("{name} 太长（最多 {max_length} 个字符）"),
                    ));
                }
            }
            if let Some(required_inner) = rule["required"].as_array() {
                if let Some(inner) = actual.as_object() {
                    for key in required_inner {
                        if let Some(inner_key) = key.as_str() {
                            if !inner.contains_key(inner_key) {
                                validation.violations.push(violation(
                                    ViolationKind::Schema,
                                    RiskLevel::High,
                                    "schema",
                                    &format!("{name}.{inner_key}"),
                                    format!("{name} 缺少必需字段 {inner_key}"),
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    // 结构版本必须与引擎一致（防止拿旧 schema 的方案去执行）。
    if object.get("schema_version").and_then(Value::as_str) != Some(PROPOSAL_SCHEMA_VERSION) {
        validation.violations.push(violation(
            ViolationKind::Schema,
            RiskLevel::High,
            "schema",
            "schema_version",
            format!("schema_version 必须是 {PROPOSAL_SCHEMA_VERSION}"),
        ));
    }

    validation
}

/// 递归扫描：禁用键名 + 字符串里像命令的片段。
///
/// 只看**结构化位置**（键名、以及 workflow 节点的 `params_json`），
/// 不拿 shell 元字符去扫人话 —— 一段风险说明里出现 `>` 很正常。
pub fn validate_no_shell(value: &Value) -> ProposalValidation {
    let mut validation = ProposalValidation::empty();
    walk_keys(value, "$", &mut validation);

    // workflow 节点的参数必须过 P5.0 的那把尺子。
    if let Some(nodes) = value.pointer("/workflow/nodes").and_then(Value::as_array) {
        for node in nodes {
            let key = node
                .get("node_key")
                .and_then(Value::as_str)
                .unwrap_or("node")
                .to_string();
            let params = node
                .get("params_json")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            if let Err(error) = crate::deployment::validate::validate_params_json(params) {
                validation.violations.push(violation(
                    ViolationKind::Shell,
                    RiskLevel::Critical,
                    "shell",
                    &key,
                    format!("节点参数不合规：{error}"),
                ));
            }
        }
    }
    validation
}

/// 只有这些子树会被检查"命令替换 / 反引号"。
///
/// 判断依据是**这段文本会不会进命令**：运行方式、路径、域名、工作流参数会；
/// 风险说明、知识库引用、AI 批注不会 —— 那些是给人读的散文，
/// 里面写个反引号不该把整个生产方案挡下来（那是假阳性，比漏报更伤信任）。
const STRUCTURED_PREFIXES: &[&str] = &[
    "$.services",
    "$.domains",
    "$.workflow",
    "$.recommended_topology",
];

fn is_structured(path: &str) -> bool {
    STRUCTURED_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn walk_keys(value: &Value, path: &str, validation: &mut ProposalValidation) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                let child = format!("{path}.{key}");
                // 禁用键在任何位置都不允许：键名是结构，不是散文。
                if BANNED_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
                    validation.violations.push(violation(
                        ViolationKind::Shell,
                        RiskLevel::Critical,
                        "shell",
                        &child,
                        format!("方案里出现了禁用键 `{key}`：这等于塞进一条可执行命令"),
                    ));
                }
                if let Some(text) = inner.as_str() {
                    if is_structured(&child) && (text.contains("$(") || text.contains('`')) {
                        validation.violations.push(violation(
                            ViolationKind::Shell,
                            RiskLevel::Critical,
                            "shell",
                            &child,
                            "这段文本会进入部署动作，却不允许出现命令替换（$() 或反引号）"
                                .to_string(),
                        ));
                    }
                }
                walk_keys(inner, &child, validation);
            }
        }
        Value::Array(items) => {
            for (index, inner) in items.iter().enumerate() {
                walk_keys(inner, &format!("{path}[{index}]"), validation);
            }
        }
        _ => {}
    }
}

/// AI 文本校验：命令片段、长度、控制字符。
///
/// **与规则引擎同一把尺子**：AI 说的话不许比规则引擎更"能干"。
pub fn validate_ai_text(text: &str) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("空文本".to_string());
    }
    if trimmed.chars().count() > MAX_AI_NOTE_CHARS {
        return Err(format!("文本过长（最多 {MAX_AI_NOTE_CHARS} 字符）"));
    }
    if trimmed.chars().any(|ch| ch.is_control() && ch != '\n') {
        return Err("文本包含控制字符".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    for pattern in AI_DENY_PATTERNS {
        if lower.contains(pattern) {
            return Err(format!("文本包含可执行片段 `{pattern}`"));
        }
    }
    Ok(())
}

/// 把三份校验合并（并按 id 去重）。
pub fn merge(parts: Vec<ProposalValidation>) -> ProposalValidation {
    let mut out = ProposalValidation::empty();
    for part in parts {
        out.merge(part);
    }
    out.violations.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

/// 方案的 `status` 是否允许落成计划。
pub fn status_allows_plan(status: ProposalStatus) -> bool {
    matches!(status, ProposalStatus::Draft)
}
