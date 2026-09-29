//! P5.0 部署中心的校验层。
//!
//! 这一层是"结构化模型"这个承诺的**机械保障**：只要它拦得住，模型里就不可能
//! 出现一条能直接喂给 shell 的字符串。三条主线：
//!
//! 1. **文本白名单**：[`reject_shell_text`] 拒绝控制字符与 shell 元字符
//!    （`;` `&&` `|` 反引号 `$` `>` 重定向 …），所有"用户可写的短标识"
//!    都要过它。
//! 2. **路径围栏**：[`validate_under_root`] 用既有的 `safe::is_within`
//!    保证服务目录不越出环境的 `deploy_root`；运行期临时密钥只允许 `/run`
//!    与 `/dev/shm`。
//! 3. **图合法性**：[`validate_plan_graph`] 保证计划是有向无环图（节点 key 唯一、
//!    无自环、无重复边、无环）。
//!
//! 复用而不是重写：路径 / 单元名 / 镜像 / 站点名 / Git 引用都直接调
//! `crate::safe` 里已有的校验函数 —— 它们已经在 P3 的解部署路径上跑了一年。

use anyhow::{anyhow, Result};

use crate::safe;

use super::model::*;

/// shell 元字符与其它不该出现在结构化字段里的字符。
///
/// 空格是允许的（路径与参数里合法），真正危险的是"能改变命令语义"的那些。
const SHELL_META: &[char] = &[
    ';', '&', '|', '`', '$', '<', '>', '\\', '"', '\'', '\n', '\r', '\t', '*', '?', '!', '~', '#',
    '(', ')', '{', '}', '[', ']',
];

/// 计划节点参数里**禁止出现的键** —— 这些键一旦出现，就等于把自由命令塞进了模型。
const BANNED_PARAM_KEYS: &[&str] = &[
    "command",
    "cmd",
    "shell",
    "script",
    "exec",
    "entrypoint",
    "args",
    "argv",
    "sh",
    "bash",
];

/// 字段长度上限（防止把整个文件塞进一个字段）。
const MAX_NAME_LEN: usize = 120;
const MAX_TEXT_LEN: usize = 2000;
const MAX_TOKEN_LEN: usize = 128;
const MAX_PARAM_JSON_LEN: usize = 16 * 1024;
const MAX_ASSUMPTION_LEN: usize = 400;
const MAX_ASSUMPTIONS: usize = 20;

/// 拒绝 shell 元字符与控制字符。
///
/// 这不是"转义"——转义是写代码时的最后一层防御；这里的目标是**根本不允许**
/// 这类文本进入数据库，将来编译成命令时也就无从注入。
pub fn reject_shell_text(value: &str, field: &str) -> Result<()> {
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    if let Some(found) = value.chars().find(|ch| SHELL_META.contains(ch)) {
        return Err(anyhow!("{field}不能包含 shell 元字符 {found:?}：{value}"));
    }
    Ok(())
}

/// 展示名：非空、无控制字符、长度受限。允许空格与中文。
pub fn validate_name(value: &str, field: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{field}不能为空"));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(anyhow!("{field}过长（最多 {MAX_NAME_LEN} 个字符）"));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    Ok(())
}

/// 说明性长文本：允许大部分内容，但不允许控制字符（换行用 UI 处理）。
pub fn validate_text(value: &str, field: &str) -> Result<()> {
    if value.chars().count() > MAX_TEXT_LEN {
        return Err(anyhow!("{field}过长（最多 {MAX_TEXT_LEN} 个字符）"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    Ok(())
}

/// 短标识：字母数字与 `._-`，且必须过 shell 元字符检查。
pub fn validate_token(value: &str, field: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("{field}不能为空"));
    }
    if trimmed.chars().count() > MAX_TOKEN_LEN {
        return Err(anyhow!("{field}过长（最多 {MAX_TOKEN_LEN} 个字符）"));
    }
    reject_shell_text(trimmed, field)?;
    if let Some(found) = trimmed.chars().find(|ch| {
        !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/' | ':' | '=' | '+' | '@'))
    }) {
        return Err(anyhow!("{field}包含不允许的字符 {found:?}：{value}"));
    }
    Ok(())
}

/// 计划节点 key：小写字母数字下划线。
pub fn validate_node_key(value: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("节点标识不能为空"));
    }
    if trimmed.chars().count() > 64 {
        return Err(anyhow!("节点标识过长（最多 64 个字符）"));
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err(anyhow!(
            "节点标识只能用小写字母、数字与下划线：{value}（如 fetch_source）"
        ));
    }
    Ok(())
}

