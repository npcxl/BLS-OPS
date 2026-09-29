//! 动作参数的 Rust 侧校验。
//!
//! # 这一层与 `safe` 的分工
//!
//! * 本模块：**语义与范围**。路径要在部署根之下、compose 不能给后端服务发端口、
//!   泛域名不许走 HTTP-01、secret 条目不许带明文……
//! * [`crate::safe`]：**字符与命令文本**。所有值最后都要过它的白名单与引号。
//!
//! 两层都过才算合法。任何一层拒绝，动作都不会执行 —— 这是"深度防御"，
//! 不是重复劳动：本层挡的是"参数合法但组合危险"，`safe` 挡的是"字符能逃出引号"。

use anyhow::{anyhow, Result};

use crate::deployment::validate as plan_validate;
use crate::safe;

use super::model::*;

/// 校验一个动作的全部输入。
///
/// `deploy_root` 是环境声明的部署根目录：所有"部署产物"路径都必须落在它之下。
/// 网关（Nginx）与证书路径不在此列 —— 它们各有自己的围栏
/// （`/etc/nginx` 与 `/etc/letsencrypt`）。
pub fn validate_action(action: &DeploymentAction, deploy_root: Option<&str>) -> Result<()> {
    match action {
        DeploymentAction::CheckDependencies(input) => {
            if input.tools.is_empty() {
                return Err(anyhow!("依赖检查至少要列一个工具"));
            }
            if input.tools.len() > 32 {
                return Err(anyhow!("依赖检查一次最多 32 个工具"));
            }
            Ok(())
        }

        DeploymentAction::EnsureDirectory(input) => {
            path_under_root(&input.path, deploy_root, "目录路径")?;
            if let Some(mode) = input.mode {
                safe::validate_octal_mode(mode)?;
            }
            Ok(())
        }

        DeploymentAction::PrepareReleaseDirectory(input) => {
            path_under_root(&input.release_root, deploy_root, "发布根目录")?;
            validate_version_label(&input.version_label)?;
            if input.keep_releases == 0 {
                return Err(anyhow!("保留版本数至少为 1"));
            }
            if input.keep_releases > 50 {
                return Err(anyhow!("保留版本数最多 50"));
            }
            Ok(())
        }

        DeploymentAction::UploadArtifact(input) => {
            // 本地路径：只要求绝对路径（它在控制端机器上，不属于服务器根目录）。
            safe::validate_abs_path(&input.local_path, "本地制品路径")?;
            path_under_root(&input.remote_dir, deploy_root, "远程目录")?;
            validate_file_name(&input.file_name)?;
            if let Some(hash) = input.expected_sha256.as_deref() {
                plan_validate::validate_sha256(hash, "制品哈希")?;
            }
            Ok(())
        }

        DeploymentAction::VerifyChecksum(input) => {
            path_under_root(&input.remote_path, deploy_root, "远程文件")?;
            plan_validate::validate_sha256(&input.expected_sha256, "制品哈希")
        }

        DeploymentAction::ExtractArchive(input) => {
            path_under_root(&input.archive_path, deploy_root, "归档路径")?;
            path_under_root(&input.dest_dir, deploy_root, "解包目录")?;
            // 归档**可以**躺在解包目录里（上传到发布目录再就地解包是最常见的
            // 流程，tar/unzip 都不会删掉归档本身）。但两者不能是同一个路径：
            // 那意味着"把归档解包到自己身上"，只会得到一个坏文件。
            if input.archive_path.trim_end_matches('/') == input.dest_dir.trim_end_matches('/') {
                return Err(anyhow!("归档路径与解包目录不能相同"));
            }
            Ok(())
        }

        DeploymentAction::BuildDockerImage(input) => {
            path_under_root(&input.context_dir, deploy_root, "构建上下文")?;
            path_under_root(&input.dockerfile, deploy_root, "Dockerfile 路径")?;
            if !safe::is_within(&input.dockerfile, &input.context_dir) {
                return Err(anyhow!("Dockerfile 必须位于构建上下文目录内"));
            }
            safe::validate_image(&input.image_tag)?;
            Ok(())
        }

        DeploymentAction::PullDockerImage(input) => {
            safe::validate_image(&input.image)?;
            if let Some(digest) = input.expected_digest.as_deref() {
                if !digest.starts_with("sha256:") || digest.len() != 71 {
                    return Err(anyhow!("镜像 digest 必须是 sha256:<64 位十六进制>"));
                }
                plan_validate::validate_sha256(&digest["sha256:".len()..], "镜像 digest")?;
            }
            Ok(())
        }

        DeploymentAction::WriteRuntimeConfig(input) => {
            path_under_root(&input.path, deploy_root, "配置文件路径")?;
            safe::validate_octal_mode(input.mode)?;
            if input.entries.is_empty() {
                return Err(anyhow!("运行时配置至少要有一条"));
            }
            if input.entries.len() > 256 {
                return Err(anyhow!("运行时配置条目过多（最多 256 条）"));
            }
            let mut seen: Vec<&str> = Vec::new();
            for entry in &input.entries {
                plan_validate::validate_config_key(&entry.key)?;
                if seen.contains(&entry.key.as_str()) {
                    return Err(anyhow!("配置键重复：{}", entry.key));
                }
                seen.push(&entry.key);
                if entry.secret {
                    // 密钥条目：只允许引用，绝不允许明文值与引用同时缺失。
                    if entry.value.is_some() {
                        return Err(anyhow!(
                            "密钥条目不能带明文值（{}）：值只能来自密钥引用",
                            entry.key
                        ));
                    }
                    let reference = entry
                        .secret_ref_id
                        .as_deref()
                        .filter(|id| !id.trim().is_empty())
                        .ok_or_else(|| anyhow!("密钥条目必须给 secret_ref_id（{}）", entry.key))?;
                    plan_validate::validate_token(reference, "密钥引用 id")?;
                } else if entry.secret_ref_id.is_some() && entry.value.is_none() {
                    return Err(anyhow!(
                        "非密钥条目给了引用却没有值（{}）：二选一即可",
                        entry.key
                    ));
                } else if let Some(value) = entry.value.as_deref() {
                    // 明文值也要过文本长度/控制字符检查（换行会破坏 env 文件）。
                    plan_validate::validate_text(value, "配置值")?;
                    if value.contains('\n') || value.contains('\r') {
                        return Err(anyhow!("配置值不能包含换行（{}）", entry.key));
                    }
                } else if entry.required {
                    return Err(anyhow!("必填配置项必须有值或引用：{}", entry.key));
                }
            }
            Ok(())
        }

        DeploymentAction::WriteComposeFile(input) => {
            path_under_root(&input.compose_path, deploy_root, "Compose 文件路径")?;
            safe::validate_container(&input.project_name)?;
            if input.services.is_empty() {
                return Err(anyhow!("Compose 文件至少要有一个服务"));
            }
            if input.services.len() > 50 {
                return Err(anyhow!("Compose 服务过多（最多 50 个）"));
            }
            let names: Vec<&str> = input
                .services
                .iter()
                .map(|service| service.name.as_str())
                .collect();
            for service in &input.services {
                validate_compose_service(service, &names, deploy_root)?;
            }
            if !input.internal_network.is_empty() {
                safe::validate_container(&input.internal_network)?;
            }
            Ok(())
        }

        DeploymentAction::ComposeUp(input) => {
            path_under_root(&input.compose_path, deploy_root, "Compose 文件路径")?;
            safe::validate_container(&input.project_name)?;
            if input.services.is_empty() {
                return Err(anyhow!("compose up 至少指定一个服务"));
            }
            for service in &input.services {
                safe::validate_container(service)?;
            }
            Ok(())
        }

        DeploymentAction::ComposeDown(input) => {
            path_under_root(&input.compose_path, deploy_root, "Compose 文件路径")?;
            safe::validate_container(&input.project_name).map(|_| ())
        }

        DeploymentAction::WaitContainerHealthy(input) => {
            safe::validate_container(&input.container)?;
            if input.timeout_secs == 0 || input.timeout_secs > 1800 {
                return Err(anyhow!("等待健康检查的超时必须在 1 到 1800 秒之间"));
            }
            if input.interval_secs == 0 || input.interval_secs > 60 {
                return Err(anyhow!("健康检查间隔必须在 1 到 60 秒之间"));
            }
            Ok(())
        }

        DeploymentAction::RestartSystemdUnit(input) => safe::validate_unit(&input.unit).map(|_| ()),

        DeploymentAction::BackupNginxConfig(input) => {
            nginx_config_path(&input.config_path).map(|_| ())
        }

        DeploymentAction::WriteNginxConfig(input) => {
            nginx_config_path(&input.config_path)?;
            validate_nginx_site(&input.site)
        }

        DeploymentAction::RestoreNginxBackup(input) => {
            nginx_config_path(&input.config_path).map(|_| ())
        }

        DeploymentAction::TestNginxConfig(_) | DeploymentAction::ReloadNginx(_) => Ok(()),

        DeploymentAction::VerifyDnsRecord(input) => {
            safe::validate_hostname(&input.domain, "域名")?;
            if let Some(ip) = input.expected_ip.as_deref() {
                ip.parse::<std::net::IpAddr>()
                    .map_err(|_| anyhow!("期望的解析结果必须是 IP 地址：{ip}"))?;
            }
            Ok(())
        }

        DeploymentAction::IssueCertificate(input) => {
            if input.domains.is_empty() {
                return Err(anyhow!("签发证书至少需要一个域名"));
            }
            if input.domains.len() > 20 {
                return Err(anyhow!("单张证书最多 20 个域名"));
            }
            let mut wildcard = false;
            for domain in &input.domains {
                let host = safe::validate_hostname(domain, "域名")?;
                if host.starts_with("*.") {
                    wildcard = true;
                }
            }
            safe::validate_email(&input.email)?;
            match input.challenge {
                CertificateChallenge::Http01 => {
                    // 泛域名**只能**走 DNS-01：HTTP-01 无法验证 `*.example.com`。
                    if wildcard {
                        return Err(anyhow!(
                            "泛域名只能用 DNS-01 验证：HTTP-01 无法验证 *.domain 形式"
                        ));
                    }
                    safe::validate_abs_path(&input.webroot, "webroot 目录")?;
                }
                CertificateChallenge::Dns01 => {
                    // V1 只支持人工 DNS：没有 provider 适配器就不允许配一个假的名字。
                    match input.dns_provider.as_deref() {
                        None | Some("") | Some("manual") => {}
                        Some(other) => {
                            return Err(anyhow!(
                                "DNS-01 在当前版本只支持人工验证（manual），不支持：{other}"
                            ))
                        }
                    }
                }
            }
            Ok(())
        }

        DeploymentAction::RenewCertificate(input) => match input.cert_name.as_deref() {
            Some(name) if !name.is_empty() => safe::validate_cert_name(name).map(|_| ()),
            _ => Ok(()),
        },

        DeploymentAction::HttpHealthCheck(input) => {
            safe::validate_http_url(&input.url)?;
            if !(100..=599).contains(&input.expected_status) {
                return Err(anyhow!("期望的 HTTP 状态码必须在 100 到 599 之间"));
            }
            if input.timeout_secs == 0 || input.timeout_secs > 120 {
                return Err(anyhow!("HTTP 健康检查超时必须在 1 到 120 秒之间"));
            }
            if input.attempts == 0 || input.attempts > 10 {
                return Err(anyhow!("HTTP 健康检查尝试次数必须在 1 到 10 之间"));
            }
            Ok(())
        }

        DeploymentAction::TcpHealthCheck(input) => {
            // 只支持本机：`ss` 只能看本机的监听表（能力层的限制，写在这里
            // 而不是藏进执行器，免得用户以为是网络问题）。
            if !matches!(input.host.as_str(), "127.0.0.1" | "localhost" | "0.0.0.0") {
                return Err(anyhow!(
                    "TCP 健康检查只支持本机地址（127.0.0.1 / localhost / 0.0.0.0）"
                ));
            }
            safe::validate_port(input.port)?;
            if input.attempts == 0 || input.attempts > 10 {
                return Err(anyhow!("TCP 健康检查尝试次数必须在 1 到 10 之间"));
            }
            Ok(())
        }

        DeploymentAction::SwitchReleaseSymlink(input) => {
            path_under_root(&input.link_path, deploy_root, "软链路径")?;
            path_under_root(&input.target_dir, deploy_root, "目标目录")?;
            Ok(())
        }

        DeploymentAction::PromoteRelease(input) => {
            path_under_root(&input.release_root, deploy_root, "发布根目录")?;
            path_under_root(&input.current_link, deploy_root, "当前版本软链")?;
            validate_version_label(&input.version_label)?;
            validate_optional_id(input.service_unit_id.as_deref(), "服务 id")
        }

        DeploymentAction::StopPreviousRelease(input) => match &input.target {
            StopTarget::Container { container } => safe::validate_container(container).map(|_| ()),
            StopTarget::SystemdUnit { unit } => safe::validate_unit(unit).map(|_| ()),
            StopTarget::ComposeStack {
                compose_path,
                project_name,
            } => {
                path_under_root(compose_path, deploy_root, "Compose 文件路径")?;
                safe::validate_container(project_name).map(|_| ())
            }
        },

        DeploymentAction::RollbackRelease(input) => {
            path_under_root(&input.target_dir, deploy_root, "回滚目标目录")?;
            path_under_root(&input.current_link, deploy_root, "当前版本软链")?;
            validate_optional_id(input.service_unit_id.as_deref(), "服务 id")?;
            if let Some(note) = input.data_note.as_deref() {
                plan_validate::validate_text(note, "数据回退说明")?;
            }
            Ok(())
        }

        DeploymentAction::RequireManualStep(input) => {
            if input.reason.trim().is_empty() {
                return Err(anyhow!("人工步骤必须说明原因"));
            }
            plan_validate::validate_text(&input.reason, "人工步骤原因")
        }
    }
}

