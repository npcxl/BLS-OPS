//! Nginx collector — `nginx -T`, then reverse-correlate `proxy_pass`
//! backends to their project directory via `ss` + `/proc/<pid>/cwd`.

use std::collections::BTreeMap;

use super::model::{is_host_project_path, push_unique, DeploymentInstance};
use crate::remote::run_on_linux;
use crate::safe::Capability;
use crate::ssh::SshSessionManager;

/// 最多关联多少个代理后端端口（每次关联至少一次 `ss` + 一次 cwd 读取）。
const MAX_PROXY_PORTS: usize = 10;

pub(crate) async fn collect_nginx(
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
    proxy_ports.truncate(MAX_PROXY_PORTS);
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
pub fn parse_ss_listen(output: &str) -> BTreeMap<u16, u32> {
    let mut map = BTreeMap::new();
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
) -> BTreeMap<u16, String> {
    let mut map = BTreeMap::new();
    if ports.is_empty() {
        return map;
    }
    let Ok(sockets) = run_on_linux(mgr, session_id, &Capability::ListenSockets).await else {
        warnings.push("无法读取监听端口（ss），代理后端无法关联到目录".into());
        return map;
    };
    let pid_by_port = parse_ss_listen(&sockets);
    // 同一个进程可能服务多个端口：按 PID 去重读 cwd，再应用到端口。
    let mut cwd_by_pid: BTreeMap<u32, String> = BTreeMap::new();
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
