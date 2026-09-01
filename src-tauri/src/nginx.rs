//! Nginx site and configuration management (P3-1.4).
//!
//! Two directory conventions exist in the wild, so both are read:
//!
//! * Debian/Ubuntu — `sites-available` holds every site, and `sites-enabled`
//!   holds symlinks to the ones that are live.
//! * RHEL/CentOS — there is only `conf.d`, and everything in it is live.
//!
//! A site is therefore "enabled" when it is symlinked into `sites-enabled` or
//! when it lives in `conf.d`.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::remote::{require_linux, run_capability, run_on_linux, run_tolerated, DEFAULT_TIMEOUT};
use crate::safe::{Capability, ProbeTool};
use crate::ssh::SshSessionManager;

/// Root of the Debian-style layout.
pub const SITES_AVAILABLE: &str = "/etc/nginx/sites-available";
pub const SITES_ENABLED: &str = "/etc/nginx/sites-enabled";
/// Root of the RHEL-style layout.
pub const CONF_D: &str = "/etc/nginx/conf.d";

/// One Nginx site.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NginxSite {
    /// Filename, e.g. `default`.
    pub name: String,
    /// Whether the site is live.
    pub enabled: bool,
    /// Absolute path of the config file that is edited.
    pub path: String,
    /// Which layout this site came from, so the UI can explain the difference.
    pub source: NginxSource,
    /// `server_name` directives found in the config, when it has been read.
    pub server_names: Vec<String>,
    /// `listen` ports found in the config.
    pub listen_ports: Vec<u32>,
    /// Whether the config declares `default_server`.
    pub is_default: bool,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NginxSource {
    /// `sites-available`, toggled by a symlink in `sites-enabled`.
    #[default]
    SitesAvailable,
    /// `conf.d`, where presence means enabled.
    ConfD,
}

impl NginxSource {
    pub fn label(self) -> &'static str {
        match self {
            NginxSource::SitesAvailable => "sites-available",
            NginxSource::ConfD => "conf.d",
        }
    }
}

/// The result of `nginx -t`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NginxTestResult {
    pub success: bool,
    /// The combined output. `nginx -t` prints "syntax is ok" on **stderr**,
    /// so stdout alone would always look empty.
    pub output: String,
}

// -- Directory listing -------------------------------------------------------

/// Marker line printed between the three directory listings, so one command
/// can report all of them without three round trips.
const MARKER_AVAILABLE: &str = "---AVAILABLE---";
const MARKER_CONFD: &str = "---CONFD---";
const MARKER_ENABLED: &str = "---ENABLED---";

/// Splits the combined listing into `(available, conf.d, enabled)`.
///
/// Tolerates a missing section: `ls` of a non-existent directory prints
/// nothing, and the markers tell us which section we are in regardless.
pub fn parse_site_listing(input: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut available = Vec::new();
    let mut confd = Vec::new();
    let mut enabled = Vec::new();

    let mut section = 0u8;
    for line in input.lines() {
        let line = line.trim();
        match line {
            MARKER_AVAILABLE => {
                section = 1;
                continue;
            }
            MARKER_CONFD => {
                section = 2;
                continue;
            }
            MARKER_ENABLED => {
                section = 3;
                continue;
            }
            _ => {}
        }
        if line.is_empty() {
            continue;
        }
        match section {
            0 => available.push(line.to_string()),
            1 => confd.push(line.to_string()),
            2 => enabled.push(line.to_string()),
            _ => {}
        }
    }

    (available, confd, enabled)
}

/// Builds the site list from the three directory listings.
///
/// A `sites-available` entry is enabled when `sites-enabled` has a file of the
/// same name; a `conf.d` entry is enabled by being there. The same site name
/// can appear in both layouts on a host that has been upgraded in place, so
/// duplicates are collapsed with `conf.d` winning (it is the live one).
pub fn build_sites(available: &[String], confd: &[String], enabled: &[String]) -> Vec<NginxSite> {
    let mut sites: Vec<NginxSite> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for name in confd {
        if seen.iter().any(|existing| existing == name) {
            continue;
        }
        seen.push(name.clone());
        sites.push(NginxSite {
            name: name.clone(),
            enabled: true,
            path: format!("{CONF_D}/{name}"),
            source: NginxSource::ConfD,
            server_names: Vec::new(),
            listen_ports: Vec::new(),
            is_default: false,
        });
    }

    for name in available {
        if seen.iter().any(|existing| existing == name) {
            continue;
        }
        seen.push(name.clone());
        let is_enabled = enabled.iter().any(|link| link == name);
        sites.push(NginxSite {
            name: name.clone(),
            enabled: is_enabled,
            path: format!("{SITES_AVAILABLE}/{name}"),
            source: NginxSource::SitesAvailable,
            server_names: Vec::new(),
            listen_ports: Vec::new(),
            is_default: false,
        });
    }

    // Enablement is the interesting column, so live sites come first.
    sites.sort_by(|a, b| b.enabled.cmp(&a.enabled).then_with(|| a.name.cmp(&b.name)));
    sites
}