// -- 各字段校验 ---------------------------------------------------------------

/// 部署产物路径：绝对 + （给了根就）在根之下。
fn path_under_root(path: &str, root: Option<&str>, field: &str) -> Result<()> {
    safe::validate_abs_path(path, field)?;
    if let Some(root) = root.filter(|root| !root.is_empty()) {
        if !safe::is_within(path, root) {
            return Err(anyhow!("{field}必须位于部署根目录 {root} 之内：{path}"));
        }
    }
    Ok(())
}

/// Nginx 配置路径：绝对 + 在 Nginx 配置目录之下。
fn nginx_config_path(path: &str) -> Result<&str> {
    let path = safe::validate_abs_path(path, "Nginx 配置路径")?;
    safe::require_nginx_path(path)?;
    Ok(path)
}

/// 版本标签会直接成为目录名，因此必须是一个安全的单段名字。
fn validate_version_label(label: &str) -> Result<()> {
    plan_validate::validate_token(label, "版本标签")?;
    if label.contains('/') || label == "." || label == ".." {
        return Err(anyhow!("版本标签不能包含路径分隔符"));
    }
    Ok(())
}

/// 文件名：单段，且不能以 `.` 开头（避免造出隐藏文件或 `.`/`..`）。
fn validate_file_name(name: &str) -> Result<()> {
    plan_validate::validate_token(name, "文件名")?;
    if name.contains('/') || name.starts_with('.') {
        return Err(anyhow!("文件名不能包含路径分隔符，也不能以 . 开头"));
    }
    Ok(())
}

