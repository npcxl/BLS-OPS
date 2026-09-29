//! 29 个动作的执行实现。
//!
//! 每个函数只做三件事：**把参数交给能力层**、**把结果解析成事实**、
//! **把事实（脱敏后）写成一行日志**。没有第四件事 —— 特别是没有"顺手拼一条命令"。

use std::time::Duration;

use crate::deployment::action::model::*;
use crate::safe::{
    ArchiveFormat as CapArchiveFormat, Capability, ContainerAction, ProbeTool, ServiceAction,
};
use crate::ssh::KIND_DIRECTORY;

use super::{render, ExecContext, ExecOutcome};

/// 动作分发（穷尽 `match`：新增动作不实现就编译不过）。
pub async fn run(action: &DeploymentAction, ctx: &ExecContext<'_>) -> Result<ExecOutcome, String> {
    match action {
        DeploymentAction::CheckDependencies(input) => check_dependencies(input, ctx).await,
        DeploymentAction::EnsureDirectory(input) => ensure_directory(input, ctx).await,
        DeploymentAction::PrepareReleaseDirectory(input) => {
            prepare_release_directory(input, ctx).await
        }
        DeploymentAction::UploadArtifact(input) => upload_artifact(input, ctx).await,
        DeploymentAction::VerifyChecksum(input) => verify_checksum(input, ctx).await,
        DeploymentAction::ExtractArchive(input) => extract_archive(input, ctx).await,
        DeploymentAction::BuildDockerImage(input) => build_image(input, ctx).await,
        DeploymentAction::PullDockerImage(input) => pull_image(input, ctx).await,
        DeploymentAction::WriteRuntimeConfig(input) => write_runtime_config(input, ctx).await,
        DeploymentAction::WriteComposeFile(input) => write_compose_file(input, ctx).await,
        DeploymentAction::ComposeUp(input) => compose_up(input, ctx).await,
        DeploymentAction::ComposeDown(input) => compose_down(input, ctx).await,
        DeploymentAction::WaitContainerHealthy(input) => wait_healthy(input, ctx).await,
        DeploymentAction::RestartSystemdUnit(input) => restart_unit(input, ctx).await,
        DeploymentAction::BackupNginxConfig(input) => backup_nginx(input, ctx).await,
        DeploymentAction::WriteNginxConfig(input) => write_nginx(input, ctx).await,
        DeploymentAction::RestoreNginxBackup(input) => restore_nginx(input, ctx).await,
        DeploymentAction::TestNginxConfig(_) => test_nginx(ctx).await,
        DeploymentAction::ReloadNginx(_) => reload_nginx(ctx).await,
        DeploymentAction::VerifyDnsRecord(input) => verify_dns(input, ctx).await,
        DeploymentAction::IssueCertificate(input) => issue_certificate(input, ctx).await,
        DeploymentAction::RenewCertificate(input) => renew_certificate(input, ctx).await,
        DeploymentAction::HttpHealthCheck(input) => http_health(input, ctx).await,
        DeploymentAction::TcpHealthCheck(input) => tcp_health(input, ctx).await,
        DeploymentAction::SwitchReleaseSymlink(input) => switch_symlink(input, ctx).await,
        DeploymentAction::PromoteRelease(input) => promote(input, ctx).await,
        DeploymentAction::StopPreviousRelease(input) => stop_previous(input, ctx).await,
        DeploymentAction::RollbackRelease(input) => rollback(input, ctx).await,
        DeploymentAction::RequireManualStep(input) => manual_step(input, ctx),
    }
}

// -- 预检与准备 ---------------------------------------------------------------

async fn check_dependencies(
    input: &CheckDependenciesInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let mut missing: Vec<&str> = Vec::new();
    let mut found: Vec<String> = Vec::new();
    for tool in &input.tools {
        let probe = probe_for(*tool);
        let output = cap(ctx, &Capability::ToolVersion(probe)).await;
        match output {
            Ok(version) => {
                let version = version
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                found.push(format!("{} {}", probe.name(), version));
            }
            Err(_) => missing.push(probe.name()),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "服务器缺少必需的工具：{}。请先安装（或改用不需要它的部署形态）后再重试。",
            missing.join("、")
        ));
    }
    Ok(ExecOutcome::done(format!(
        "依赖检查通过：{}",
        found.join("；")
    )))
}

fn probe_for(tool: RequiredTool) -> ProbeTool {
    match tool {
        RequiredTool::Docker => ProbeTool::Docker,
        RequiredTool::DockerCompose => ProbeTool::DockerCompose,
        RequiredTool::Nginx => ProbeTool::Nginx,
        RequiredTool::Systemctl => ProbeTool::Systemctl,
        RequiredTool::Curl => ProbeTool::Curl,
        RequiredTool::Certbot => ProbeTool::Certbot,
        RequiredTool::Unzip => ProbeTool::Unzip,
        RequiredTool::Tar => ProbeTool::Tar,
        RequiredTool::Sha256Sum => ProbeTool::Sha256Sum,
    }
}