/// 环境变量名：`DATABASE_URL` 这种形态。
pub fn validate_config_key(value: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("配置键不能为空"));
    }
    if trimmed.chars().count() > 64 {
        return Err(anyhow!("配置键过长（最多 64 个字符）"));
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap_or('_');
    if !(first.is_ascii_uppercase() || first == '_') {
        return Err(anyhow!("配置键必须以大写字母或下划线开头：{value}"));
    }
    if let Some(found) =
        chars.find(|ch| !(ch.is_ascii_uppercase() || ch.is_ascii_digit() || *ch == '_'))
    {
        return Err(anyhow!(
            "配置键只能包含大写字母、数字与下划线（不允许 {found:?}）：{value}"
        ));
    }
    Ok(())
}

/// 绝对路径（复用 `safe::validate_abs_path`）。
pub fn validate_path(value: &str, field: &str) -> Result<()> {
    let trimmed = value.trim();
    safe::validate_abs_path(trimmed, field)?;
    // `validate_abs_path` 管的是"是不是合法绝对路径"，元字符是这里的责任。
    reject_shell_text(trimmed, field)?;
    Ok(())
}

/// 路径必须落在某个根目录下（复用 `safe::is_within`，它处理了 `..` 归一化）。
pub fn validate_under_root(path: &str, root: &str, field: &str) -> Result<()> {
    validate_path(path, field)?;
    validate_path(root, "环境根目录")?;
    if !safe::is_within(path.trim(), root.trim()) {
        return Err(anyhow!(
            "{field}必须位于环境根目录之内：{path}（允许范围：{root}）"
        ));
    }
    Ok(())
}

/// 域名：小写、无协议、无端口、无路径、至少两段。
pub fn validate_domain(value: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("域名不能为空"));
    }
    if trimmed != trimmed.to_ascii_lowercase() {
        return Err(anyhow!("域名必须使用小写字母：{value}"));
    }
    if trimmed.len() > 253 {
        return Err(anyhow!("域名过长：{value}"));
    }
    if trimmed.contains('/') || trimmed.contains(':') || trimmed.contains(' ') {
        return Err(anyhow!(
            "域名里不能带协议、端口或路径（只写主机名，如 app.example.com）：{value}"
        ));
    }
    let labels: Vec<&str> = trimmed.split('.').collect();
    if labels.len() < 2 {
        return Err(anyhow!("域名至少要有两级（如 app.example.com）：{value}"));
    }
    for label in &labels {
        if label.is_empty() || label.len() > 63 {
            return Err(anyhow!("域名段长度必须在 1-63 之间：{value}"));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(anyhow!("域名段不能以连字符开头或结尾：{value}"));
        }
        if !label
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
        {
            return Err(anyhow!("域名只能包含小写字母、数字、连字符与点：{value}"));
        }
    }
    Ok(())
}

/// 端口：1-65535（0 会让"绑定到随机端口"变成隐性行为，不允许）。
pub fn validate_port(port: u16, field: &str) -> Result<()> {
    if port == 0 {
        return Err(anyhow!(
            "{field}必须在 1-65535 之间（0 表示随机端口，不允许）"
        ));
    }
    Ok(())
}