fn validate_optional_id(value: Option<&str>, field: &str) -> Result<()> {
    match value {
        Some(id) if !id.trim().is_empty() => plan_validate::validate_token(id, field),
        _ => Ok(()),
    }
}

/// 单个 Compose 服务。
fn validate_compose_service(
    service: &ComposeServiceSpec,
    all_names: &[&str],
    deploy_root: Option<&str>,
) -> Result<()> {
    safe::validate_container(&service.name)?;
    match (&service.image, &service.build_context) {
        (Some(image), None) => {
            safe::validate_image(image)?;
            if service.dockerfile.is_some() {
                return Err(anyhow!(
                    "服务 {} 用了现成镜像，不该再给 Dockerfile",
                    service.name
                ));
            }
        }
        (None, Some(context)) => {
            path_under_root(context, deploy_root, "构建上下文")?;
            let dockerfile = service
                .dockerfile
                .as_deref()
                .ok_or_else(|| anyhow!("服务 {} 用构建方式就必须给 Dockerfile", service.name))?;
            path_under_root(dockerfile, deploy_root, "Dockerfile 路径")?;
            if !safe::is_within(dockerfile, context) {
                return Err(anyhow!(
                    "服务 {} 的 Dockerfile 必须位于构建上下文内",
                    service.name
                ));
            }
        }
        (Some(_), Some(_)) => {
            return Err(anyhow!("服务 {} 只能二选一：镜像或构建", service.name));
        }
        (None, None) => {
            return Err(anyhow!("服务 {} 既没有镜像也没有构建上下文", service.name));
        }
    }

    // "后端默认通过内部网络连接 / 只暴露必要端口"：只走内部网络的服务
    // 一律不许发布宿主机端口。这条是**结构性**的，不是提示。
    if service.internal_only && !service.publish_ports.is_empty() {
        return Err(anyhow!(
            "服务 {} 标记为仅内部访问，不能发布宿主机端口",
            service.name
        ));
    }
    for mapping in &service.publish_ports {
        safe::validate_port(mapping.host_port)?;
        safe::validate_port(mapping.container_port)?;
    }
    for port in &service.expose_ports {
        safe::validate_port(*port)?;
    }
    if let Some(env_file) = service.env_file.as_deref() {
        path_under_root(env_file, deploy_root, "环境变量文件")?;
    }
    for dependency in &service.depends_on {
        if dependency == &service.name {
            return Err(anyhow!("服务 {} 不能依赖自己", service.name));
        }
        if !all_names.contains(&dependency.as_str()) {
            return Err(anyhow!(
                "服务 {} 依赖了未声明的服务：{dependency}",
                service.name
            ));
        }
    }
    for network in &service.networks {
        safe::validate_container(network)?;
    }
    if let Some(path) = service.healthcheck_path.as_deref() {
        if !path.starts_with('/') {
            return Err(anyhow!("健康检查路径必须以 / 开头：{path}"));
        }
    }
    Ok(())
}