async fn ensure_directory(
    input: &EnsureDirectoryInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    cap(
        ctx,
        &Capability::MakeDirs {
            path: input.path.clone(),
        },
    )
    .await?;
    if let Some(mode) = input.mode {
        cap(
            ctx,
            &Capability::Chmod {
                path: input.path.clone(),
                mode,
            },
        )
        .await?;
    }
    ctx.note(format!("目录就绪：{}", input.path));
    Ok(ExecOutcome::done(format!("目录已就绪：{}", input.path)))
}

async fn prepare_release_directory(
    input: &PrepareReleaseDirectoryInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let release_dir = format!(
        "{}/{}",
        input.release_root.trim_end_matches('/'),
        input.version_label
    );
    cap(
        ctx,
        &Capability::MakeDirs {
            path: input.release_root.clone(),
        },
    )
    .await?;
    cap(
        ctx,
        &Capability::MakeDirs {
            path: release_dir.clone(),
        },
    )
    .await?;

    // 清理旧版本：只删**发布根直下的子目录**，且保留最近 `keep_releases` 个。
    let mut removed: Vec<String> = Vec::new();
    if let Ok((_, entries)) = ctx
        .ssh
        .sftp_list_dir(ctx.session_id, Some(input.release_root.clone()))
        .await
    {
        let mut versions: Vec<String> = entries
            .iter()
            .filter(|entry| entry.kind == KIND_DIRECTORY && !entry.hidden)
            .map(|entry| entry.name.clone())
            .collect();
        versions.sort_by(|left, right| crate::ssh::natural_cmp(left, right));
        let keep = input.keep_releases.max(1) as usize;
        if versions.len() > keep {
            let stale = versions.len() - keep;
            for name in versions.into_iter().take(stale) {
                if name == input.version_label {
                    continue;
                }
                let path = format!("{}/{}", input.release_root.trim_end_matches('/'), name);
                cap(ctx, &Capability::RemoveDirectory { path }).await?;
                removed.push(name);
            }
        }
    }
    if removed.is_empty() {
        Ok(ExecOutcome::done(format!("发布目录已就绪：{release_dir}")))
    } else {
        Ok(ExecOutcome::done(format!(
            "发布目录已就绪：{release_dir}；清理旧版本：{}",
            removed.join("、")
        )))
    }
}

// -- 制品 --------------------------------------------------------------------

async fn upload_artifact(
    input: &UploadArtifactInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    ctx.note(format!(
        "开始上传 {} → {}/{}",
        input.local_path, input.remote_dir, input.file_name
    ));
    let progress = |done: u64, total: u64| {
        // 只在每 25% 打一行，避免日志被进度淹没。
        if total > 0 && (done == total || done % (total / 4).max(1) == 0) {
            let percent = (done as f64 / total as f64 * 100.0).round() as u32;
            (ctx.log)(&format!("上传进度 {percent}%（{done}/{total} 字节）"));
        }
    };
    let outcome = crate::deployment::artifact::remote::upload_artifact(
        ctx.ssh,
        ctx.session_id,
        std::path::Path::new(&input.local_path),
        &input.remote_dir,
        &input.file_name,
        input.expected_sha256.as_deref(),
        &progress,
    )
    .await?;
    ctx.note(format!(
        "上传完成：{}（{} 字节，sha256 {}）",
        outcome.remote_path,
        outcome.size_bytes,
        short_hash(&outcome.sha256)
    ));
    Ok(ExecOutcome::done(format!(
        "已上传 {}（{} 字节）",
        outcome.remote_path, outcome.size_bytes
    )))
}

async fn verify_checksum(
    input: &VerifyChecksumInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let output = cap(
        ctx,
        &Capability::Checksum {
            path: input.remote_path.clone(),
        },
    )
    .await?;
    let actual = parse_checksum(&output)
        .ok_or_else(|| format!("无法从 sha256sum 输出里读出哈希：{}", output.trim()))?;
    if !actual.eq_ignore_ascii_case(&input.expected_sha256) {
        return Err(format!(
            "制品哈希不一致：期望 {}，实际 {}（文件已损坏或被替换）",
            short_hash(&input.expected_sha256),
            short_hash(&actual)
        ));
    }
    Ok(ExecOutcome::done(format!(
        "哈希校验通过（{}）",
        short_hash(&actual)
    )))
}

async fn extract_archive(
    input: &ExtractArchiveInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let format = match input.format {
        ArchiveFormat::Zip => CapArchiveFormat::Zip,
        ArchiveFormat::Tar => CapArchiveFormat::Tar,
        ArchiveFormat::TarGz => CapArchiveFormat::TarGz,
    };
    cap(
        ctx,
        &Capability::ExtractArchive {
            archive: input.archive_path.clone(),
            dest: input.dest_dir.clone(),
            format,
        },
    )
    .await?;
    Ok(ExecOutcome::done(format!("已解包到 {}", input.dest_dir)))
}

