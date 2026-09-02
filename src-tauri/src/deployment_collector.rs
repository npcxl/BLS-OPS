//! P3 第一轮：部署实例优先发现。
//!
//! 流程（修订方案）：先由能力图谱（`capability_probe`）决定启用哪些收集器 ——
//! 只有探测确认安装的组件才会执行其命令；每个收集器枚举服务器上**真实存在**
//! 的部署实例（容器 / systemd 服务 / Nginx 站点），深入查询单个实例提取
//! ID、路径、端口与配置，输出 [`DeploymentInstance`] 供定向 marker 扫描反查
//! 源码目录。
//!
//! 铁律：**绝不伪造源码路径**。一个只有镜像、没有 Compose 标签、没有 bind
//! mount、没有工作目录线索的容器，就是 `source_known = false` 的"运行实例，
//! 源码未知"，而不是一个猜测出来的路径。
//!
//! 所有命令都经 `safe::Capability` 白名单；实例输出里的路径在进入结果前必须
//! 通过 `safe::validate_abs_path` —— 服务器返回的数据按不可信输入处理。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::capability_probe::ServerCapabilityProfile;
use crate::remote::run_on_linux;
use crate::safe::{validate_abs_path, Capability};
use crate::ssh::SshSessionManager;

/// 一个真实存在的部署实例（容器 / systemd 服务 / Nginx 站点）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeploymentInstance {
    /// 稳定 ID：`docker:<容器ID>` / `systemd:<单元名>` / `nginx:<站点名>`。
    pub id: String,
    /// 部署方式：`docker` | `systemd` | `nginx`。
    pub kind: String,
    /// 展示名：容器名 / 单元名 / server_name。
    pub name: String,
    /// 运行状态（原样来自服务器）。
    pub status: String,
    /// 实例对外端口（容器宿主映射端口 / systemd 监听未知为空 / Nginx listen）。
    pub ports: Vec<u16>,
    /// 宿主机上的工作目录（绝不包含容器内路径）。
    pub working_directories: Vec<String>,
    /// 配置文件（宿主机路径）：Compose 文件、unit 片段、Nginx 配置。
    pub config_files: Vec<String>,
    /// 第一轮定向扫描的候选源码目录。
    pub source_paths: Vec<String>,
    /// `false` = 只有运行实例，源码位置未知（不伪造路径）。
    pub source_known: bool,
    /// 人读摘要：Compose 项目/服务、镜像、ExecStart、代理目标等。
    pub detail: String,
}

/// 宿主机上"像业务目录"的根。systemd 服务的 WorkingDirectory / ExecStart 只有
/// 落在这些根下才视为业务服务（否则是系统服务，不进入项目发现）。
const APP_ROOTS: &[&str] = &[
    "/home",
    "/srv",
    "/opt",
    "/app",
    "/apps",
    "/var/www",
    "/data",
    "/usr/local",
    "/root",
    "/workspace",
];

/// 挂载源黑名单前缀：这些路径下的 bind mount 是运行时细节，不是项目目录。
const MOUNT_SOURCE_BLOCKLIST: &[&str] = &[
    "/var/lib/docker",
    "/var/lib/containerd",
    "/var/lib/kubelet",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/etc",
];