// -- Config parsing ----------------------------------------------------------

/// Pulls `server_name`, `listen` and `default_server` out of a config file.
///
/// This is a scan, not a full parser: Nginx's grammar has `if`, `map` and
/// `include` constructs that only a real parser resolves correctly. It exists
/// to give the list page useful columns, and it never claims a site is broken
/// when it simply cannot see a directive.
pub fn summarise_config(content: &str) -> (Vec<String>, Vec<u32>, bool) {
    let mut server_names: Vec<String> = Vec::new();
    let mut listen_ports: Vec<u32> = Vec::new();
    let mut is_default = false;

    for line in content.lines() {
        let line = line.trim();

        if let Some(rest) = strip_directive(line, "server_name") {
            for name in rest.split_whitespace() {
                let name = name.trim_end_matches(';');
                if !name.is_empty() && !server_names.contains(&name.to_string()) {
                    server_names.push(name.to_string());
                }
            }
        }

        if let Some(rest) = strip_directive(line, "listen") {
            if rest.contains("default_server") {
                is_default = true;
            }
            // `listen 443 ssl;`, `listen [::]:80;`, `listen 80 default_server;`
            let first = rest.split_whitespace().next().unwrap_or("");
            let port = first
                .rsplit_once(':')
                .map(|(_, port)| port)
                .unwrap_or(first)
                .trim_end_matches(';');
            if let Ok(port) = port.parse::<u32>() {
                if !listen_ports.contains(&port) {
                    listen_ports.push(port);
                }
            }
        }
    }

    listen_ports.sort_unstable();
    (server_names, listen_ports, is_default)
}

/// Matches a directive at the start of a trimmed line, returning its argument.
fn strip_directive<'a>(line: &'a str, directive: &str) -> Option<&'a str> {
    let rest = line.strip_prefix(directive)?;
    // `server_names_hash_bucket_size` must not match `server_name`.
    let next = rest.chars().next()?;
    if !next.is_whitespace() {
        return None;
    }
    Some(rest.trim_start())
}

/// Fills in the per-site summary from a config's contents.
pub fn apply_config_summary(site: &mut NginxSite, content: &str) {
    let (server_names, listen_ports, is_default) = summarise_config(content);
    site.server_names = server_names;
    site.listen_ports = listen_ports;
    site.is_default = is_default;
}

/// `nginx -t` reports success through its exit code, and writes its verdict to
/// stderr — so the caller must pass both streams.
pub fn parse_test_result(success: bool, output: &str) -> NginxTestResult {
    NginxTestResult {
        success,
        output: output.trim().to_string(),
    }
}

// -- Collection --------------------------------------------------------------