async fn build_image(
    input: &BuildDockerImageInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let output = cap(
        ctx,
        &Capability::DockerBuild {
            context: input.context_dir.clone(),
            dockerfile: input.dockerfile.clone(),
            tag: input.image_tag.clone(),
        },
    )
    .await?;
    let tail = last_lines(&output, 3);
    Ok(ExecOutcome::done(format!(
        "镜像构建完成：{}{}",
        input.image_tag,
        if tail.is_empty() {
            String::new()
        } else {
            format!("（{tail}）")
        }
    )))
}

async fn pull_image(
    input: &PullDockerImageInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let output = cap(
        ctx,
        &Capability::DockerPull {
            image: input.image.clone(),
        },
    )
    .await?;
    if let Some(expected) = input.expected_digest.as_deref() {
        if !output.contains(expected) {
            return Err(format!(
                "拉取到的镜像 digest 与期望不一致（期望 {expected}）"
            ));
        }
    }
    Ok(ExecOutcome::done(format!("镜像已拉取：{}", input.image)))
}

// -- 配置 --------------------------------------------------------------------

async fn write_runtime_config(
    input: &WriteRuntimeConfigInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let mut resolved: Vec<(String, String)> = Vec::new();
    for entry in &input.entries {
        if entry.secret {
            let reference_id = entry
                .secret_ref_id
                .as_deref()
                .ok_or_else(|| format!("密钥条目缺少引用：{}", entry.key))?;
            let reference = ctx
                .lookup_secret(reference_id)
                .ok_or_else(|| format!("找不到密钥引用 {reference_id}（{}）", entry.key))?;
            let value = ctx.secrets.resolve(&reference)?;
            // 记进脱敏器：这个值从此不会以明文出现在任何日志里。
            ctx.scrubber.remember(&value);
            resolved.push((entry.key.clone(), value));
        } else if let Some(value) = entry.value.clone() {
            resolved.push((entry.key.clone(), value));
        } else if entry.required {
            return Err(format!("必填配置项没有值：{}", entry.key));
        }
    }

    let content = render::env_file_from_entries(&input.entries, &resolved);
    let missing: Vec<&str> = input
        .entries
        .iter()
        .filter(|entry| entry.required && !resolved.iter().any(|(key, _)| key == &entry.key))
        .map(|entry| entry.key.as_str())
        .collect();
    if !missing.is_empty() {
        return Err(format!("必填配置项没有解析出值：{}", missing.join("、")));
    }
    ctx.ssh
        .sftp_write_file(ctx.session_id, &input.path, &content)
        .await
        .map_err(|error| error.to_string())?;
    cap(
        ctx,
        &Capability::Chmod {
            path: input.path.clone(),
            mode: input.mode,
        },
    )
    .await?;
    // 只记键名与条数：值（尤其密钥）绝不进日志。
    ctx.note(format!(
        "已写入 {}（{} 个配置项：{}）",
        input.path,
        resolved.len(),
        input
            .entries
            .iter()
            .map(|entry| entry.key.as_str())
            .collect::<Vec<_>>()
            .join("、")
    ));
    Ok(ExecOutcome::done(format!(
        "运行时配置已写入 {}（{} 项）",
        input.path,
        resolved.len()
    )))
}

async fn write_compose_file(
    input: &WriteComposeFileInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let content = render::compose_file(input);
    ctx.ssh
        .sftp_write_file(ctx.session_id, &input.compose_path, &content)
        .await
        .map_err(|error| error.to_string())?;
    let published: Vec<String> = input
        .services
        .iter()
        .filter(|service| !service.publish_ports.is_empty())
        .map(|service| {
            format!(
                "{}:{}",
                service.name,
                service
                    .publish_ports
                    .iter()
                    .map(|mapping| format!("{}→{}", mapping.host_port, mapping.container_port))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        })
        .collect();
    ctx.note(format!(
        "已生成 Compose 文件 {}（{} 个服务）",
        input.compose_path,
        input.services.len()
    ));
    Ok(ExecOutcome::done(format!(
        "Compose 文件已生成：{} 个服务；对外发布端口：{}",
        input.services.len(),
        if published.is_empty() {
            "无（全部仅内部访问）".to_string()
        } else {
            published.join("；")
        }
    )))
}

// -- 容器与进程 ---------------------------------------------------------------

async fn compose_up(input: &ComposeUpInput, ctx: &ExecContext<'_>) -> Result<ExecOutcome, String> {
    ensure_compose_file_exists(input, ctx).await?;
    let output = cap(
        ctx,
        &Capability::ComposeUp {
            file: input.compose_path.clone(),
            project: input.project_name.clone(),
            services: input.services.clone(),
        },
    )
    .await?;
    let tail = last_lines(&output, 3);
    Ok(ExecOutcome::done(format!(
        "Compose 栈已启动：{}（{}）",
        input.project_name,
        if tail.is_empty() {
            "无输出".to_string()
        } else {
            tail
        }
    )))
}

async fn compose_down(
    input: &ComposeDownInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    cap(
        ctx,
        &Capability::ComposeDown {
            file: input.compose_path.clone(),
            project: input.project_name.clone(),
        },
    )
    .await?;
    Ok(ExecOutcome::done(format!(
        "Compose 栈已停止：{}",
        input.project_name
    )))
}

async fn ensure_compose_file_exists(
    input: &ComposeUpInput,
    ctx: &ExecContext<'_>,
) -> Result<(), String> {
    ctx.ssh
        .sftp_stat(ctx.session_id, &input.compose_path)
        .await
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Compose 文件不存在：{}（请先执行“生成 Compose 文件”节点，或把该文件放到路径上）：{error}",
                input.compose_path
            )
        })
}

