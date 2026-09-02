//! The closed set of management actions BLS-OPS will ever run on a server.
//!
//! This enum is the complete list — it is intentionally closed, and no variant
//! accepts a free-form command string. Adding an action means touching this
//! file, which is the point: the audit surface is one `match`.

use std::fmt;
use std::time::Duration;

use anyhow::{anyhow, Result};

use super::deploy::validate_deploy_step;
use super::validate::{
    is_within, shell_quote, validate_abs_path, validate_container, validate_image, validate_lines,
    validate_remote_paths, validate_site_name, validate_unit,
};

// -- Fixed command constants --------------------------------------------------

const LIST_SERVICES: &str =
    "systemctl list-units --type=service --all --no-legend --no-pager --plain";
const LIST_UNIT_FILES: &str = "systemctl list-unit-files --type=service --no-legend --no-pager";

/// find 谓词：只匹配项目标志（清单/部署文件），以及 `.git`/`src`/`app` 目录。
/// 两次 marker 扫描（固定根目录与定向目录）共用，保证评分语义一致。
// 项目标志的 `find` 谓词：只匹配"像项目"的名字 —— 构建清单、容器/进程编排
// 描述、锁文件、说明文件、入口文件与源码目录，**从不枚举普通文件**。
// 注意 `.sln` / `.csproj` / `.fsproj` 的前缀是任意项目名，只能按后缀匹配；
// 这些名字会原样进入 `score_candidate`，后者统一转小写后再比对。
const PROJECT_MARKER_PREDICATE: &str = "\
\\( -type f \\( \
-name pom.xml -o -name build.gradle -o -name build.gradle.kts \
-o -name package.json -o -name Cargo.toml -o -name go.mod \
-o -name pyproject.toml -o -name setup.py -o -name requirements.txt \
-o -name composer.json -o -name Dockerfile -o -name docker-compose.yml \
-o -name compose.yaml -o -name compose.yml -o -name Procfile \
-o -name nginx.conf -o -name package-lock.json -o -name pnpm-lock.yaml \
-o -name yarn.lock -o -name Cargo.lock -o -name poetry.lock \
-o -name README.md -o -name .env.example \
-o -name index.js -o -name main.go -o -name main.py -o -name Application.java \
-o -name '*.sln' -o -name '*.csproj' -o -name '*.fsproj' \
\\) -o -type d \\( \
-name .git -o -name src -o -name app -o -name .github -o -name systemd \
\\) \\)";

// NOTE: these `--format` templates are **quoted**. They contain `|`, which the
// remote shell would otherwise read as a pipe — `docker ps … --format {{.ID}}|
// {{.Names}}` would pipe the listing into a command called `{{.Names}}` and
// fail with "command not found" (exit 127). Single quotes keep the whole
// Go template as one literal argument.
const DOCKER_PS: &str =
    "docker ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}'";
const DOCKER_IMAGES: &str =
    "docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}'";
const DOCKER_STATS: &str =
    "docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}'";
const NGINX_LIST_SITES: &str =
    "sh -c 'ls -1 /etc/nginx/sites-available 2>/dev/null; echo ---AVAILABLE---; ls -1 /etc/nginx/conf.d 2>/dev/null; echo ---CONFD---; ls -1 /etc/nginx/sites-enabled 2>/dev/null; echo ---ENABLED---'";

// Kubernetes。两条都是**只读**命令，且带 `-o custom-columns` 固定列，不依赖
// jq 之类的额外工具。列名前缀（CUSTOM-CONNECTION 之类）由 kubectl 自动生成，
// 解析侧只按空白切分取值，不认表头。
// `--no-headers` 省掉表头；`2>/dev/null` 让"连不上集群"表现为非零退出，
// 而不是把报错文本喂给解析器。
const KUBE_NODES: &str = "kubectl get nodes --no-headers 2>/dev/null";
const KUBE_PODS: &str = "kubectl get pods --all-namespaces --no-headers -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,STATUS:.status.phase,IMAGES:.spec.containers[*].image 2>/dev/null";

/// Directories an Nginx capability may touch.
const NGINX_ROOTS: &[&str] = &["/etc/nginx", "/usr/local/nginx/conf"];

pub(crate) fn require_nginx_path(path: &str) -> Result<()> {
    if NGINX_ROOTS.iter().any(|root| is_within(path, root)) {
        Ok(())
    } else {
        Err(anyhow!(
            "只能操作 Nginx 配置目录（{}）下的文件：{path}",
            NGINX_ROOTS.join("、")
        ))
    }
}

// -- Actions -----------------------------------------------------------------