/// SHA-256：64 位小写十六进制。
pub fn validate_sha256(value: &str, field: &str) -> Result<()> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Err(anyhow!("{field}必须是 64 位十六进制字符串（SHA-256）"));
    }
    if trimmed != trimmed.to_ascii_lowercase() {
        return Err(anyhow!("{field}必须使用小写十六进制"));
    }
    Ok(())
}

/// 运行期临时密钥文件：只允许 `/run` 与 `/dev/shm`。
///
/// `/tmp` 是共享可写目录，多用户机器上能被人抢先建同名文件；`/run` 与
/// `/dev/shm` 权限更紧、重启即清空，适合放部署期的短命凭据。
pub fn validate_runtime_secret_path(value: &str) -> Result<()> {
    validate_path(value, "运行时密钥文件路径")?;
    let trimmed = value.trim();
    let allowed = ["/run", "/dev/shm"];
    if !allowed.iter().any(|root| safe::is_within(trimmed, root)) {
        return Err(anyhow!(
            "运行时密钥文件必须放在 {} 下面（不放 /tmp）：{value}",
            allowed.join(" 或 ")
        ));
    }
    Ok(())
}

/// 计划节点参数校验。
///
/// 必须是 JSON **对象**；键不能是 `command` / `shell` / `exec` 这类自由命令入口；
/// 所有字符串值都要过 [`reject_shell_text`]。递归检查，数组与嵌套对象一并覆盖。
pub fn validate_params_json(json: &str) -> Result<()> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if trimmed.len() > MAX_PARAM_JSON_LEN {
        return Err(anyhow!(
            "节点参数过大（最多 {} KB）",
            MAX_PARAM_JSON_LEN / 1024
        ));
    }
    let value: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|error| anyhow!("节点参数不是合法 JSON：{error}"))?;
    let serde_json::Value::Object(map) = &value else {
        return Err(anyhow!(
            "节点参数必须是 JSON 对象（键值对），不能是数组或裸值"
        ));
    };
    for (key, entry) in map {
        if BANNED_PARAM_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
            return Err(anyhow!(
                "节点参数不允许使用 {key:?}：部署动作必须是类型化字段，不能携带自由命令"
            ));
        }
        validate_param_value(entry, key)?;
    }
    Ok(())
}

fn validate_param_value(value: &serde_json::Value, key: &str) -> Result<()> {
    match value {
        serde_json::Value::String(text) => {
            if text.chars().count() > 512 {
                return Err(anyhow!("节点参数 {key:?} 的字符串过长（最多 512 个字符）"));
            }
            reject_shell_text(text, &format!("节点参数 {key:?}"))
        }
        serde_json::Value::Array(items) => {
            for item in items {
                validate_param_value(item, key)?;
            }
            Ok(())
        }
        serde_json::Value::Object(map) => {
            for (nested_key, nested) in map {
                if BANNED_PARAM_KEYS.contains(&nested_key.to_ascii_lowercase().as_str()) {
                    return Err(anyhow!(
                        "节点参数不允许使用 {nested_key:?}（嵌套层级同样禁止自由命令）"
                    ));
                }
                validate_param_value(nested, nested_key)?;
            }
            Ok(())
        }
        serde_json::Value::Null | serde_json::Value::Bool(_) | serde_json::Value::Number(_) => {
            Ok(())
        }
    }
}

// -- 实体校验 ---------------------------------------------------------------