/// Lists sites with their enabled state.
pub async fn collect_sites(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<Vec<NginxSite>> {
    require_linux(manager, session_id).await?;

    let listing = run_capability(manager, session_id, &Capability::NginxListSites).await?;
    let (available, confd, enabled) = parse_site_listing(&listing);

    if available.is_empty() && confd.is_empty() {
        return Err(anyhow!(
            "没有找到任何 Nginx 站点配置（{SITES_AVAILABLE} 与 {CONF_D} 都不存在或为空）。"
        ));
    }

    Ok(build_sites(&available, &confd, &enabled))
}

/// Lists sites and reads each config so the list can show server names and
/// ports. Reading every file is O(sites) commands, which is fine for the
/// handful of sites a real host has; a host with dozens would be slow, so the
/// reads are issued concurrently.
pub async fn collect_sites_with_summary(
    manager: &SshSessionManager,
    session_id: &str,
) -> Result<Vec<NginxSite>> {
    let mut sites = collect_sites(manager, session_id).await?;

    let mut tasks = Vec::with_capacity(sites.len());
    for site in &sites {
        let manager = manager.clone();
        let session_id = session_id.to_string();
        let path = site.path.clone();
        tasks.push(tokio::spawn(async move {
            run_tolerated(
                &manager,
                &session_id,
                &Capability::NginxReadConfig { path }
                    .command()
                    .unwrap_or_default(),
                DEFAULT_TIMEOUT,
            )
            .await
        }));
    }

    for (index, task) in tasks.into_iter().enumerate() {
        if let Ok(Some(content)) = task.await {
            apply_config_summary(&mut sites[index], &content);
        }
    }

    Ok(sites)
}

/// Reads one config file.
pub async fn read_config(
    manager: &SshSessionManager,
    session_id: &str,
    path: &str,
) -> Result<String> {
    // The path is validated before the OS probe: a path outside the Nginx
    // directories must not cost a round trip, let alone become a command.
    run_on_linux(
        manager,
        session_id,
        &Capability::NginxReadConfig {
            path: path.to_string(),
        },
    )
    .await
}

/// Validates the whole configuration. Called before every reload so a typo
/// cannot take the site offline.
///
/// `nginx -t` exits 0 on success and writes to stderr either way, so both
/// streams are needed; `require_ok` only returns stdout, hence the explicit
/// second read when stdout comes back empty.
pub async fn test_config(manager: &SshSessionManager, session_id: &str) -> Result<NginxTestResult> {
    require_linux(manager, session_id).await?;

    let command = Capability::NginxTest.command()?;
    let output = manager
        .exec(session_id, &command, Capability::NginxTest.timeout())
        .await?;

    let success = matches!(output.exit_code, Some(0) | None);
    // Prefer stdout, fall back to stderr: that is where nginx writes its
    // verdict, and an empty result would be useless to the operator.
    let text = if output.stdout.trim().is_empty() {
        output.stderr
    } else {
        output.stdout
    };
    Ok(parse_test_result(success, &text))
}

/// Applies the running configuration. Callers must run [`test_config`] first.
pub async fn reload(manager: &SshSessionManager, session_id: &str) -> Result<String> {
    require_linux(manager, session_id).await?;
    let output = run_capability(manager, session_id, &Capability::NginxReload).await?;
    if output.trim().is_empty() {
        Ok("已重载 Nginx 配置。".to_string())
    } else {
        Ok(output)
    }
}

/// Copies a config aside before an in-place edit.
pub async fn backup_config(
    manager: &SshSessionManager,
    session_id: &str,
    path: &str,
) -> Result<String> {
    run_on_linux(
        manager,
        session_id,
        &Capability::NginxBackup {
            path: path.to_string(),
        },
    )
    .await?;
    Ok(format!("{path}.blsops.bak"))
}

/// Adds or removes the `sites-enabled` symlink.
///
/// Only meaningful for the Debian layout; a `conf.d` site is enabled by
/// existing, so toggling it would mean deleting the config, which is not
/// something a toggle should do.
pub async fn set_site_enabled(
    manager: &SshSessionManager,
    session_id: &str,
    site: &str,
    enable: bool,
) -> Result<String> {
    run_on_linux(
        manager,
        session_id,
        &Capability::NginxSetSiteEnabled {
            site: site.to_string(),
            enable,
        },
    )
    .await?;
    Ok(if enable {
        format!("已启用站点 {site}")
    } else {
        format!("已停用站点 {site}")
    })
}

/// Whether Nginx is installed.
pub async fn nginx_available(manager: &SshSessionManager, session_id: &str) -> bool {
    crate::remote::has_tool(manager, session_id, ProbeTool::Nginx).await
}

/// Reads a config file's contents for the editor.
pub async fn config_for_edit(
    manager: &SshSessionManager,
    session_id: &str,
    path: &str,
) -> Result<String> {
    read_config(manager, session_id, path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the combined listing command prints on a Debian host.
    const LISTING_DEBIAN: &str = "\
default
app
old-site
---AVAILABLE---
---CONFD---
app
---ENABLED---
";

    /// A host using only `conf.d`.
    const LISTING_CONFD: &str = "\
---AVAILABLE---
gzip.conf
app.conf
---CONFD---
---ENABLED---
";

    const APP_CONFIG: &str = "\
server {
    listen 80 default_server;
    listen [::]:80;

    server_name app.example.com www.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
    }
}
";

    #[test]
    fn splits_the_three_sections() {
        let (available, confd, enabled) = parse_site_listing(LISTING_DEBIAN);
        assert_eq!(available, vec!["default", "app", "old-site"]);
        assert!(confd.is_empty(), "这台机器没有 conf.d");
        assert_eq!(enabled, vec!["app"]);
    }

    #[test]
    fn handles_a_conf_d_only_host() {
        let (available, confd, enabled) = parse_site_listing(LISTING_CONFD);
        assert!(available.is_empty());
        assert_eq!(confd, vec!["gzip.conf", "app.conf"]);
        assert!(enabled.is_empty());
    }

    #[test]
    fn debian_sites_are_enabled_by_symlink() {
        let (available, confd, enabled) = parse_site_listing(LISTING_DEBIAN);
        let sites = build_sites(&available, &confd, &enabled);
        assert_eq!(sites.len(), 3);

        let app = sites.iter().find(|site| site.name == "app").unwrap();
        assert!(app.enabled);
        assert_eq!(app.path, "/etc/nginx/sites-available/app");
        assert_eq!(app.source, NginxSource::SitesAvailable);

        let old = sites.iter().find(|site| site.name == "old-site").unwrap();
        assert!(!old.enabled, "sites-enabled 中没有它");
    }

    #[test]
    fn conf_d_sites_are_enabled_by_presence() {
        let (available, confd, enabled) = parse_site_listing(LISTING_CONFD);
        let sites = build_sites(&available, &confd, &enabled);
        assert_eq!(sites.len(), 2);

        let app = sites.iter().find(|site| site.name == "app.conf").unwrap();
        assert!(app.enabled, "conf.d 里的配置天然生效");
        assert_eq!(app.path, "/etc/nginx/conf.d/app.conf");
        assert_eq!(app.source, NginxSource::ConfD);
    }

    #[test]
    fn enabled_sites_sort_first() {
        let (available, confd, enabled) = parse_site_listing(LISTING_DEBIAN);
        let sites = build_sites(&available, &confd, &enabled);
        assert!(sites[0].enabled);
        assert_eq!(sites[0].name, "app");
    }

    #[test]
    fn a_site_present_in_both_layouts_appears_once() {
        let available = vec!["app".to_string()];
        let confd = vec!["app".to_string()];
        let enabled = vec!["app".to_string()];
        let sites = build_sites(&available, &confd, &enabled);
        assert_eq!(sites.len(), 1, "同名站点只能出现一次");
    }

    #[test]
    fn summarises_a_config() {
        let (names, ports, is_default) = summarise_config(APP_CONFIG);
        assert_eq!(names, vec!["app.example.com", "www.example.com"]);
        assert_eq!(ports, vec![80]);
        assert!(is_default);
    }

    #[test]
    fn reads_ipv6_and_ssl_listeners() {
        let config = "\
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name secure.example.com;
}
";
        let (names, ports, is_default) = summarise_config(config);
        assert_eq!(names, vec!["secure.example.com"]);
        assert_eq!(ports, vec![443], "同一端口只列一次");
        assert!(!is_default);
    }

    #[test]
    fn does_not_confuse_similarly_named_directives() {
        let config = "\
server_names_hash_bucket_size 64;
listen 8080;
server_name example.com;
";
        let (names, ports, _) = summarise_config(config);
        assert_eq!(
            names,
            vec!["example.com"],
            "server_names_hash_* 不能被当成 server_name"
        );
        assert_eq!(ports, vec![8080]);
    }

    #[test]
    fn fills_the_site_summary_in_place() {
        let (available, _, enabled) = parse_site_listing(LISTING_DEBIAN);
        let mut sites = build_sites(&available, &[], &enabled);
        let app = sites.iter_mut().find(|site| site.name == "app").unwrap();
        apply_config_summary(app, APP_CONFIG);

        assert_eq!(app.server_names, vec!["app.example.com", "www.example.com"]);
        assert_eq!(app.listen_ports, vec![80]);
        assert!(app.is_default);
    }

    #[test]
    fn test_result_keeps_the_verdict_from_stderr() {
        // `nginx -t` prints this on stderr, so the UI would show nothing if we
        // only kept stdout.
        let result = parse_test_result(
            true,
            "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful",
        );
        assert!(result.success);
        assert!(result.output.contains("syntax is ok"));
    }

    #[test]
    fn empty_listing_yields_no_sites() {
        let sites = build_sites(&[], &[], &[]);
        assert!(sites.is_empty());
        let (available, confd, enabled) = parse_site_listing("");
        assert!(available.is_empty() && confd.is_empty() && enabled.is_empty());
    }

    #[test]
    fn source_labels_are_used_for_display() {
        assert_eq!(NginxSource::SitesAvailable.label(), "sites-available");
        assert_eq!(NginxSource::ConfD.label(), "conf.d");
    }
}
