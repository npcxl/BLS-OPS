//! Nginx collector — `nginx -T`, then reverse-correlate `proxy_pass`
//! backends to their project directory via `ss` + `/proc/<pid>/cwd`.
//!
//! # 网关实例与路由分离（2026-09 修订）
//!
//! 旧实现把**每一个 server block 都当成一个 DeploymentInstance**，导致一个
//! 共享 Nginx 的十几个域名变成十几个"基础设施服务"，与 MySQL/Redis 混在
//! 同一层。现在的模型：
//!
//! - **Nginx daemon**：一个网关实例（`nginx:gateway`），顶层只出现一次，
//!   归基础设施"网关与代理"组；
//! - **server block**：一条 [`GatewayRoute`]，在项目详情里作为"访问入口"
//!   展示（静态 root 关联前端项目、proxy_pass 关联后端应用）。
//!
//! 网关实例的 `working_directories` 汇总所有路由的宿主路径（静态 root +
//! 代理后端 cwd），维持定向 marker 扫描与项目关联的行为不变。

use std::collections::BTreeMap;

use super::model::{is_host_project_path, push_unique, DeploymentInstance, GatewayRoute};
use crate::remote::run_on_linux;
use crate::safe::Capability;
use crate::service_catalog::{identify_unit, InstanceRuntime};
use crate::ssh::SshSessionManager;

/// 宿主机 Nginx 网关的服务身份（复用目录表，避免两处各写一份"nginx"）。
fn identify_nginx() -> Option<crate::service_catalog::ServiceIdentity> {
    identify_unit("nginx.service")
}

/// 最多关联多少个代理后端端口（每次关联至少一次 `ss` + 一次 cwd 读取）。
const MAX_PROXY_PORTS: usize = 10;

/// 共享网关实例的稳定 ID。
pub(crate) const GATEWAY_INSTANCE_ID: &str = "nginx:gateway";

pub(crate) async fn collect_nginx(
    session_id: &str,
    mgr: &SshSessionManager,
    warnings: &mut Vec<String>,
) -> anyhow::Result<(Vec<DeploymentInstance>, Vec<GatewayRoute>)> {
    let config = run_on_linux(mgr, session_id, &Capability::NginxEffectiveConfig).await?;
    let sites = parse_nginx_effective(&config);
    if sites.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }

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

    let (instances, routes) = build_gateway(&sites, &cwd_by_port);
    Ok((instances, routes))
}

/// 由解析出的站点块构建**一个共享网关实例**与**一组路由**（纯函数，可测）。
pub fn build_gateway(
    sites: &[NginxSiteBlock],
    cwd_by_port: &BTreeMap<u16, String>,
) -> (Vec<DeploymentInstance>, Vec<GatewayRoute>) {
    if sites.is_empty() {
        return (Vec::new(), Vec::new());
    }

    let mut routes: Vec<GatewayRoute> = Vec::new();
    let mut gateway_paths: Vec<String> = Vec::new();
    let mut proxy_notes: Vec<String> = Vec::new();

    for site in sites {
        let mut linked_paths: Vec<String> = Vec::new();
        if let Some(root) = &site.root {
            if is_host_project_path(root) {
                push_unique(&mut linked_paths, root.clone());
            }
        }
        for port in &site.proxy_ports {
            if let Some(cwd) = cwd_by_port.get(port) {
                if is_host_project_path(cwd) {
                    push_unique(&mut linked_paths, cwd.clone());
                    proxy_notes.push(format!("{port} → {cwd}"));
                } else {
                    proxy_notes.push(format!("{port}"));
                }
            } else {
                proxy_notes.push(format!("{port}"));
            }
        }

        // 静态站点：root 的父目录也可能是项目根（root 常指向 dist）。
        if let Some(root) = &site.root {
            if let Some(parent) = std::path::Path::new(root).parent() {
                let parent = parent.to_string_lossy().to_string();
                if is_host_project_path(&parent) {
                    push_unique(&mut linked_paths, parent);
                }
            }
        }
        // 定向 marker 扫描与项目关联依赖实例上的宿主路径；网关实例汇总
        // 全部路由的 root + 代理后端 cwd，行为与旧的"每站点实例"等价。
        for path in &linked_paths {
            push_unique(&mut gateway_paths, path.clone());
        }

        routes.push(GatewayRoute {
            id: format!("route:{}", site.name),
            gateway_instance_id: GATEWAY_INSTANCE_ID.to_string(),
            server_names: vec![site.name.clone()],
            listen_ports: site.listen_ports.clone(),
            root: site.root.clone(),
            proxy_targets: site.proxy_targets.clone(),
            config_file: site.config_file.clone(),
            linked_project_id: None,
            linked_paths,
        });
    }

    let mut listen_ports: Vec<u16> = Vec::new();
    let mut config_files: Vec<String> = Vec::new();
    for site in sites {
        for port in &site.listen_ports {
            if !listen_ports.contains(port) {
                listen_ports.push(*port);
            }
        }
        if let Some(config) = &site.config_file {
            push_unique(&mut config_files, config.clone());
        }
    }

    // 定向 marker 扫描与项目关联依赖实例上的宿主路径；网关实例汇总全部路由
    // 的 root + 代理后端 cwd，行为与旧的"每站点实例"等价。
    let source_paths = gateway_paths.clone();
    let source_known = !source_paths.is_empty();
    let detail = format!(
        "共享网关 · {} 个站点 · 监听 {} · 代理后端 {}{}",
        sites.len(),
        listen_ports
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join("/"),
        if proxy_notes.is_empty() {
            "无".to_string()
        } else {
            proxy_notes.join(", ")
        },
        if source_known { "" } else { " · 源码未知" }
    );

    let gateway = DeploymentInstance {
        id: GATEWAY_INSTANCE_ID.to_string(),
        kind: "nginx".into(),
        name: "Nginx".into(),
        status: "configured".into(),
        // `nginx -T` 读的是**宿主机** nginx 的生效配置。跑在容器里的 nginx
        // 走 docker 收集器识别（`runtime = container`），两者不会混淆。
        runtime: InstanceRuntime::Host,
        image: None,
        service: identify_nginx().map(|identity| identity.detected()),
        system_owned: false,
        ports: listen_ports,
        working_directories: gateway_paths,
        config_files,
        source_paths,
        source_known,
        detail,
        ..Default::default()
    };
    (vec![gateway], routes)
}