async fn wait_healthy(
    input: &WaitContainerHealthyInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let deadline = std::time::Instant::now() + Duration::from_secs(input.timeout_secs as u64);
    let mut last = String::new();
    loop {
        ctx.check_cancel()?;
        let output = cap(
            ctx,
            &Capability::DockerInspect {
                container: input.container.clone(),
            },
        )
        .await?;
        match container_health(&output) {
            HealthState::Healthy => {
                return Ok(ExecOutcome::done(format!(
                    "容器 {} 已健康",
                    input.container
                )))
            }
            HealthState::Running => {
                return Ok(ExecOutcome::done(format!(
                    "容器 {} 正在运行（未配置 healthcheck，按运行状态判定）",
                    input.container
                )))
            }
            HealthState::Starting => last = "启动中".to_string(),
            HealthState::Unhealthy(detail) => {
                return Err(format!("容器 {} 处于 unhealthy：{detail}", input.container))
            }
            HealthState::NotFound => {
                return Err(format!("容器 {} 不存在", input.container));
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!(
                "等待容器 {} 健康超时（{} 秒，最后状态：{last}）",
                input.container, input.timeout_secs
            ));
        }
        tokio::time::sleep(Duration::from_secs(input.interval_secs.max(1) as u64)).await;
    }
}

async fn restart_unit(
    input: &RestartSystemdUnitInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    cap(
        ctx,
        &Capability::ServiceAction {
            action: ServiceAction::Restart,
            unit: input.unit.clone(),
        },
    )
    .await?;
    Ok(ExecOutcome::done(format!("服务单元已重启：{}", input.unit)))
}

// -- Nginx -------------------------------------------------------------------

/// 备份结果里带回的备份路径（写配置时要用它做前置校验）。
fn backup_path(config_path: &str) -> String {
    format!("{config_path}.blsops.bak")
}

async fn backup_nginx(
    input: &BackupNginxConfigInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    // 备份前不校验"文件是否存在"：第一次部署时目标文件本来就不存在。
    // `cp` 失败（文件不存在）是预期的，此时没有备份也不影响写新配置。
    let existing = ctx
        .ssh
        .sftp_stat(ctx.session_id, &input.config_path)
        .await
        .is_ok();
    if !existing {
        return Ok(ExecOutcome::done(format!(
            "{} 尚不存在（首次写入），无需备份",
            input.config_path
        )));
    }
    crate::nginx::backup_config(ctx.ssh, ctx.session_id, &input.config_path)
        .await
        .map_err(|error| error.to_string())?;
    let target = backup_path(&input.config_path);
    ctx.ssh
        .sftp_stat(ctx.session_id, &target)
        .await
        .map_err(|error| format!("备份没有落盘（{target}）：{error}"))?;
    Ok(ExecOutcome::done(format!("已备份到 {target}")))
}

async fn write_nginx(
    input: &WriteNginxConfigInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    // 硬前置：已有配置必须先有备份，否则不允许覆盖。
    let existing = ctx
        .ssh
        .sftp_stat(ctx.session_id, &input.config_path)
        .await
        .is_ok();
    if existing {
        let target = backup_path(&input.config_path);
        if ctx.ssh.sftp_stat(ctx.session_id, &target).await.is_err() {
            return Err(format!(
                "拒绝覆盖 {0}：没有找到备份 {1}。请先执行“备份 Nginx 配置”节点。",
                input.config_path, target
            ));
        }
    }
    let content = render::nginx_site(&input.site);
    ctx.ssh
        .sftp_write_file(ctx.session_id, &input.config_path, &content)
        .await
        .map_err(|error| error.to_string())?;
    if input.enable_site {
        cap(
            ctx,
            &Capability::NginxSetSiteEnabled {
                site: input.site.site_name.clone(),
                enable: true,
            },
        )
        .await?;
    }
    ctx.note(format!(
        "已写入 Nginx 站点 {}（{}）",
        input.site.site_name,
        input.site.server_names.join("、")
    ));
    Ok(ExecOutcome::done(format!(
        "Nginx 配置已写入 {}（站点 {}）",
        input.config_path, input.site.site_name
    )))
}

