//! 按真实环境生成**命令建议**（纯逻辑，零 I/O）。
//!
//! 只读命令直接给；`reload` / `restart` 这类改运行状态的标成 `medium`
//! （执行前必须确认）；**删除类不生成** —— 危险操作不允许自动建议。

use super::model::*;

/// 生成某个容器的运维命令。
///
/// Compose 环境优先给 `docker compose`（带 `-p` 指定项目，**不依赖当前
/// 工作目录**），并保留"进入项目目录后用裸 compose"的说明；工作目录不可
/// 靠时一律退回 `docker exec`（可执行性优先于形式）。
///
/// 风险等级保持真实：`-v` / `-t` / `-T` / 日志 / inspect / port 只读；
/// `reload` / `restart` 修改运行状态 → medium（执行前必须确认）；
/// 删除类**不生成**（危险操作不允许自动建议）。
pub fn container_commands(container: &NginxContainer, compose: bool) -> Vec<SuggestedCommand> {
    let name = shell_quote(&container.name);
    let mut out: Vec<SuggestedCommand> = Vec::new();

    if compose {
        if let Some(compose_ref) = &container.compose {
            let project = &compose_ref.project;
            let service = &compose_ref.service;
            let cd = format!(
                "cd {} && docker compose",
                shell_quote(&compose_ref.working_dir)
            );
            let mut push = |id: &str,
                            title: &str,
                            command: String,
                            risk: SuggestedRisk,
                            note: Option<String>| {
                out.push(SuggestedCommand {
                    id: id.to_string(),
                    title: title.to_string(),
                    command,
                    risk,
                    note,
                    needs_container: false,
                });
            };
            push(
                "compose.ps",
                "查看 Compose 服务状态",
                format!("docker compose -p {project} ps {service}"),
                SuggestedRisk::ReadOnly,
                Some(format!("等价写法：{cd} ps {service}")),
            );
            push(
                "compose.logs",
                "查看最近 200 行日志",
                format!("docker compose -p {project} logs --tail 200 {service}"),
                SuggestedRisk::ReadOnly,
                Some(format!("等价写法：{cd} logs --tail 200 {service}")),
            );
            push(
                "compose.test",
                "校验配置（nginx -t）",
                format!("docker compose -p {project} exec {service} nginx -t"),
                SuggestedRisk::ReadOnly,
                None,
            );
            push(
                "compose.reload",
                "平滑重载配置",
                format!("docker compose -p {project} exec {service} nginx -s reload"),
                SuggestedRisk::Medium,
                Some("会改变运行中的服务状态，执行前请确认".to_string()),
            );
            push(
                "compose.restart",
                "重启服务",
                format!("docker compose -p {project} restart {service}"),
                SuggestedRisk::Medium,
                Some("重启会短暂中断连接，执行前请确认".to_string()),
            );
        }
    }

    let binary = container
        .flavor
        .map(|flavor| flavor.binary())
        .unwrap_or("nginx");
    let mut push =
        |id: &str, title: &str, command: String, risk: SuggestedRisk, note: Option<String>| {
            out.push(SuggestedCommand {
                id: id.to_string(),
                title: title.to_string(),
                command,
                risk,
                note,
                needs_container: false,
            });
        };

    push(
        "docker.version",
        "查看版本",
        format!("docker exec {name} {binary} -v"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.test",
        "校验配置",
        format!("docker exec {name} {binary} -t"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.dump",
        "查看完整配置",
        format!("docker exec {name} {binary} -T"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.reload",
        "平滑重载",
        format!("docker exec {name} {binary} -s reload"),
        SuggestedRisk::Medium,
        Some("会改变运行中的服务状态，执行前请确认".to_string()),
    );
    push(
        "docker.logs",
        "查看日志（最近 200 行）",
        format!("docker logs --tail 200 {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.logs.follow",
        "实时跟踪日志",
        format!("docker logs -f {name}"),
        SuggestedRisk::ReadOnly,
        Some("持续输出，按 Ctrl+C 退出".to_string()),
    );
    push(
        "docker.inspect",
        "查看容器详情",
        format!("docker inspect {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.exec",
        "进入容器",
        format!("docker exec -it {name} sh"),
        SuggestedRisk::Low,
        Some("交互式命令，不会生成结果快照".to_string()),
    );
    push(
        "docker.port",
        "查看端口映射",
        format!("docker port {name}"),
        SuggestedRisk::ReadOnly,
        None,
    );
    push(
        "docker.mounts",
        "查看配置挂载",
        format!(
            "docker inspect --format '{{{{range .Mounts}}}}{{{{println .Source}}}} {{{{.Destination}}}}{{{{end}}}}' {name}"
        ),
        SuggestedRisk::ReadOnly,
        None,
    );
    out
}

/// 宿主机 Nginx 的命令（无容器时使用）。
pub fn host_commands() -> Vec<SuggestedCommand> {
    vec![
        SuggestedCommand {
            id: "host.version".to_string(),
            title: "查看版本".to_string(),
            command: "nginx -v".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.test".to_string(),
            title: "校验配置".to_string(),
            command: "nginx -t".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.dump".to_string(),
            title: "查看完整配置".to_string(),
            command: "nginx -T".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.status".to_string(),
            title: "查看运行状态".to_string(),
            command: "systemctl status nginx".to_string(),
            risk: SuggestedRisk::ReadOnly,
            note: None,
            needs_container: false,
        },
        SuggestedCommand {
            id: "host.reload".to_string(),
            title: "平滑重载配置".to_string(),
            command: "nginx -s reload".to_string(),
            risk: SuggestedRisk::Medium,
            note: Some("会改变运行中的服务状态，执行前请确认".to_string()),
            needs_container: false,
        },
    ]
}

/// 按环境生成命令。
///
/// `selection` 是用户在多个容器里选的那个（或上一次记住的选择）。
/// `Multiple` 且没有选择 → 返回空命令，由前端先弹容器选择器：绝不替用户
/// 挑第一个容器。
pub fn nginx_commands(env: &NginxEnvironment, selection: Option<&str>) -> Vec<SuggestedCommand> {
    match env.kind {
        NginxKind::None => Vec::new(),
        NginxKind::Host => host_commands(),
        NginxKind::Docker | NginxKind::Compose => match env.single() {
            Some(container) => container_commands(container, env.kind == NginxKind::Compose),
            None => Vec::new(),
        },
        NginxKind::Multiple => match selection.and_then(|name| env.find(name)) {
            Some(container) => {
                let compose = container.compose.is_some();
                // 选定容器后仍要标明这是"已选容器"，避免用户误以为是全局命令。
                let mut commands = container_commands(container, compose);
                for command in &mut commands {
                    command.note = Some(match command.note.take() {
                        Some(note) => format!("容器 {} · {}", container.name, note),
                        None => format!("容器 {}", container.name),
                    });
                }
                commands
            }
            None => Vec::new(),
        },
    }
}

/// 单个容器名/路径的 shell 引号。`docker exec` 的参数来自服务器输出，
/// 可能含空格，必须转义后才能进命令行。
pub(crate) fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`");
    format!("\"{escaped}\"")
}