/// Nginx 站点规格：`server_name` / 监听端口 / 站点根与反代二选一 / 证书成对。
fn validate_nginx_site(site: &NginxSiteSpec) -> Result<()> {
    plan_validate::validate_token(&site.site_name, "站点名")?;
    if site.site_name.contains('/') {
        return Err(anyhow!("站点名不能包含路径分隔符"));
    }
    if site.server_names.is_empty() {
        return Err(anyhow!("站点至少要有一个域名"));
    }
    for domain in &site.server_names {
        safe::validate_hostname(domain, "站点域名")?;
    }
    safe::validate_port(site.listen_port)?;
    if !site.path_prefix.starts_with('/') {
        return Err(anyhow!("路径前缀必须以 / 开头"));
    }
    match (&site.root, &site.proxy_pass) {
        (Some(root), None) => {
            safe::validate_abs_path(root, "站点根目录")?;
        }
        (None, Some(target)) => {
            plan_validate::validate_token(target, "反向代理目标")?;
            if !target.contains(':') {
                return Err(anyhow!("反向代理目标必须形如 127.0.0.1:3000"));
            }
        }
        (Some(_), Some(_)) => {
            return Err(anyhow!("站点只能二选一：静态根目录或反向代理"));
        }
        (None, None) => {
            return Err(anyhow!("站点必须给静态根目录或反向代理目标"));
        }
    }
    match (&site.ssl_certificate, &site.ssl_certificate_key) {
        (Some(cert), Some(key)) => {
            safe::validate_abs_path(cert, "证书路径")?;
            safe::validate_abs_path(key, "证书私钥路径")?;
        }
        (None, None) => {}
        _ => return Err(anyhow!("证书与私钥必须成对提供")),
    }
    if let Some(size) = site.client_max_body_size_mb {
        if size == 0 || size > 10_240 {
            return Err(anyhow!("上传体积上限必须在 1 到 10240 MB 之间"));
        }
    }
    Ok(())
}