async fn restore_nginx(
    input: &RestoreNginxBackupInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let target = backup_path(&input.config_path);
    let content = ctx
        .ssh
        .sftp_read_file(ctx.session_id, &target, 1024 * 1024)
        .await
        .map_err(|error| format!("读不到备份 {target}：{error}"))?
        .content
        .ok_or_else(|| format!("备份 {target} 不是文本内容，无法还原"))?;
    ctx.ssh
        .sftp_write_file(ctx.session_id, &input.config_path, &content)
        .await
        .map_err(|error| error.to_string())?;
    // 还原之后立刻验证：还原出来的东西也可能是坏的，那就不能 reload。
    let test = crate::nginx::test_config(ctx.ssh, ctx.session_id)
        .await
        .map_err(|error| error.to_string())?;
    if !test.success {
        return Err(format!(
            "已还原 {target}，但 nginx -t 未通过，**没有** reload。输出：{}",
            test.output
        ));
    }
    crate::nginx::reload(ctx.ssh, ctx.session_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(ExecOutcome::done(format!(
        "已从 {target} 还原并重载（nginx -t 通过）"
    )))
}

async fn test_nginx(ctx: &ExecContext<'_>) -> Result<ExecOutcome, String> {
    let test = crate::nginx::test_config(ctx.ssh, ctx.session_id)
        .await
        .map_err(|error| error.to_string())?;
    if !test.success {
        return Err(format!("nginx -t 未通过：{}", test.output));
    }
    Ok(ExecOutcome::done("nginx -t 通过".to_string()))
}

async fn reload_nginx(ctx: &ExecContext<'_>) -> Result<ExecOutcome, String> {
    // 再测一次：这是"没通过 nginx -t 绝不 reload"的执行侧防线（校验层也挡了一道）。
    let test = crate::nginx::test_config(ctx.ssh, ctx.session_id)
        .await
        .map_err(|error| error.to_string())?;
    if !test.success {
        return Err(format!(
            "拒绝 reload：nginx -t 未通过。输出：{}",
            test.output
        ));
    }
    crate::nginx::reload(ctx.ssh, ctx.session_id)
        .await
        .map_err(|error| error.to_string())?;
    Ok(ExecOutcome::done("Nginx 已重载".to_string()))
}

// -- 域名与证书 ---------------------------------------------------------------

async fn verify_dns(
    input: &VerifyDnsRecordInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let output = cap(
        ctx,
        &Capability::ResolveHost {
            hostname: input.domain.clone(),
        },
    )
    .await
    .map_err(|error| format!("域名 {} 解析失败：{error}", input.domain))?;
    let addresses = parse_addresses(&output);
    if addresses.is_empty() {
        return Err(format!("域名 {} 没有解析到任何地址", input.domain));
    }
    if let Some(expected) = input.expected_ip.as_deref() {
        if !addresses.iter().any(|address| address == expected) {
            return Err(format!(
                "域名 {} 解析到 {}，与期望的 {} 不一致（DNS 可能还没生效）",
                input.domain,
                addresses.join("、"),
                expected
            ));
        }
    }
    ctx.note(format!(
        "域名 {} 解析到 {}",
        input.domain,
        addresses.join("、")
    ));
    Ok(ExecOutcome::done(format!(
        "域名 {} 解析正常（{}）",
        input.domain,
        addresses.join("、")
    )))
}

async fn issue_certificate(
    input: &IssueCertificateInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    match input.challenge {
        CertificateChallenge::Dns01 => {
            // V1：DNS-01 只给人工指引 + 解析验证，**不调用任何服务商 API**。
            // 这里不假装成功：证书还没有签发，必须由人加完记录后再继续。
            let records: Vec<String> = input
                .domains
                .iter()
                .map(|domain| {
                    let base = domain.trim_start_matches("*.");
                    format!("_acme-challenge.{base} TXT <由 certbot 输出的值>")
                })
                .collect();
            let mut verified: Vec<String> = Vec::new();
            for domain in &input.domains {
                let base = domain.trim_start_matches("*.").to_string();
                if let Ok(output) = cap(
                    ctx,
                    &Capability::ResolveHost {
                        hostname: base.clone(),
                    },
                )
                .await
                {
                    if !parse_addresses(&output).is_empty() {
                        verified.push(base);
                    }
                }
            }
            Ok(ExecOutcome {
                summary: format!(
                    "DNS-01 需要人工操作：请在权威 DNS 添加以下记录 —— {}。已确认可解析的域名：{}。\
                     添加完成后由人工确认继续，本工具不调用任何 DNS 服务商 API。",
                    records.join("；"),
                    if verified.is_empty() {
                        "无".to_string()
                    } else {
                        verified.join("、")
                    }
                ),
                needs_acknowledgement: true,
            })
        }
        CertificateChallenge::Http01 => {
            // HTTP-01 的硬前提：域名必须已经解析到本机，否则 CA 回调不到。
            let primary = input
                .domains
                .first()
                .ok_or_else(|| "签发证书缺少域名".to_string())?
                .clone();
            let output = cap(
                ctx,
                &Capability::ResolveHost {
                    hostname: primary.clone(),
                },
            )
            .await
            .map_err(|error| {
                format!("无法验证 {primary} 的解析（HTTP-01 需要它已生效）：{error}")
            })?;
            if parse_addresses(&output).is_empty() {
                return Err(format!(
                    "域名 {primary} 尚未解析到任何地址，不能申请 HTTP-01 证书"
                ));
            }
            cap(
                ctx,
                &Capability::MakeDirs {
                    path: input.webroot.clone(),
                },
            )
            .await?;
            let output = cap(
                ctx,
                &Capability::CertbotIssue {
                    domains: input.domains.clone(),
                    email: input.email.clone(),
                    webroot: input.webroot.clone(),
                },
            )
            .await?;
            Ok(ExecOutcome::done(format!(
                "证书已签发/确认有效：{}{}",
                input.domains.join("、"),
                if output.trim().is_empty() {
                    String::new()
                } else {
                    format!("（{}）", last_lines(&output, 2))
                }
            )))
        }
    }
}

async fn renew_certificate(
    input: &RenewCertificateInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let output = cap(
        ctx,
        &Capability::CertbotRenew {
            cert_name: input.cert_name.clone(),
        },
    )
    .await?;
    Ok(ExecOutcome::done(format!(
        "证书续期检查完成：{}",
        if output.trim().is_empty() {
            "未到期，无需续期".to_string()
        } else {
            last_lines(&output, 2)
        }
    )))
}

// -- 健康检查 -----------------------------------------------------------------

async fn http_health(
    input: &HttpHealthCheckInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let mut last = String::new();
    for attempt in 1..=input.attempts.max(1) {
        ctx.check_cancel()?;
        let output = cap(
            ctx,
            &Capability::HttpProbe {
                url: input.url.clone(),
                timeout_secs: input.timeout_secs,
            },
        )
        .await;
        match output {
            Ok(text) => {
                let status = parse_http_status(&text);
                if status == Some(input.expected_status) {
                    return Ok(ExecOutcome::done(format!(
                        "HTTP 健康检查通过：{} → {}",
                        input.url, input.expected_status
                    )));
                }
                last = match status {
                    Some(code) => format!("HTTP {code}"),
                    None => format!("无法解析状态码（{}）", text.trim()),
                };
            }
            Err(error) => last = error,
        }
        if attempt < input.attempts.max(1) {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    Err(format!(
        "HTTP 健康检查失败：{}（期望 {}，最后一次：{last}）",
        input.url, input.expected_status
    ))
}

async fn tcp_health(
    input: &TcpHealthCheckInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    for attempt in 1..=input.attempts.max(1) {
        ctx.check_cancel()?;
        let output = cap(ctx, &Capability::CheckTcpPort { port: input.port }).await;
        if let Ok(text) = output {
            if !text.trim().is_empty() {
                return Ok(ExecOutcome::done(format!(
                    "TCP 健康检查通过：端口 {} 正在监听",
                    input.port
                )));
            }
        }
        if attempt < input.attempts.max(1) {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
    Err(format!(
        "TCP 健康检查失败：{}:{} 没有监听（本机）",
        input.host, input.port
    ))
}

// -- 提升与回滚 ---------------------------------------------------------------

async fn switch_symlink(
    input: &SwitchReleaseSymlinkInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    ctx.ssh
        .sftp_stat(ctx.session_id, &input.target_dir)
        .await
        .map_err(|error| format!("目标目录不存在（{}）：{error}", input.target_dir))?;
    cap(
        ctx,
        &Capability::SymlinkForce {
            link: input.link_path.clone(),
            target: input.target_dir.clone(),
        },
    )
    .await?;
    Ok(ExecOutcome::done(format!(
        "{} → {}",
        input.link_path, input.target_dir
    )))
}

async fn promote(
    input: &PromoteReleaseInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    let target = format!(
        "{}/{}",
        input.release_root.trim_end_matches('/'),
        input.version_label
    );
    ctx.ssh
        .sftp_stat(ctx.session_id, &target)
        .await
        .map_err(|error| format!("发布目录不存在（{target}）：{error}"))?;
    let previous = current_release(&input.current_link, ctx).await;
    cap(
        ctx,
        &Capability::SymlinkForce {
            link: input.current_link.clone(),
            target: target.clone(),
        },
    )
    .await?;
    Ok(ExecOutcome::done(match previous {
        Some(previous) => format!("已激活 {target}（上一版：{previous}）"),
        None => format!("已激活 {target}（首次部署，没有上一版）"),
    }))
}

async fn stop_previous(
    input: &StopPreviousReleaseInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    match &input.target {
        StopTarget::Container { container } => {
            cap(
                ctx,
                &Capability::ContainerAction {
                    action: ContainerAction::Stop,
                    container: container.clone(),
                },
            )
            .await?;
            Ok(ExecOutcome::done(format!("旧容器已停止：{container}")))
        }
        StopTarget::SystemdUnit { unit } => {
            cap(
                ctx,
                &Capability::ServiceAction {
                    action: ServiceAction::Stop,
                    unit: unit.clone(),
                },
            )
            .await?;
            Ok(ExecOutcome::done(format!("旧服务单元已停止：{unit}")))
        }
        StopTarget::ComposeStack {
            compose_path,
            project_name,
        } => {
            cap(
                ctx,
                &Capability::ComposeDown {
                    file: compose_path.clone(),
                    project: project_name.clone(),
                },
            )
            .await?;
            Ok(ExecOutcome::done(format!(
                "旧 Compose 栈已停止：{project_name}"
            )))
        }
    }
}

async fn rollback(
    input: &RollbackReleaseInput,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    // 编译期不知道"上一版"是哪个目录（那是运行时事实），因此这里解析：
    // 1) 若给出的目标目录存在，就用它；2) 否则按 current 软链定位上一版。
    let target = if ctx
        .ssh
        .sftp_stat(ctx.session_id, &input.target_dir)
        .await
        .is_ok()
    {
        input.target_dir.clone()
    } else {
        previous_release(&input.current_link, ctx).await?
    };
    cap(
        ctx,
        &Capability::SymlinkForce {
            link: input.current_link.clone(),
            target: target.clone(),
        },
    )
    .await?;
    let data_note = input
        .data_note
        .clone()
        .unwrap_or_else(|| "数据侧未回退（服务版本回滚不还原数据库）".to_string());
    Ok(ExecOutcome::done(format!(
        "已回滚：{} → {}；{data_note}",
        input.current_link, target
    )))
}

fn manual_step(
    input: &RequireManualStepInput,
    _ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    if input.acknowledged {
        Ok(ExecOutcome::done(format!(
            "人工步骤已确认：{}",
            input.reason
        )))
    } else {
        Ok(ExecOutcome {
            summary: format!("需要人工完成并确认：{}", input.reason),
            needs_acknowledgement: true,
        })
    }
}

// -- 解析助手（纯函数，全部有单测）--------------------------------------------

/// `sha256sum` 输出 → 哈希。
pub fn parse_checksum(output: &str) -> Option<String> {
    output
        .split_whitespace()
        .next()
        .filter(|token| token.len() == 64 && token.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(|token| token.to_ascii_lowercase())
}

/// `getent ahosts` 输出 → IP 列表（去重，保持出现顺序）。
pub fn parse_addresses(output: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in output.lines() {
        let Some(first) = line.split_whitespace().next() else {
            continue;
        };
        if first.parse::<std::net::IpAddr>().is_err() {
            continue;
        }
        if !out.iter().any(|existing| existing == first) {
            out.push(first.to_string());
        }
    }
    out
}

/// `curl -w '%{http_code}'` 输出 → 状态码。
pub fn parse_http_status(output: &str) -> Option<u16> {
    output.trim().parse::<u16>().ok()
}

/// 容器健康状态（从 `docker inspect` 的 JSON 里读）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HealthState {
    Healthy,
    Starting,
    Unhealthy(String),
    /// 没有配置 healthcheck，但容器在跑。
    Running,
    NotFound,
}

/// 解析 `docker inspect --format '{{json .}}'` 的输出。
pub fn container_health(json: &str) -> HealthState {
    let value: serde_json::Value = match serde_json::from_str(json.trim()) {
        Ok(value) => value,
        Err(_) => return HealthState::NotFound,
    };
    let state = &value["State"];
    if state.is_null() {
        return HealthState::NotFound;
    }
    if let Some(health) = state.get("Health") {
        let status = health["Status"].as_str().unwrap_or("");
        return match status {
            "healthy" => HealthState::Healthy,
            "unhealthy" => HealthState::Unhealthy(
                health["Log"]
                    .as_array()
                    .and_then(|log| log.last())
                    .and_then(|entry| entry["Output"].as_str())
                    .map(|text| text.trim().to_string())
                    .unwrap_or_else(|| "无日志".to_string()),
            ),
            _ => HealthState::Starting,
        };
    }
    match state["Running"].as_bool() {
        Some(true) => HealthState::Running,
        Some(false) => HealthState::Unhealthy("容器已退出".to_string()),
        None => HealthState::NotFound,
    }
}

/// `readlink -f` 输出 → 当前版本目录名（末段）。
pub fn release_name_from_link(output: &str) -> Option<String> {
    let path = output.trim();
    if path.is_empty() {
        return None;
    }
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

async fn current_release(current_link: &str, ctx: &ExecContext<'_>) -> Option<String> {
    let output = cap(
        ctx,
        &Capability::ReadLink {
            path: current_link.to_string(),
        },
    )
    .await
    .ok()?;
    release_name_from_link(&output)
}

/// 找"上一版"：当前版本在发布目录里的前一个。
async fn previous_release(current_link: &str, ctx: &ExecContext<'_>) -> Result<String, String> {
    let current = current_release(current_link, ctx)
        .await
        .ok_or_else(|| format!("{current_link} 还没有指向任何版本，无法回滚"))?;
    let root = current_link
        .trim_end_matches('/')
        .rsplit_once('/')
        .map(|(parent, _)| format!("{parent}/releases"))
        .ok_or_else(|| format!("无法从 {current_link} 推导发布根目录"))?;
    let (_, entries) = ctx
        .ssh
        .sftp_list_dir(ctx.session_id, Some(root.clone()))
        .await
        .map_err(|error| error.to_string())?;
    let mut versions: Vec<String> = entries
        .iter()
        .filter(|entry| entry.kind == KIND_DIRECTORY && !entry.hidden)
        .map(|entry| entry.name.clone())
        .collect();
    versions.sort_by(|left, right| crate::ssh::natural_cmp(left, right));
    let position = versions.iter().position(|name| name == &current);
    let previous = position
        .and_then(|position| position.checked_sub(1))
        .and_then(|index| versions.get(index).cloned())
        .ok_or_else(|| format!("发布目录里没有比 {current} 更早的版本，无法回滚"))?;
    Ok(format!("{root}/{previous}"))
}

fn last_lines(output: &str, count: usize) -> String {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let start = lines.len().saturating_sub(count);
    lines[start..].join(" / ")
}

fn short_hash(hash: &str) -> String {
    hash.chars().take(12).collect()
}

/// 跑一条能力：命令构造失败即失败（坏参数永远不会变成 shell 文本）。
async fn cap(ctx: &ExecContext<'_>, capability: &Capability) -> Result<String, String> {
    crate::remote::run_capability(ctx.ssh, ctx.session_id, capability)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_output_is_parsed_strictly() {
        let hash = "a".repeat(64);
        assert_eq!(
            parse_checksum(&format!("{hash}  /srv/app/releases/1/app.zip")),
            Some(hash.clone())
        );
        // 大写也要接受（sha256sum 有时是大小写混合的输出环境）。
        assert_eq!(
            parse_checksum(&format!("{}  x", hash.to_uppercase())),
            Some(hash)
        );
        assert_eq!(parse_checksum("no hash here"), None);
        assert_eq!(parse_checksum("abc  file"), None);
    }

    #[test]
    fn addresses_are_deduplicated_and_validated() {
        let output =
            "203.0.113.10  STREAM app.example.com\n203.0.113.10  DGRAM\n2001:db8::1  STREAM\n";
        assert_eq!(
            parse_addresses(output),
            vec!["203.0.113.10".to_string(), "2001:db8::1".to_string()]
        );
        assert!(parse_addresses("not-an-ip whatever").is_empty());
    }

    #[test]
    fn http_status_is_read_from_curl_output() {
        assert_eq!(parse_http_status("200"), Some(200));
        assert_eq!(parse_http_status("404\n"), Some(404));
        assert_eq!(parse_http_status("curl: (7) failed"), None);
    }

    #[test]
    fn container_health_understands_both_shapes() {
        let healthy = r#"{"State":{"Health":{"Status":"healthy","Log":[]},"Running":true}}"#;
        assert_eq!(container_health(healthy), HealthState::Healthy);

        let starting = r#"{"State":{"Health":{"Status":"starting","Log":[]},"Running":true}}"#;
        assert_eq!(container_health(starting), HealthState::Starting);

        let unhealthy = r#"{"State":{"Health":{"Status":"unhealthy","Log":[{"Output":"probe failed\n"}]},"Running":true}}"#;
        assert_eq!(
            container_health(unhealthy),
            HealthState::Unhealthy("probe failed".to_string())
        );

        // 没有 healthcheck 的容器按运行状态判定。
        let running = r#"{"State":{"Running":true}}"#;
        assert_eq!(container_health(running), HealthState::Running);

        // 已退出 = 不健康（绝不当作"OK"）。
        let exited = r#"{"State":{"Running":false}}"#;
        assert!(matches!(
            container_health(exited),
            HealthState::Unhealthy(_)
        ));

        assert_eq!(container_health("not json"), HealthState::NotFound);
    }

    #[test]
    fn release_name_is_the_last_path_segment() {
        assert_eq!(
            release_name_from_link("/srv/app/releases/1.2.3\n"),
            Some("1.2.3".to_string())
        );
        assert_eq!(release_name_from_link(""), None);
    }
}