pub fn validate_application(application: &DeploymentApplication) -> Result<()> {
    validate_name(&application.name, "应用名称").map_err(|error| anyhow!("{error}"))?;
    validate_text(&application.description, "应用说明")?;
    if application.server_id.trim().is_empty() {
        return Err(anyhow!("必须选择服务器"));
    }
    if application.status != "active" && application.status != "archived" {
        return Err(anyhow!("应用状态只能是 active 或 archived"));
    }
    match application.source_kind {
        SourceKind::Git => {
            safe::validate_repo_url(application.source_ref.trim())
                .map_err(|error| anyhow!("仓库地址不合法：{error}"))?;
            if !application.default_branch.trim().is_empty() {
                safe::validate_git_ref(application.default_branch.trim())?;
            }
        }
        SourceKind::ExistingRemoteDir => {
            validate_path(&application.source_ref, "服务器目录")?;
        }
        SourceKind::LocalUpload => {
            // 本地路径只是提示（真正上传在后续阶段），但仍然不允许元字符。
            let trimmed = application.source_ref.trim();
            if !trimmed.is_empty() {
                if trimmed.len() > 512 {
                    return Err(anyhow!("本地路径过长"));
                }
                if trimmed.chars().any(|ch| ch.is_control()) {
                    return Err(anyhow!("本地路径不能包含控制字符"));
                }
            }
        }
    }
    if let Some(path) = &application.confirmed_project_path {
        if !path.trim().is_empty() {
            validate_path(path, "已确认项目路径")?;
        }
    }
    Ok(())
}

pub fn validate_environment(environment: &DeploymentEnvironment) -> Result<()> {
    validate_name(&environment.name, "环境名称")?;
    validate_text(&environment.notes, "环境备注")?;
    validate_path(&environment.deploy_root, "环境根目录")?;
    if environment.application_id.trim().is_empty() {
        return Err(anyhow!("环境必须归属一个应用"));
    }
    if environment.server_id.trim().is_empty() {
        return Err(anyhow!("环境必须指定服务器"));
    }
    if environment.status != "active" && environment.status != "archived" {
        return Err(anyhow!("环境状态只能是 active 或 archived"));
    }
    Ok(())
}

pub fn validate_service_unit(unit: &ServiceUnit, environment_root: Option<&str>) -> Result<()> {
    validate_name(&unit.name, "服务名称")?;
    validate_text(&unit.notes, "服务备注")?;
    if unit.application_id.trim().is_empty() {
        return Err(anyhow!("服务必须归属一个应用"));
    }
    if unit.environment_id.trim().is_empty() {
        return Err(anyhow!("服务必须归属一个环境"));
    }
    if unit.status != "configured" && unit.status != "incomplete" && unit.status != "disabled" {
        return Err(anyhow!("服务状态只能是 configured / incomplete / disabled"));
    }
    match &unit.deploy_path {
        Some(path) if !path.trim().is_empty() => match environment_root {
            Some(root) => validate_under_root(path, root, "服务目录")?,
            None => validate_path(path, "服务目录")?,
        },
        _ => {}
    }
    if let Some(path) = &unit.confirmed_project_path {
        if !path.trim().is_empty() {
            validate_path(path, "已确认项目路径")?;
        }
    }
    validate_runtime(&unit.runtime)
}