/// `nginx -T` 输出中的一个 server 块。
#[derive(Debug)]
pub struct NginxSiteBlock {
    pub name: String,
    pub listen_ports: Vec<u16>,
    pub root: Option<String>,
    pub proxy_ports: Vec<u16>,
    /// proxy_pass 原始 URL（`http://127.0.0.1:8082`）。
    pub proxy_targets: Vec<String>,
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
    let mut proxy_targets: Vec<String> = Vec::new();

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
                    push_unique(&mut proxy_targets, (*url).to_string());
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
        proxy_targets,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sites_with_roots_and_proxies() {
        let config = "# configuration file /etc/nginx/nginx.conf:\n\
                      http {\n\
                      server {\n\
                      listen 80;\n\
                      server_name example.com;\n\
                      root /var/www/example;\n\
                      }\n\
                      server {\n\
                      listen 443 ssl;\n\
                      server_name api.example.com;\n\
                      location / {\n\
                      proxy_pass http://127.0.0.1:8082;\n\
                      }\n\
                      }\n\
                      }\n";
        let sites = parse_nginx_effective(config);
        assert_eq!(sites.len(), 2, "{sites:?}");
        assert_eq!(sites[0].name, "example.com");
        assert_eq!(sites[0].root.as_deref(), Some("/var/www/example"));
        assert_eq!(sites[1].name, "api.example.com");
        assert_eq!(sites[1].proxy_ports, vec![8082]);
        assert_eq!(sites[1].proxy_targets, vec!["http://127.0.0.1:8082"]);
    }

    /// 多个 server block 只生成**一个**网关实例 + 多条路由，不再一个域名一个实例。
    #[test]
    fn gateway_and_routes_are_separated() {
        let sites = vec![
            NginxSiteBlock {
                name: "a.com".into(),
                listen_ports: vec![80],
                root: Some("/var/www/a".into()),
                proxy_ports: vec![],
                proxy_targets: vec![],
                config_file: Some("/etc/nginx/conf.d/a.conf".into()),
            },
            NginxSiteBlock {
                name: "api.a.com".into(),
                listen_ports: vec![443],
                root: None,
                proxy_ports: vec![8082],
                proxy_targets: vec!["http://127.0.0.1:8082".into()],
                config_file: Some("/etc/nginx/conf.d/api.conf".into()),
            },
        ];
        let mut cwd_by_port = BTreeMap::new();
        cwd_by_port.insert(8082u16, "/srv/api".to_string());
        let (instances, routes) = build_gateway(&sites, &cwd_by_port);
        assert_eq!(instances.len(), 1, "一个网关实例");
        assert_eq!(instances[0].id, "nginx:gateway");
        assert_eq!(instances[0].ports, vec![80, 443]);
        // 汇总路径包含静态 root 与代理后端 cwd（供定向扫描与项目关联）。
        assert!(instances[0]
            .source_paths
            .contains(&"/var/www/a".to_string()));
        assert!(instances[0].source_paths.contains(&"/srv/api".to_string()));
        assert_eq!(routes.len(), 2, "每个 server block 一条路由");
        assert_eq!(routes[0].root.as_deref(), Some("/var/www/a"));
        assert!(routes[1]
            .proxy_targets
            .contains(&"http://127.0.0.1:8082".to_string()));
        assert!(routes[1].linked_paths.contains(&"/srv/api".to_string()));
        assert!(routes.iter().all(|r| r.linked_project_id.is_none()));
    }

    #[test]
    fn empty_sites_produce_nothing() {
        let (instances, routes) = build_gateway(&[], &BTreeMap::new());
        assert!(instances.is_empty());
        assert!(routes.is_empty());
    }
}