/// A management action the WebView may request.
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
    /// `docker inspect` for a batch of containers (≤ 20 per call), one JSON
    /// object per line. Used by the deployment-instance collector to deep-query
    /// every container listed by `docker ps`.
    DockerInspectMany {
        containers: Vec<String>,
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

    // Project discovery — deployment-instance-first (read-only).
    //
    // 第一轮"部署实例优先发现"：先由 `deployment_collector` 枚举真实部署实例
    // （Docker/systemd/Nginx，仅当能力探测确认安装后才执行其命令），再对实例给出
    // 的候选路径做**定向** marker 扫描（`ProjectDirMarkers`）。第二轮用固定根目录
    // 的 marker-only 扫描（`ProjectMarkerScan`）补充"已上传但未部署"的源码。
    // 任何命令都不再全量枚举普通文件。
    /// 第二轮补充扫描：只在固定源码根目录中查找项目标志文件，不枚举普通文件。
    ProjectMarkerScan,
    /// 第一轮定向扫描：对部署实例给出的候选目录做 marker-only find。
    /// 路径必须是已校验的绝对路径（来自服务器上真实实例的输出）。
    ProjectDirMarkers {
        paths: Vec<String>,
    },
    /// `systemctl show` 一批服务单元（仅 systemd 能力确认后执行）。
    /// 输出 Id/FragmentPath/WorkingDirectory/ExecStart/EnvironmentFiles。
    SystemdShowUnits {
        units: Vec<String>,
    },
    /// `nginx -T`：读取生效配置（仅 nginx 能力确认后执行）。
    NginxEffectiveConfig,
    /// `ss -tlnp`：监听端口 → PID 关联（Nginx proxy_pass 反查进程 cwd）。
    ListenSockets,
    /// `readlink -f /proc/<pid>/cwd`：把监听端口解析到项目目录。
    ProcCwd {
        pid: u32,
    },
    /// `kubectl get nodes --no-headers`：确认 kubectl **真的连得上**一个集群。
    /// 只装了 kubectl 客户端不等于这台机器在集群里，所以收集前必须先问一句。
    KubeNodes,
    /// `kubectl get pods --all-namespaces` 的自定义列：
    /// 命名空间 / Pod / 状态 / 镜像列表。用于枚举 k8s 工作负载。
    KubePods,

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

/// Tools that `probe_capabilities` may detect. Each maps to a fixed command
/// name used by `Capability::Probe` (existence check) and `Capability::ToolVersion`
/// (version string). All are whitelisted — no free-form command is ever built.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

// ---------------------------------------------------------------------------

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
            // 定向 marker 扫描的目录数少、深度浅，但大目录仍可能慢于默认超时。
            Capability::ProjectMarkerScan | Capability::ProjectDirMarkers { .. } => {
                Duration::from_secs(45)
            }
            Capability::NginxEffectiveConfig => Duration::from_secs(20),
            _ => super::super::remote::DEFAULT_TIMEOUT,
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
                // Keep the portable systemctl form: status accepts options
                // after the verb, while `--` terminates unit-name parsing.
                format!(
                    "systemctl status --no-pager -- {}",
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
            // Commands are fixed and bounded; their output is parsed as metadata
            // only. Both scans look for project markers exclusively — plain
            // files are never enumerated.
            Capability::ProjectMarkerScan => format!(
                "find /home /srv /opt /var/www /data -xdev -maxdepth 6 {} -printf '%h\\t%f\\n' 2>/dev/null | head -n 20000",
                PROJECT_MARKER_PREDICATE
            ),
            Capability::ProjectDirMarkers { paths } => {
                let paths = validate_remote_paths(paths)?;
                let list = paths
                    .iter()
                    .map(|path| quoted(path))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!(
                    "find {list} -xdev -maxdepth 4 {} -printf '%h\\t%f\\n' 2>/dev/null | head -n 5000",
                    PROJECT_MARKER_PREDICATE
                )
            }
            Capability::SystemdShowUnits { units } => {
                if units.is_empty() {
                    return Err(anyhow!("单元列表不能为空"));
                }
                if units.len() > 40 {
                    return Err(anyhow!("单次 systemctl show 不能超过 40 个单元"));
                }
                let mut list = String::new();
                for unit in units {
                    let quoted_unit = quoted(validate_unit(unit)?);
                    if !list.is_empty() {
                        list.push(' ');
                    }
                    list.push_str(&quoted_unit);
                }
                format!(
                    "systemctl show --no-pager -p Id -p FragmentPath -p WorkingDirectory -p ExecStart -p EnvironmentFiles -- {list}"
                )
            }
            Capability::NginxEffectiveConfig => "nginx -T 2>&1".to_string(),
            Capability::ListenSockets => "ss -tlnp 2>/dev/null | head -n 500".to_string(),
            Capability::ProcCwd { pid } => {
                if *pid == 0 {
                    return Err(anyhow!("PID 必须大于 0"));
                }
                format!("readlink -f /proc/{pid}/cwd")
            }

            Capability::KubeNodes => KUBE_NODES.to_string(),
            Capability::KubePods => KUBE_PODS.to_string(),

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

            Capability::DockerInspectMany { containers } => {
                if containers.is_empty() {
                    return Err(anyhow!("容器列表不能为空"));
                }
                if containers.len() > 20 {
                    return Err(anyhow!("单次 docker inspect 不能超过 20 个容器"));
                }
                let mut list = String::new();
                for container in containers {
                    let quoted_container = quoted(validate_container(container)?);
                    if !list.is_empty() {
                        list.push(' ');
                    }
                    list.push_str(&quoted_container);
                }
                format!("docker inspect --format '{{{{json .}}}}' -- {list}")
            }

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