/// 运行方式校验：每个变体只允许它的合法参数形态。
pub fn validate_runtime(runtime: &ServiceRuntime) -> Result<()> {
    match runtime {
        ServiceRuntime::StaticNginx { site_name, root } => {
            safe::validate_site_name(site_name.trim())
                .map_err(|error| anyhow!("站点名不合法：{error}"))?;
            validate_path(root, "站点根目录")?;
        }
        ServiceRuntime::SystemdUnit { unit } => {
            safe::validate_unit(unit.trim())
                .map_err(|error| anyhow!("systemd 单元名不合法：{error}"))?;
        }
        ServiceRuntime::DockerImage {
            image,
            tag,
            container_name,
            ports,
        } => {
            safe::validate_image(image.trim()).map_err(|error| anyhow!("镜像名不合法：{error}"))?;
            validate_token(tag, "镜像标签")?;
            safe::validate_container(container_name.trim())
                .map_err(|error| anyhow!("容器名不合法：{error}"))?;
            for port in ports {
                validate_port(port.host_port, "宿主机端口")?;
                validate_port(port.container_port, "容器端口")?;
            }
        }
        ServiceRuntime::DockerCompose {
            compose_path,
            project_name,
            service,
        } => {
            validate_path(compose_path, "Compose 文件路径")?;
            validate_token(project_name, "Compose 项目名")?;
            validate_token(service, "Compose 服务名")?;
        }
        ServiceRuntime::NativeProcess { entry, args } => {
            validate_token(entry, "可执行入口")?;
            if args.len() > 32 {
                return Err(anyhow!("启动参数过多（最多 32 个）"));
            }
            // 逐个参数校验：它们将来会被 shell_quote 包裹后拼接，任何一个含
            // 元字符都可能改变语义，所以在这一层就挡掉。
            for argument in args {
                if argument.chars().count() > 256 {
                    return Err(anyhow!("启动参数过长：{argument}"));
                }
                reject_shell_text(argument, "启动参数")?;
            }
        }
        ServiceRuntime::External { endpoint } => {
            let trimmed = endpoint.trim();
            if trimmed.is_empty() {
                return Err(anyhow!("外部服务的地址不能为空（host:port）"));
            }
            validate_token(trimmed, "外部服务地址")?;
            if !trimmed.contains(':') {
                return Err(anyhow!("外部服务地址需要写成 host:port：{endpoint}"));
            }
        }
    }
    Ok(())
}

pub fn validate_relation(relation: &ServiceRelation) -> Result<()> {
    validate_text(&relation.notes, "关系备注")?;
    if relation.from_service_id == relation.to_service_id {
        return Err(anyhow!("服务不能与自己建立关系"));
    }
    if relation.from_service_id.trim().is_empty() || relation.to_service_id.trim().is_empty() {
        return Err(anyhow!("关系必须指定两个服务"));
    }
    Ok(())
}

pub fn validate_capacity(profile: &CapacityProfile) -> Result<()> {
    validate_text(&profile.notes, "容量备注")?;
    if profile.assumptions.len() > MAX_ASSUMPTIONS {
        return Err(anyhow!("假设条目过多（最多 {MAX_ASSUMPTIONS} 条）"));
    }
    for assumption in &profile.assumptions {
        if assumption.trim().is_empty() {
            return Err(anyhow!("假设条目不能为空"));
        }
        if assumption.chars().count() > MAX_ASSUMPTION_LEN {
            return Err(anyhow!("假设条目过长（最多 {MAX_ASSUMPTION_LEN} 个字符）"));
        }
        if assumption.chars().any(|ch| ch.is_control()) {
            return Err(anyhow!("假设条目不能包含控制字符"));
        }
    }
    // 估算就必须说清假设 —— 用户裁决："允许估算，但必须展示假设"。
    if profile.estimation_basis == EstimationBasis::Estimated && profile.assumptions.is_empty() {
        return Err(anyhow!(
            "标记为估算时必须填写至少一条假设（例如：按 3 倍峰值系数推算 QPS）"
        ));
    }
    if let Some(target) = &profile.availability_target {
        if !target.trim().is_empty() && !["99", "99.9", "99.95", "99.99"].contains(&target.trim()) {
            return Err(anyhow!(
                "可用性目标只能是 99 / 99.9 / 99.95 / 99.99 之一：{target}"
            ));
        }
    }
    for (value, label) in [
        (profile.expected_dau, "日活"),
        (profile.concurrent_users, "并发用户"),
        (profile.websocket_connections, "WebSocket 连接数"),
        (profile.rpo_minutes, "RPO"),
        (profile.rto_minutes, "RTO"),
    ] {
        if let Some(number) = value {
            if number < 0 {
                return Err(anyhow!("{label}不能是负数"));
            }
        }
    }
    for (value, label) in [
        (profile.peak_qps, "峰值 QPS"),
        (profile.avg_qps, "平均 QPS"),
        (profile.monthly_bandwidth_gb, "月带宽"),
        (profile.monthly_upload_gb, "月上传量"),
        (profile.monthly_data_growth_gb, "月数据增长"),
        (profile.monthly_budget, "月预算"),
    ] {
        if let Some(number) = value {
            if !number.is_finite() || number < 0.0 {
                return Err(anyhow!("{label}必须是有限的非负数"));
            }
        }
    }
    Ok(())
}