/// 按能力图谱收集所有真实部署实例。
///
/// 未安装（`Some(false)`）或无法判定（`None`）的组件**不会**执行任何命令。
/// 单个收集器失败只记 warning，不影响其它收集器 —— 部分证据好过没有证据，
/// 但失败原因必须如实呈现。
pub async fn collect_instances(
    session_id: &str,
    mgr: &SshSessionManager,
    profile: &ServerCapabilityProfile,
    warnings: &mut Vec<String>,
) -> Vec<DeploymentInstance> {
    let mut out = Vec::new();
    if profile.deployment.docker == Some(true) {
        match collect_docker(session_id, mgr).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("Docker 实例收集失败：{error}")),
        }
    }
    if profile.deployment.systemd == Some(true) {
        match collect_systemd(session_id, mgr).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("systemd 实例收集失败：{error}")),
        }
    }
    if profile.deployment.nginx == Some(true) {
        match collect_nginx(session_id, mgr, warnings).await {
            Ok(mut list) => out.append(&mut list),
            Err(error) => warnings.push(format!("Nginx 实例收集失败：{error}")),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

async fn collect_docker(
    session_id: &str,
    mgr: &SshSessionManager,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    // 第一步：列出全部容器（含已停止），拿到稳定 ID。
    let listing = run_on_linux(mgr, session_id, &Capability::DockerPs).await?;
    let containers = crate::docker::parse_ps(&listing);
    let mut instances = Vec::new();
    if containers.is_empty() {
        return Ok(instances);
    }

    // 第二步：按 ID 深查。分批（每批 ≤ 20）一次 inspect 多个容器，
    // 每行一个 JSON 对象。
    for chunk in containers.chunks(20) {
        let ids: Vec<String> = chunk.iter().map(|c| c.id.clone()).collect();
        let output = run_on_linux(
            mgr,
            session_id,
            &Capability::DockerInspectMany {
                containers: ids.clone(),
            },
        )
        .await?;
        for line in output.lines() {
            let line = line.trim();
            if !line.starts_with('{') {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    if let Some(instance) = docker_instance_from_inspect(&value) {
                        instances.push(instance);
                    }
                }
                Err(_) => continue, // 一行坏 JSON 不拖垮整批
            }
        }
    }
    Ok(instances)
}

/// 把 `docker inspect` 的单个 JSON 对象解析成实例。
///
/// 关键点：只有 **宿主机路径**（Compose working_dir、bind mount 的 Source、
/// Compose 配置文件）才进入 `source_paths` / `config_files`；
/// `Config.WorkingDir` 是容器内路径，只进摘要，绝不冒充宿主路径。
pub fn docker_instance_from_inspect(value: &Value) -> Option<DeploymentInstance> {
    let id = value.get("Id")?.as_str()?.to_string();
    let name = value
        .get("Name")
        .and_then(Value::as_str)
        .map(|n| n.trim_start_matches('/').to_string())
        .unwrap_or_else(|| id.chars().take(12).collect());
    let status = value
        .pointer("/State/Status")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let image = value
        .pointer("/Config/Image")
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    let labels = value.pointer("/Config/Labels").and_then(Value::as_object);
    let label = |key: &str| {
        labels
            .and_then(|map| map.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let compose_project = label("com.docker.compose.project");
    let compose_service = label("com.docker.compose.service");
    let compose_workdir = label("com.docker.compose.project.working_dir");
    let compose_files = label("com.docker.compose.project.config_files");

    // Compose 配置文件是冒号分隔的宿主机绝对路径列表。
    let config_files: Vec<String> = compose_files
        .as_deref()
        .map(|raw| {
            raw.split(':')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    // 宿主端口映射：NetworkSettings.Ports 的值数组里取 HostPort。
    let mut ports: Vec<u16> = Vec::new();
    if let Some(map) = value
        .pointer("/NetworkSettings/Ports")
        .and_then(Value::as_object)
    {
        for bindings in map.values() {
            if let Some(list) = bindings.as_array() {
                for binding in list {
                    if let Some(host_port) = binding
                        .get("HostPort")
                        .and_then(Value::as_str)
                        .and_then(|p| p.parse::<u16>().ok())
                    {
                        if !ports.contains(&host_port) {
                            ports.push(host_port);
                        }
                    }
                }
            }
        }
    }
    ports.sort_unstable();

    // bind mount 的 Source 是宿主机路径 → 源码候选。
    let mut source_paths: Vec<String> = Vec::new();
    if let Some(mounts) = value.get("Mounts").and_then(Value::as_array) {
        for mount in mounts {
            let source = mount.get("Source").and_then(Value::as_str).unwrap_or("");
            if is_host_project_path(source) {
                push_unique(&mut source_paths, source.to_string());
            }
        }
    }

    // Compose working_dir 是最强的源码位置证据。
    let mut working_directories: Vec<String> = Vec::new();
    if let Some(dir) = compose_workdir.as_deref() {
        if is_host_project_path(dir) {
            push_unique(&mut working_directories, dir.to_string());
            push_unique(&mut source_paths, dir.to_string());
        }
    }

    let mut detail = format!("镜像 {image}");
    if let (Some(project), Some(service)) = (&compose_project, &compose_service) {
        detail = format!("Compose 项目 {project} · 服务 {service} · {detail}");
    } else if let Some(project) = &compose_project {
        detail = format!("Compose 项目 {project} · {detail}");
    }

    // 源码已知 = 有任一宿主候选路径；否则就是"运行实例，源码未知"。
    let source_known = !source_paths.is_empty();
    Some(DeploymentInstance {
        id: format!("docker:{id}"),
        kind: "docker".into(),
        name,
        status,
        ports,
        working_directories,
        config_files: config_files
            .into_iter()
            .filter(|p| is_host_project_path(p))
            .collect(),
        source_paths,
        source_known,
        detail,
    })
}

/// 宿主项目路径判定：必须是能通过 `validate_abs_path` 的绝对路径，
/// 且不在运行时目录黑名单下。服务器返回的任何字符串都先过这一关。
pub fn is_host_project_path(path: &str) -> bool {
    if path.is_empty() || !path.starts_with('/') {
        return false;
    }
    if MOUNT_SOURCE_BLOCKLIST
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
    {
        return false;
    }
    validate_abs_path(path, "实例路径").is_ok()
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

async fn collect_systemd(
    session_id: &str,
    mgr: &SshSessionManager,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    // 第一步：列出全部 service 单元。
    let listing = run_on_linux(mgr, session_id, &Capability::ListServices).await?;
    let units = crate::systemd::parse_list_units(&listing);
    // 上限保护：单元极多的机器也不超过 200 个 show 目标（5 批 × 40）。
    let names: Vec<String> = units.iter().take(200).map(|u| u.unit.clone()).collect();
    let mut instances = Vec::new();

    // 第二步：批量 show（每批 ≤ 40，白名单校验单元名）。
    for chunk in names.chunks(40) {
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
pub fn parse_systemd_show(
    output: &str,
) -> Vec<(String, std::collections::BTreeMap<String, String>)> {
    let mut blocks: Vec<std::collections::BTreeMap<String, String>> = Vec::new();
    let mut current: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
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
/// WorkingDirectory 或 ExecStart 里的路径落在 [`APP_ROOTS`] 下。
pub fn systemd_instance(
    unit: &str,
    active: &str,
    sub: &str,
    props: &std::collections::BTreeMap<String, String>,
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
    if is_host_project_path(fragment) {
        config_files.push(fragment.to_string());
    }
    for token in env_files.split_whitespace() {
        // `EnvironmentFiles=/srv/app/.env (ignore_errors=no)` —— 取以 / 开头的
        // 去掉括号注记后的路径 token。
        let token = token.trim_start_matches('(');
        if is_host_project_path(token) {
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

fn is_app_path(path: &str) -> bool {
    APP_ROOTS
        .iter()
        .any(|root| path == *root || path.starts_with(&format!("{root}/")))
}

// ---------------------------------------------------------------------------
// Nginx
// ---------------------------------------------------------------------------

async fn collect_nginx(
    session_id: &str,
    mgr: &SshSessionManager,
    warnings: &mut Vec<String>,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    let config = run_on_linux(mgr, session_id, &Capability::NginxEffectiveConfig).await?;
    let sites = parse_nginx_effective(&config);
    let mut instances = Vec::new();

    // 反向关联：proxy_pass 的后端端口 → ss 找监听 PID → /proc/PID/cwd。
    let mut proxy_ports: Vec<u16> = Vec::new();
    for site in &sites {
        for port in &site.proxy_ports {
            if !proxy_ports.contains(port) {
                proxy_ports.push(*port);
            }
        }
    }
    proxy_ports.truncate(10); // 关联成本有界
    let cwd_by_port = correlate_ports_to_cwd(session_id, mgr, &proxy_ports, warnings).await;

    for site in sites {
        let mut source_paths: Vec<String> = Vec::new();
        let mut working_directories: Vec<String> = Vec::new();
        if let Some(root) = &site.root {
            // 静态站点：root 本身（常是 dist）与其父目录都是候选，
            // 让项目标志（package.json 等）决定哪一个真的是项目。
            if is_host_project_path(root) {
                push_unique(&mut source_paths, root.clone());
            }
            if let Some(parent) = std::path::Path::new(root).parent() {
                let parent = parent.to_string_lossy().to_string();
                if is_host_project_path(&parent) {
                    push_unique(&mut source_paths, parent);
                }
            }
            push_unique(&mut working_directories, root.clone());
        } else if !site.proxy_ports.is_empty() {
            // 纯代理站点：后端进程的 cwd 就是项目目录候选。
            for port in &site.proxy_ports {
                if let Some(cwd) = cwd_by_port.get(port) {
                    if is_host_project_path(cwd) {
                        push_unique(&mut source_paths, cwd.clone());
                    }
                }
            }
        }

        let proxy_note = if site.proxy_ports.is_empty() {
            String::new()
        } else {
            let targets: Vec<String> = site
                .proxy_ports
                .iter()
                .map(|p| match cwd_by_port.get(p) {
                    Some(cwd) => format!("{p} → {cwd}"),
                    None => format!("{p}"),
                })
                .collect();
            format!(" · 代理后端 {}", targets.join(", "))
        };
        let source_known = !source_paths.is_empty();
        instances.push(DeploymentInstance {
            id: format!("nginx:{}", site.name),
            kind: "nginx".into(),
            name: site.name.clone(),
            status: "configured".into(),
            ports: site.listen_ports.clone(),
            working_directories,
            config_files: site.config_file.iter().cloned().collect(),
            source_paths,
            source_known,
            detail: format!(
                "站点 {}{}{}",
                site.name,
                proxy_note,
                if source_known { "" } else { " · 源码未知" }
            ),
        });
    }
    Ok(instances)
}

/// `nginx -T` 输出中的一个 server 块。
pub struct NginxSiteBlock {
    pub name: String,
    pub listen_ports: Vec<u16>,
    pub root: Option<String>,
    pub proxy_ports: Vec<u16>,
    pub config_file: Option<String>,
}

/// 解析 `nginx -T`：跟踪 `# configuration file <path>:` 标记与花括号嵌套，
/// 提取每个 server 块的 server_name / listen / root / alias / proxy_pass。
/// server 块通常嵌在 `http {}` 内，因此只按"是否已在某个 server 块中"切换，
/// 不依赖全局深度。
pub fn parse_nginx_effective(config: &str) -> Vec<NginxSiteBlock> {
    let mut sites: Vec<NginxSiteBlock> = Vec::new();
    let mut current_file: Option<String> = None;
    let mut in_server = false;
    let mut server_depth: usize = 0;
    let mut block_lines: Vec<String> = Vec::new();

    for raw in config.lines() {
        let line = raw.trim();
        if let Some(path) = line
            .strip_prefix("# configuration file ")
            .and_then(|rest| rest.strip_suffix(':'))
        {
            current_file = Some(path.to_string());
            continue;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if !in_server {
            if is_block_open(line, "server") {
                in_server = true;
                server_depth = line.matches('{').count().max(1);
                block_lines.clear();
            }
            continue;
        }

        let opens = line.matches('{').count();
        let closes = line.matches('}').count();
        server_depth = (server_depth + opens).saturating_sub(closes);
        if server_depth > 0 {
            // 嵌套 location 块内的 proxy_pass / root 也要收集。
            if opens > 0 || !line.starts_with('}') {
                block_lines.push(line.to_string());
            }
        } else {
            in_server = false;
            if let Some(mut site) = build_site(&block_lines) {
                site.config_file = current_file.clone();
                sites.push(site);
            }
        }
    }
    sites
}

fn is_block_open(line: &str, keyword: &str) -> bool {
    let line = line.trim_end();
    let without = line
        .trim_end_matches('{')
        .trim_end()
        .trim_end_matches(';')
        .trim_end();
    if without == keyword {
        return line.ends_with('{');
    }
    // `server {` 形式
    without.split_whitespace().next() == Some(keyword) && line.ends_with('{')
}

fn build_site(lines: &[String]) -> Option<NginxSiteBlock> {
    let mut listen_ports: Vec<u16> = Vec::new();
    let mut server_name: Option<String> = None;
    let mut root: Option<String> = None;
    let mut proxy_ports: Vec<u16> = Vec::new();

    for line in lines {
        let tokens: Vec<&str> = line.trim_end_matches(';').split_whitespace().collect();
        match tokens.first().copied() {
            Some("listen") => {
                for token in tokens.iter().skip(1) {
                    if let Some(port) = parse_listen_token(token) {
                        if !listen_ports.contains(&port) {
                            listen_ports.push(port);
                        }
                    }
                }
            }
            Some("server_name") => {
                let name = tokens
                    .iter()
                    .skip(1)
                    .find(|t| !t.is_empty() && **t != "_" && **t != "$hostname")
                    .map(|t| t.to_string());
                if server_name.is_none() {
                    server_name = name;
                }
            }
            Some("root" | "alias") => {
                if root.is_none() {
                    if let Some(path) = tokens.get(1) {
                        root = Some(path.to_string());
                    }
                }
            }
            Some("proxy_pass") => {
                if let Some(url) = tokens.get(1) {
                    if let Some(port) = proxy_port(url) {
                        if !proxy_ports.contains(&port) {
                            proxy_ports.push(port);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if listen_ports.is_empty() && root.is_none() && proxy_ports.is_empty() {
        return None;
    }
    let name = server_name.unwrap_or_else(|| match listen_ports.first() {
        Some(port) => format!("端口 {port}"),
        None => "未命名站点".into(),
    });
    Some(NginxSiteBlock {
        name,
        listen_ports,
        root,
        proxy_ports,
        config_file: None,
    })
}

/// `listen 80;` / `listen 443 ssl;` / `listen [::]:80;` / `listen 0.0.0.0:8080;`
fn parse_listen_token(token: &str) -> Option<u16> {
    let candidate = token.rsplit(':').next()?;
    candidate.parse::<u16>().ok()
}

/// `proxy_pass http://127.0.0.1:8082;` → 8082；无端口时按协议默认。
fn proxy_port(url: &str) -> Option<u16> {
    let after_scheme = url.split_once("://")?.1;
    let host_part = after_scheme.split('/').next()?;
    match host_part.rsplit_once(':') {
        Some((_, port)) => port.parse::<u16>().ok(),
        None => Some(if url.starts_with("https") { 443 } else { 80 }),
    }
}

/// `ss -tlnp` 输出：端口 → 最早出现的持有 PID。
pub fn parse_ss_listen(output: &str) -> std::collections::BTreeMap<u16, u32> {
    let mut map = std::collections::BTreeMap::new();
    for line in output.lines() {
        if !line.trim_start().starts_with("LISTEN") {
            continue;
        }
        // 本地地址列是第 4 列：LISTEN 0 128 0.0.0.0:8082 …
        let columns: Vec<&str> = line.split_whitespace().collect();
        let Some(local) = columns.get(3) else {
            continue;
        };
        let Some(port) = local.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else {
            continue;
        };
        let Some(pid_start) = line.find("pid=") else {
            continue;
        };
        let rest = &line[pid_start + 4..];
        let pid: u32 = rest
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        if pid > 0 && !map.contains_key(&port) {
            map.insert(port, pid);
        }
    }
    map
}

/// 端口 → 项目目录：ss 找 PID，再读 `/proc/PID/cwd`。进程已退出或无权限时
/// 该端口保持无关联（调用方按"源码未知"处理，不猜）。
async fn correlate_ports_to_cwd(
    session_id: &str,
    mgr: &SshSessionManager,
    ports: &[u16],
    warnings: &mut Vec<String>,
) -> std::collections::BTreeMap<u16, String> {
    let mut map = std::collections::BTreeMap::new();
    if ports.is_empty() {
        return map;
    }
    let Ok(sockets) = run_on_linux(mgr, session_id, &Capability::ListenSockets).await else {
        warnings.push("无法读取监听端口（ss），代理后端无法关联到目录".into());
        return map;
    };
    let pid_by_port = parse_ss_listen(&sockets);
    // 同一个进程可能服务多个端口：按 PID 去重读 cwd，再应用到端口。
    let mut cwd_by_pid: std::collections::BTreeMap<u32, String> = std::collections::BTreeMap::new();
    for port in ports {
        let Some(pid) = pid_by_port.get(port) else {
            continue;
        };
        if !cwd_by_pid.contains_key(pid) {
            match run_on_linux(mgr, session_id, &Capability::ProcCwd { pid: *pid }).await {
                Ok(cwd) => {
                    let cwd = cwd.trim().to_string();
                    if is_host_project_path(&cwd) {
                        cwd_by_pid.insert(*pid, cwd);
                    }
                }
                Err(_) => continue, // 进程退出 / 权限不足：保持无关联
            }
        }
        if let Some(cwd) = cwd_by_pid.get(pid) {
            map.insert(*port, cwd.clone());
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -- Docker inspect ------------------------------------------------------

    #[test]
    fn docker_compose_container_yields_source_paths() {
        let value = json!({
            "Id": "a81c3f8deadbeef0000000000000000000000000000000000000000000000000",
            "Name": "/order-api",
            "State": { "Status": "running" },
            "Config": {
                "Image": "registry.example.com/order-api:1.4",
                "WorkingDir": "/app",
                "Labels": {
                    "com.docker.compose.project": "order-platform",
                    "com.docker.compose.service": "order-api",
                    "com.docker.compose.project.working_dir": "/srv/order-platform",
                    "com.docker.compose.project.config_files": "/srv/order-platform/docker-compose.yml"
                }
            },
            "NetworkSettings": { "Ports": { "8082/tcp": [ { "HostPort": "8082" } ] } },
            "Mounts": [
                { "Type": "bind", "Source": "/srv/order-platform/order-api", "Destination": "/app" },
                { "Type": "volume", "Source": "/var/lib/docker/volumes/site/_data", "Destination": "/var/www" }
            ]
        });
        let instance = docker_instance_from_inspect(&value).expect("应解析出实例");
        assert_eq!(instance.name, "order-api");
        assert_eq!(instance.kind, "docker");
        assert_eq!(instance.status, "running");
        assert!(instance.source_known);
        assert!(instance
            .source_paths
            .contains(&"/srv/order-platform".to_string()));
        assert!(instance
            .source_paths
            .contains(&"/srv/order-platform/order-api".to_string()));
        assert_eq!(
            instance.config_files,
            vec!["/srv/order-platform/docker-compose.yml"]
        );
        assert_eq!(instance.ports, vec![8082]);
        assert!(instance.detail.contains("order-platform"));
        // 容器内路径绝不冒充宿主路径。
        assert!(!instance.source_paths.contains(&"/app".to_string()));
        assert!(!instance.working_directories.contains(&"/app".to_string()));
    }

    #[test]
    fn docker_image_only_container_has_unknown_source() {
        let value = json!({
            "Id": "f20d7a1fffff",
            "Name": "/mystery",
            "State": { "Status": "exited" },
            "Config": { "Image": "nginx:latest" },
            "NetworkSettings": { "Ports": {} },
            "Mounts": []
        });
        let instance = docker_instance_from_inspect(&value).expect("应解析出实例");
        assert!(!instance.source_known, "没有宿主线索时不得伪造路径");
        assert!(instance.source_paths.is_empty());
        assert_eq!(instance.status, "exited");
    }

    #[test]
    fn docker_runtime_paths_are_rejected() {
        assert!(!is_host_project_path("/var/lib/docker/volumes/x/_data"));
        assert!(!is_host_project_path("/etc/nginx/conf.d"));
        assert!(!is_host_project_path("relative/path"));
        assert!(!is_host_project_path("/srv/app; rm -rf /"));
        assert!(is_host_project_path("/srv/order-platform"));
    }

    // -- systemctl show ------------------------------------------------------

    #[test]
    fn systemd_show_blocks_are_split_and_classified() {
        let output = "\
Id=order.service
FragmentPath=/etc/systemd/system/order.service
WorkingDirectory=/srv/order-service
ExecStart=/usr/bin/java -jar /srv/order-service/app.jar (unquoted; argument: \"x\")
EnvironmentFiles=/srv/order-service/.env (ignore_errors=no)

Id=systemd-journald.service
FragmentPath=/usr/lib/systemd/system/systemd-journald.service
WorkingDirectory=
ExecStart=/usr/lib/systemd/systemd-journald
EnvironmentFiles=
";
        let blocks = parse_systemd_show(output);
        assert_eq!(blocks.len(), 2);

        let order = &blocks[0];
        let instance =
            systemd_instance("order.service", "active", "running", &order.1).expect("业务服务");
        assert!(instance.source_known);
        assert!(instance
            .source_paths
            .contains(&"/srv/order-service".to_string()));
        // ExecStart 指向 /usr/bin（bin 目录不算项目目录，但其父路径判定在 APP_ROOTS 外）
        assert!(instance
            .config_files
            .contains(&"/etc/systemd/system/order.service".to_string()));
        assert!(instance
            .config_files
            .contains(&"/srv/order-service/.env".to_string()));
        assert!(instance.detail.contains("java"));

        // 系统服务（路径不在业务根下）不进入项目发现。
        let journald = &blocks[1];
        assert!(
            systemd_instance("systemd-journald.service", "active", "running", &journald.1)
                .is_none()
        );
    }

    // -- nginx -T ------------------------------------------------------------

    #[test]
    fn nginx_static_and_proxy_sites_are_parsed() {
        let config = "\
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# configuration file /etc/nginx/nginx.conf:
user www-data;
http {
# configuration file /etc/nginx/conf.d/admin.conf:
    server {
        listen 80;
        server_name admin.example.com;
        root /var/www/admin-web/dist;
        location / { try_files $uri $uri/ /index.html; }
    }
# configuration file /etc/nginx/conf.d/api.conf:
    server {
        listen 443 ssl;
        server_name api.example.com;
        location / {
            proxy_pass http://127.0.0.1:8082;
        }
    }
}
";
        let sites = parse_nginx_effective(config);
        assert_eq!(sites.len(), 2, "两个 server 块都应被识别");

        let admin = &sites[0];
        assert_eq!(admin.name, "admin.example.com");
        assert_eq!(admin.listen_ports, vec![80]);
        assert_eq!(admin.root.as_deref(), Some("/var/www/admin-web/dist"));
        assert_eq!(
            admin.config_file.as_deref(),
            Some("/etc/nginx/conf.d/admin.conf")
        );

        let api = &sites[1];
        assert_eq!(api.root, None);
        assert_eq!(api.proxy_ports, vec![8082]);
        assert_eq!(api.listen_ports, vec![443]);
    }

    #[test]
    fn ss_listen_extracts_pids() {
        let output = "\
State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      128        0.0.0.0:8082       0.0.0.0:*    users:((\"java\",pid=4321,fd=45))
LISTEN 0      128          0.0.0.0:80         0.0.0.0:*    users:((\"nginx\",pid=100,fd=6),(\"nginx\",pid=101,fd=6))
LISTEN 0      128             [::]:22            [::]:*    users:((\"sshd\",pid=9,fd=3))
";
        let map = parse_ss_listen(output);
        assert_eq!(map.get(&8082), Some(&4321));
        assert_eq!(map.get(&80), Some(&100), "取第一个 pid");
        assert_eq!(map.get(&22), Some(&9));
        assert!(map.get(&443).is_none());
    }

    #[test]
    fn exec_paths_skip_annotations() {
        let paths =
            extract_exec_paths("/usr/bin/java -jar /srv/app/main.jar (unquoted; argument: \"x\")");
        assert_eq!(paths, vec!["/usr/bin/java", "/srv/app/main.jar"]);
    }
}