pub fn validate_domain_binding(
    binding: &DomainBinding,
    environment_root: Option<&str>,
) -> Result<()> {
    let _ = environment_root;
    validate_text(&binding.notes, "域名备注")?;
    validate_domain(&binding.domain)?;
    validate_port(binding.listen_port, "监听端口")?;
    let prefix = binding.path_prefix.trim();
    if prefix.is_empty() || !prefix.starts_with('/') {
        return Err(anyhow!("URL 前缀必须以 / 开头：{}", binding.path_prefix));
    }
    reject_shell_text(prefix, "URL 前缀")?;
    if binding.ssl_mode == SslMode::Acme && binding.dns_credential_ref.is_none() {
        return Err(anyhow!(
            "使用 ACME 自动签发时需要选择一个 DNS 凭据引用（密钥本身存在 Keyring 里）"
        ));
    }
    Ok(())
}

pub fn validate_config(config: &ConfigDefinition) -> Result<()> {
    validate_text(&config.description, "配置说明")?;
    validate_config_key(&config.key)?;
    // 密钥项绝不允许明文默认值 —— 这是整套 Secret 模型的关键一步。
    if config.secret {
        if config
            .default_value
            .as_deref()
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return Err(anyhow!(
                "密钥类配置不允许填写明文默认值；请改用密钥引用（{}）",
                config.key
            ));
        }
        if config.source_kind != ConfigSourceKind::SecretRef {
            return Err(anyhow!(
                "密钥类配置的来源必须是密钥引用（当前：{:?}）",
                config.source_kind
            ));
        }
    }
    match config.source_kind {
        ConfigSourceKind::SecretRef => {
            let reference = config
                .source_ref
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("密钥类配置必须选择一个密钥引用"))?;
            validate_token(reference, "密钥引用")?;
        }
        ConfigSourceKind::Literal => {
            if let Some(default) = &config.default_value {
                if default.chars().count() > MAX_TEXT_LEN {
                    return Err(anyhow!("默认值过长"));
                }
                if default.chars().any(|ch| ch.is_control()) {
                    return Err(anyhow!("默认值不能包含控制字符"));
                }
            }
        }
        _ => {
            if let Some(reference) = &config.source_ref {
                if !reference.trim().is_empty() {
                    // `dependency_ref` / `environment_ref` / `file` 这些是表达式或路径，
                    // 允许 `${...}` 与路径字符，但同样禁止元字符。
                    if reference.chars().any(|ch| ch.is_control()) {
                        return Err(anyhow!("配置来源不能包含控制字符"));
                    }
                    if reference.chars().count() > 512 {
                        return Err(anyhow!("配置来源过长"));
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn validate_secret_ref(reference: &SecretRef) -> Result<()> {
    validate_name(&reference.name, "密钥名称")?;
    validate_text(&reference.description, "密钥说明")?;
    match reference.store_kind {
        SecretStoreKind::Keyring => {
            let account = reference
                .keyring_account
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("Keyring 方式必须填写账户名（secret_id）"))?;
            validate_token(account, "Keyring 账户名")?;
            if let Some(service) = &reference.keyring_service {
                if !service.trim().is_empty() {
                    validate_token(service, "Keyring 服务名")?;
                }
            }
            if reference
                .runtime_path
                .as_deref()
                .is_some_and(|path| !path.trim().is_empty())
            {
                return Err(anyhow!("Keyring 方式不需要运行时文件路径"));
            }
        }
        SecretStoreKind::RuntimeTempFile => {
            let path = reference
                .runtime_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("运行时文件方式必须填写文件路径模板"))?;
            validate_runtime_secret_path(path)?;
            if reference
                .keyring_account
                .as_deref()
                .is_some_and(|account| !account.trim().is_empty())
            {
                return Err(anyhow!("运行时文件方式不需要 Keyring 账户名"));
            }
        }
    }
    Ok(())
}

pub fn validate_artifact(artifact: &ArtifactRecord) -> Result<()> {
    validate_text(&artifact.notes, "制品备注")?;
    if let Some(name) = &artifact.file_name {
        if !name.trim().is_empty() {
            // 文件名不允许路径分隔符 —— 它是名字，不是路径。
            if name.contains('/') || name.contains('\\') {
                return Err(anyhow!("制品文件名不能包含路径分隔符：{name}"));
            }
            reject_shell_text(name, "制品文件名")?;
        }
    }
    if let Some(size) = artifact.size_bytes {
        if size < 0 {
            return Err(anyhow!("制品大小不能是负数"));
        }
    }
    if let Some(digest) = &artifact.sha256 {
        if !digest.trim().is_empty() {
            validate_sha256(digest, "SHA-256")?;
        }
    }
    if let Some(label) = &artifact.version_label {
        if !label.trim().is_empty() {
            validate_text(label, "版本标签")?;
        }
    }
    match (artifact.kind, artifact.source_kind) {
        (ArtifactKind::DockerImage, ArtifactSourceKind::DockerRegistry) => {
            safe::validate_image(artifact.source_ref.trim())
                .map_err(|error| anyhow!("镜像名不合法：{error}"))?;
        }
        (ArtifactKind::DockerImage, other) => {
            return Err(anyhow!(
                "Docker 镜像制品的来源必须是镜像仓库（当前：{other:?}）"
            ));
        }
        (_, ArtifactSourceKind::ServerExistingDir) => {
            validate_path(&artifact.source_ref, "服务器制品目录")?;
        }
        (_, ArtifactSourceKind::GitRef) => {
            validate_text(&artifact.source_ref, "Git 引用")?;
        }
        _ => {
            // 本地路径 / 构建产物：只保证不含控制字符（本地路径由本机决定，不参与远程命令）。
            if artifact.source_ref.chars().any(|ch| ch.is_control()) {
                return Err(anyhow!("制品来源不能包含控制字符"));
            }
            if artifact.source_ref.chars().count() > 1024 {
                return Err(anyhow!("制品来源过长"));
            }
        }
    }
    Ok(())
}

pub fn validate_plan(plan: &DeploymentPlan) -> Result<()> {
    validate_name(&plan.name, "方案名称")?;
    validate_text(&plan.notes, "方案备注")?;
    if plan.application_id.trim().is_empty() || plan.environment_id.trim().is_empty() {
        return Err(anyhow!("方案必须归属一个应用与环境"));
    }
    if plan.version < 1 {
        return Err(anyhow!("方案版本必须从 1 开始"));
    }
    Ok(())
}

/// 计划图的合法性：节点 key 唯一、节点归属同一计划、边引用存在、无自环、
/// 无重复边、无环（DAG）。
pub fn validate_plan_graph(graph: &DeploymentPlanGraph) -> Result<()> {
    validate_plan(&graph.plan)?;

    let mut keys: Vec<&str> = Vec::with_capacity(graph.nodes.len());
    let mut node_ids: Vec<&str> = Vec::with_capacity(graph.nodes.len());
    for node in &graph.nodes {
        if node.plan_id != graph.plan.id {
            return Err(anyhow!("节点 {} 不属于当前方案", node.node_key));
        }
        validate_node_key(&node.node_key)?;
        validate_name(&node.title, "节点标题")?;
        validate_params_json(&node.params_json)?;
        if keys.contains(&node.node_key.as_str()) {
            return Err(anyhow!("节点标识重复：{}", node.node_key));
        }
        keys.push(&node.node_key);
        node_ids.push(&node.id);
        // 声明的风险级别不能低于动作的默认级别（不许把迁移标成低风险）。
        if node.risk_level < node.action.default_risk() {
            return Err(anyhow!(
                "节点 {} 的风险级别低于该动作的默认级别，不允许下调",
                node.node_key
            ));
        }
        // 需要审批的动作必须带审批标记（v2 §111.22）。
        if node.action.requires_approval() && !node.approval_required {
            return Err(anyhow!(
                "节点 {} 使用的动作必须开启审批（如数据库迁移、镜像推送、回滚）",
                node.node_key
            ));
        }
    }

    let mut seen_edges: Vec<(&str, &str)> = Vec::with_capacity(graph.edges.len());
    for edge in &graph.edges {
        if edge.plan_id != graph.plan.id {
            return Err(anyhow!("边不属于当前方案"));
        }
        if !node_ids.contains(&edge.from_node_id.as_str())
            || !node_ids.contains(&edge.to_node_id.as_str())
        {
            return Err(anyhow!("边引用了不在本方案里的节点"));
        }
        if edge.from_node_id == edge.to_node_id {
            return Err(anyhow!("节点不能连接到自己"));
        }
        if seen_edges.contains(&(edge.from_node_id.as_str(), edge.to_node_id.as_str())) {
            return Err(anyhow!("存在重复的连线"));
        }
        seen_edges.push((&edge.from_node_id, &edge.to_node_id));
    }

    // 环检测：三色 DFS（白=未访问，灰=在栈上，黑=已完成）。
    let index_of = |id: &str| node_ids.iter().position(|candidate| *candidate == id);
    let mut color = vec![0u8; graph.nodes.len()];
    let adjacency: Vec<Vec<usize>> = graph
        .edges
        .iter()
        .filter_map(|edge| Some((index_of(&edge.from_node_id)?, index_of(&edge.to_node_id)?)))
        .fold(
            vec![Vec::new(); graph.nodes.len()],
            |mut map, (from, to)| {
                map[from].push(to);
                map
            },
        );

    fn visit(node: usize, adjacency: &[Vec<usize>], color: &mut Vec<u8>) -> Result<()> {
        if color[node] == 1 {
            return Err(anyhow!("方案里存在环：部署流程必须是可完成的图"));
        }
        if color[node] == 2 {
            return Ok(());
        }
        color[node] = 1;
        for next in &adjacency[node] {
            visit(*next, adjacency, color)?;
        }
        color[node] = 2;
        Ok(())
    }

    for node in 0..graph.nodes.len() {
        visit(node, &adjacency, &mut color)?;
    }

    Ok(())
}

pub fn validate_run(run: &DeploymentRun) -> Result<()> {
    if run.plan_id.trim().is_empty() || run.application_id.trim().is_empty() {
        return Err(anyhow!("运行记录必须归属一个方案与应用"));
    }
    if run.plan_version < 1 {
        return Err(anyhow!("运行记录必须记录方案版本"));
    }
    if let Some(duration) = run.duration_ms {
        if duration < 0 {
            return Err(anyhow!("耗时不能是负数"));
        }
    }
    Ok(())
}

pub fn validate_release(release: &ReleaseRecord) -> Result<()> {
    validate_name(&release.version_label, "版本标签")?;
    validate_text(&release.notes, "版本备注")?;
    if let Some(digest) = &release.image_digest {
        if !digest.trim().is_empty() {
            // 镜像 digest 形如 `sha256:…`。
            let hex = digest
                .trim()
                .strip_prefix("sha256:")
                .unwrap_or(digest.trim());
            validate_sha256(hex, "镜像 digest")?;
        }
    }
    if let Some(path) = &release.nginx_backup_path {
        if !path.trim().is_empty() {
            validate_path(path, "Nginx 备份路径")?;
        }
    }
    Ok(())
}
