//! 本机 MCP 运行环境解析（uv / uvx / Node.js / npx / Docker）。
//!
//! 设计要点：
//! * **检测与启动共用同一套解析**：`Resolver::resolve` 只做文件系统查找，返回绝对
//!   路径；`launch_command` 用同一结果构造进程。检测阶段在这个路径上再跑一次带
//!   超时的版本命令，所以"市场显示就绪"与"真正启动时用的路径"不可能不一致。
//! * **不只依赖当前进程的 PATH**：Windows 进程在启动时继承环境块，用户装完 uv /
//!   Node / Docker 后不会自动获得新目录。这里额外读取用户级、系统级 PATH 注册表
//!   值，再加上常见安装位置（例如 `%USERPROFILE%\.local\bin`）。
//! * **只做安全的探测**：版本命令（`--version`）有超时与输出上限，不下载包、不跑
//!   安装脚本、不启动用户没有配置过的服务。所有探测都是"程序 + 参数"分开传递，
//!   只有 Windows 的 `.cmd` / `.bat` 才经 `cmd.exe`，且命令行为自行转义。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::process::Command;
use tokio::time::timeout;

/// 单个版本探测的预算。慢机器上 `npx --version` 冷启动也要一两秒。
const VERSION_TIMEOUT: Duration = Duration::from_secs(6);
/// `docker info` 要等 daemon 回应；服务没起时通常很快失败，启动中可能慢一些。
const DOCKER_INFO_TIMEOUT: Duration = Duration::from_secs(8);
/// 探测输出只留开头，避免异常程序刷屏。
const OUTPUT_LIMIT: usize = 4096;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const WINDOWS_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// 运行环境状态。前端的 `McpRuntimeStatus` 与这里一一对应。
///
/// * `ready`        —— 找到并且能跑；
/// * `missing`      —— 所有搜索位置都没有这个文件；
/// * `unavailable`  —— 找到了，但运行失败（权限 / 损坏 / 非零退出码）；
/// * `not_running`  —— 只有 Docker：CLI 在，但 daemon 没起；
/// * `unknown`      —— 探测超时或无法确定（**不能**当成未安装）。
pub mod status {
    pub const READY: &str = "ready";
    pub const MISSING: &str = "missing";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const NOT_RUNNING: &str = "not_running";
    pub const UNKNOWN: &str = "unknown";
}

/// 搜索目录的来源，用于诊断（"是在用户级 PATH 里找到的"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    ProcessPath,
    UserPath,
    SystemPath,
    CommonDir,
    AppPath,
    Custom,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::ProcessPath => "process-path",
            Source::UserPath => "user-path",
            Source::SystemPath => "system-path",
            Source::CommonDir => "common-dir",
            Source::AppPath => "app-paths",
            Source::Custom => "custom",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchDir {
    pub path: PathBuf,
    pub source: Source,
}

/// 生产入口：用系统解析器解析一个命令。
///
/// 检测（`probe_runtime` / `probe_command`）与启动（`stdio_session`）都走这里，
/// 保证"看到的状态"和"真正启动的路径"是同一个结果。
pub fn resolve_program(command: &str) -> Option<ResolvedProgram> {
    Resolver::system().resolve(command)
}

/// 解析出来的可执行文件。`prefix` 用于等价命令（例如 `uvx` 缺失时用 `uv tool run`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedProgram {
    pub path: PathBuf,
    /// Windows 的 `.cmd` / `.bat` 必须经 `cmd.exe` 启动。
    pub via_cmd: bool,
    /// 启动时插在用户参数前面的固定参数。
    pub prefix: Vec<String>,
    pub source: Source,
}

impl ResolvedProgram {
    /// 真正要传给进程的参数：固定前缀 + 用户配置。
    pub fn arguments(&self, args: &[String]) -> Vec<String> {
        let mut all = self.prefix.clone();
        all.extend(args.iter().cloned());
        all
    }
}

#[derive(Debug, Clone)]
pub struct Resolver {
    dirs: Vec<SearchDir>,
    extensions: Vec<String>,
}

impl Resolver {
    /// 生产环境：当前进程 PATH → 用户级 PATH → 系统级 PATH → 常见安装位置。
    pub fn system() -> Self {
        let mut dirs: Vec<SearchDir> = Vec::new();
        if let Some(raw) = std::env::var_os("PATH") {
            dirs.extend(split_path_list(&raw.to_string_lossy(), Source::ProcessPath));
        }
        #[cfg(windows)]
        {
            if let Some(raw) = registry_value(
                windows_registry::CURRENT_USER,
                "Environment",
                "Path",
            ) {
                dirs.extend(split_path_list(
                    &expand_env(&raw),
                    Source::UserPath,
                ));
            }
            if let Some(raw) = registry_value(
                windows_registry::LOCAL_MACHINE,
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                "Path",
            ) {
                dirs.extend(split_path_list(
                    &expand_env(&raw),
                    Source::SystemPath,
                ));
            }
        }
        for path in common_dirs() {
            dirs.push(SearchDir {
                path,
                source: Source::CommonDir,
            });
        }
        Self {
            dirs: dedupe_dirs(dirs),
            extensions: extensions(),
        }
    }

    /// 测试或特殊场景：只用给定目录。
    pub fn from_dirs(dirs: Vec<SearchDir>) -> Self {
        Self {
            dirs: dedupe_dirs(dirs),
            extensions: extensions(),
        }
    }

    pub fn dirs(&self) -> &[SearchDir] {
        &self.dirs
    }

    /// 解析命令：绝对路径 / 带分隔符的路径原样验证，裸名字按搜索目录 + PATHEXT 查找。
    ///
    /// 找不到时返回 `None`，由调用方决定文案（检测显示"未安装"，启动直接报错）。
    pub fn resolve(&self, command: &str) -> Option<ResolvedProgram> {
        // 用户从资源管理器"复制路径"会带引号，这里去掉，但不对内容做其它加工。
        let name = command.trim().trim_matches('"').trim();
        if name.is_empty() {
            return None;
        }
        let expanded = expand_env(name);
        let looks_like_path = expanded.contains('/')
            || expanded.contains('\\')
            || Path::new(&expanded).is_absolute();
        if looks_like_path {
            let path = home_relative(&expanded)?;
            let found = self.complete_path(&path)?;
            return Some(ResolvedProgram {
                via_cmd: needs_cmd_shim(&found),
                path: found,
                prefix: Vec::new(),
                source: Source::Custom,
            });
        }

        if let Some((path, source)) = self.find_bare(&expanded) {
            return Some(ResolvedProgram {
                via_cmd: needs_cmd_shim(&path),
                path,
                prefix: Vec::new(),
                source,
            });
        }
        // `uvx` 与 `uv tool run` 完全等价：只装了 uv 的环境也能跑 pypi 包，
        // 这时显式给出回退参数，启动与检测都不会因为"没有 uvx.exe"直接失败。
        if is_name(&expanded, "uvx") {
            if let Some((path, source)) = self.find_bare("uv") {
                return Some(ResolvedProgram {
                    via_cmd: needs_cmd_shim(&path),
                    path,
                    prefix: vec!["tool".to_string(), "run".to_string()],
                    source,
                });
            }
        }
        None
    }

    /// 所有可能命中的候选（诊断用，最多 5 个）。
    pub fn candidates(&self, command: &str) -> Vec<ResolvedProgram> {
        let name = command.trim();
        if name.is_empty() {
            return Vec::new();
        }
        let expanded = expand_env(name);
        if expanded.contains('/') || expanded.contains('\\') || Path::new(&expanded).is_absolute() {
            return self.resolve(&expanded).into_iter().collect();
        }
        let mut out = Vec::new();
        for dir in &self.dirs {
            if let Some(path) = self.find_in(dir, &expanded) {
                out.push(ResolvedProgram {
                    via_cmd: needs_cmd_shim(&path),
                    path,
                    prefix: Vec::new(),
                    source: dir.source,
                });
                if out.len() >= 5 {
                    break;
                }
            }
        }
        out
    }

    fn find_bare(&self, name: &str) -> Option<(PathBuf, Source)> {
        for dir in &self.dirs {
            if let Some(path) = self.find_in(dir, name) {
                return Some((path, dir.source));
            }
        }
        #[cfg(windows)]
        if let Some(path) = app_paths(name) {
            return Some((path, Source::AppPath));
        }
        None
    }

    fn find_in(&self, dir: &SearchDir, name: &str) -> Option<PathBuf> {
        // 名字自带扩展名（npx.cmd / uv.exe）就只按原样找。
        if name.contains('.') {
            let direct = dir.path.join(name);
            return direct.is_file().then_some(direct);
        }
        /*
         * 与 cmd / CreateProcess 的查找顺序一致：先按 PATHEXT 找 `.exe` / `.cmd` /
         * `.bat`，最后才看没有扩展名的同名文件（那种文件通常不可执行）。
         */
        for ext in &self.extensions {
            if ext.is_empty() {
                continue;
            }
            let candidate = dir.path.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let direct = dir.path.join(name);
        direct.is_file().then_some(direct)
    }

    fn complete_path(&self, path: &Path) -> Option<PathBuf> {
        if path.is_file() {
            return Some(path.to_path_buf());
        }
        if path.extension().is_some() {
            return None;
        }
        for ext in &self.extensions {
            if ext.is_empty() {
                continue;
            }
            let mut raw = path.as_os_str().to_os_string();
            raw.push(ext);
            let candidate = PathBuf::from(raw);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// 子进程用的 PATH：当前 PATH 在前，补上用户级 / 系统级 PATH 与常见目录。
    ///
    /// 这样 `npx.cmd` 能找到同目录的 `node.exe`，`uvx.exe` 能找到 `uv.exe`，
    /// 用户也不需要在每条 MCP 配置里手写绝对路径。
    pub fn search_path(&self) -> OsString {
        let mut joined = OsString::new();
        for (index, dir) in self.dirs.iter().enumerate() {
            if index > 0 {
                joined.push(if cfg!(windows) { ";" } else { ":" });
            }
            joined.push(dir.path.as_os_str());
        }
        joined
    }

    /// 诊断摘要：查了哪些来源、多少个目录。不包含目录内容。
    pub fn summary(&self) -> String {
        let count = |source: Source| {
            self.dirs
                .iter()
                .filter(|dir| dir.source == source)
                .count()
        };
        let mut parts = Vec::new();
        if count(Source::ProcessPath) > 0 {
            parts.push(format!("应用 PATH {} 个目录", count(Source::ProcessPath)));
        }
        if count(Source::UserPath) > 0 {
            parts.push(format!("用户 PATH {} 个", count(Source::UserPath)));
        }
        if count(Source::SystemPath) > 0 {
            parts.push(format!("系统 PATH {} 个", count(Source::SystemPath)));
        }
        if count(Source::CommonDir) > 0 {
            parts.push(format!("常见安装位置 {} 个", count(Source::CommonDir)));
        }
        parts.join("，")
    }
}

/* ------------------------------------------------------------------ */
/* PATH 与环境                                                          */
/* ------------------------------------------------------------------ */

fn split_path_list(raw: &str, source: Source) -> Vec<SearchDir> {
    let separator = if cfg!(windows) { ';' } else { ':' };
    raw.split(separator)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| SearchDir {
            path: PathBuf::from(expand_env(item)),
            source,
        })
        .collect()
}

fn dedupe_dirs(dirs: Vec<SearchDir>) -> Vec<SearchDir> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.path.is_dir() {
            continue;
        }
        let key = directory_key(&dir.path);
        if !seen.insert(key) {
            continue;
        }
        out.push(dir);
    }
    out
}

fn directory_key(path: &Path) -> String {
    let raw = path.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        raw.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    }
    #[cfg(not(windows))]
    {
        raw.trim_end_matches('/').to_string()
    }
}

/// `%VAR%` 展开（Windows）。只读当前进程已有的环境变量，不执行任何 shell。
fn expand_env(raw: &str) -> String {
    #[cfg(windows)]
    {
        let chars: Vec<char> = raw.chars().collect();
        let mut out = String::with_capacity(raw.len());
        let mut index = 0;
        while index < chars.len() {
            if chars[index] == '%' {
                if let Some(offset) = chars[index + 1..].iter().position(|c| *c == '%') {
                    let name: String = chars[index + 1..index + 1 + offset].iter().collect();
                    if !name.is_empty() {
                        if let Some(value) = std::env::var_os(&name) {
                            out.push_str(&value.to_string_lossy());
                            index = index + offset + 2;
                            continue;
                        }
                    }
                }
            }
            out.push(chars[index]);
            index += 1;
        }
        out
    }
    #[cfg(not(windows))]
    {
        raw.to_string()
    }
}

fn home_relative(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    let rest = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"));
    match rest {
        Some(rest) => dirs::home_dir().map(|home| home.join(rest)),
        None => Some(PathBuf::from(trimmed)),
    }
}

fn extensions() -> Vec<String> {
    let mut out = vec![String::new()];
    #[cfg(windows)]
    {
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| WINDOWS_PATHEXT.to_string());
        for ext in raw.split(';') {
            let ext = ext.trim();
            if ext.is_empty() {
                continue;
            }
            let ext = if ext.starts_with('.') {
                ext.to_string()
            } else {
                format!(".{ext}")
            };
            if !out.iter().any(|item| item.eq_ignore_ascii_case(&ext)) {
                out.push(ext);
            }
        }
        if out.len() == 1 {
            for ext in WINDOWS_PATHEXT.split(';') {
                out.push(ext.to_string());
            }
        }
    }
    out
}

fn common_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let home = dirs::home_dir();
    #[cfg(windows)]
    {
        // uv 官方安装器的默认目录（也是本次故障的核心：它常常不在应用 PATH 里）。
        if let Some(home) = home.clone() {
            out.push(home.join(".local").join("bin"));
            out.push(home.join(".cargo").join("bin"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let appdata = PathBuf::from(appdata);
            out.push(appdata.join("npm"));
        }
        // nvm-windows：node 的软链接目录与版本目录。
        for key in ["NVM_SYMLINK", "NVM_HOME", "NVM_DIR"] {
            if let Some(value) = std::env::var_os(key) {
                out.push(PathBuf::from(value));
            }
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let base = PathBuf::from(program_files);
            out.push(base.join("nodejs"));
            out.push(base.join("Docker").join("Docker").join("resources").join("bin"));
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
            out.push(PathBuf::from(program_files).join("nodejs"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            out.push(base.join("Microsoft").join("WindowsApps"));
            out.push(base.join("Programs").join("nodejs"));
            out.push(
                base.join("Programs")
                    .join("Docker")
                    .join("Docker")
                    .join("resources")
                    .join("bin"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(home) = home {
            out.push(home.join(".local").join("bin"));
            out.push(home.join(".cargo").join("bin"));
            out.push(home.join("bin"));
        }
        out.push(PathBuf::from("/usr/local/bin"));
        out.push(PathBuf::from("/opt/homebrew/bin"));
        out.push(PathBuf::from("/opt/local/bin"));
        out.push(PathBuf::from("/usr/bin"));
        out.push(PathBuf::from("/bin"));
    }
    out
}

#[cfg(windows)]
fn registry_value(root: &windows_registry::Key, path: &str, name: &str) -> Option<String> {
    root.open(path).ok()?.get_string(name).ok()
}

#[cfg(windows)]
fn app_paths(name: &str) -> Option<PathBuf> {
    use windows_registry::{CURRENT_USER, LOCAL_MACHINE};
    let file = if name.to_ascii_lowercase().ends_with(".exe") {
        name.to_string()
    } else {
        format!("{name}.exe")
    };
    let roots = [CURRENT_USER, LOCAL_MACHINE];
    let bases = [
        r"Software\Microsoft\Windows\CurrentVersion\App Paths",
        r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths",
    ];
    for root in roots {
        for base in bases {
            let Ok(key) = root.open(format!("{base}\\{file}")) else {
                continue;
            };
            let Ok(value) = key.get_string("") else {
                continue;
            };
            let value = value.trim().trim_matches('"');
            if value.is_empty() {
                continue;
            }
            let path = PathBuf::from(value);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn needs_cmd_shim(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat")
            })
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn is_name(value: &str, expected: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let trimmed = lower
        .trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat");
    trimmed == expected
}

/* ------------------------------------------------------------------ */
/* 启动                                                                 */
/* ------------------------------------------------------------------ */

/// 用解析结果构造启动命令。检测阶段不调用这里，但两者用的是同一个 `ResolvedProgram`。
pub fn launch_command(program: &ResolvedProgram, args: &[String]) -> Command {
    build_command(program, args, true)
}

fn build_command(program: &ResolvedProgram, args: &[String], with_prefix: bool) -> Command {
    let all = if with_prefix {
        program.arguments(args)
    } else {
        args.to_vec()
    };
    #[cfg(windows)]
    if program.via_cmd {
        // cmd 只用来执行 `.cmd` / `.bat`；命令行完全由我们拼接并转义，不经过 shell
        // 字符串插值。`/D` 跳过 AutoRun，`/S` 让 cmd 只剥掉最外层引号。
        let mut command = Command::new("cmd");
        command
            .raw_arg("/D")
            .raw_arg("/S")
            .raw_arg("/C")
            .raw_arg(format!("\"{}\"", windows_command_line(&program.path, &all)));
        command.creation_flags(CREATE_NO_WINDOW);
        return command;
    }
    let mut command = Command::new(&program.path);
    command.args(&all);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(windows)]
fn windows_command_line(program: &Path, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(quote_cmd_token(&program.to_string_lossy()));
    for arg in args {
        parts.push(quote_cmd_token(arg));
    }
    parts.join(" ")
}

/// cmd 的引号规则与 `CommandLineToArgvW` 不同：只有含空格或元字符的 token 才加引号，
/// 内部的 `"` 用 `\"`（MSVC 运行时会还原）。`\` 不做特殊处理。
#[cfg(windows)]
fn quote_cmd_token(token: &str) -> String {
    if token.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes = token
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '"' | '&' | '<' | '>' | '(' | ')' | '@' | '^' | '|'));
    if !needs_quotes {
        return token.to_string();
    }
    let mut out = String::with_capacity(token.len() + 2);
    out.push('"');
    for ch in token.chars() {
        if ch == '"' {
            out.push_str("\\\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

/// 子进程继承的 PATH（已补全用户级 / 系统级目录）。
pub fn child_path() -> OsString {
    Resolver::system().search_path()
}

/* ------------------------------------------------------------------ */
/* 探测                                                                 */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProbe {
    pub id: String,
    pub label: String,
    pub status: String,
    /// 脱敏后的绝对路径（`~` / `<user>`）。
    pub path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandProbe {
    pub command: String,
    pub resolved: bool,
    pub status: String,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReport {
    pub checked_at: u64,
    pub statuses: Value,
    pub runtimes: Vec<RuntimeProbe>,
}

struct ExecOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

impl ExecOutput {
    fn combined(&self) -> String {
        let mut text = self.stdout.clone();
        if !self.stderr.trim().is_empty() {
            if !text.trim().is_empty() {
                text.push('\n');
            }
            text.push_str(&self.stderr);
        }
        text
    }

    fn first_line(&self) -> Option<String> {
        let text = if self.stdout.trim().is_empty() {
            self.stderr.clone()
        } else {
            self.stdout.clone()
        };
        text.lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(120).collect())
    }
}

/// 跑一次短命令。`args` 是版本参数，**不**包含 `ResolvedProgram::prefix`。
async fn run(program: &ResolvedProgram, args: &[String], budget: Duration) -> std::io::Result<ExecOutput> {
    // 版本探测不带 prefix：uvx 回退到 uv 时，`uv tool run --version` 不是版本命令。
    let mut command = build_command(program, args, false);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command.env("PATH", child_path());
    let child = command.spawn()?;
    match timeout(budget, child.wait_with_output()).await {
        Ok(Ok(output)) => Ok(ExecOutput {
            code: output.status.code(),
            stdout: clip(String::from_utf8_lossy(&output.stdout).to_string()),
            stderr: clip(String::from_utf8_lossy(&output.stderr).to_string()),
            timed_out: false,
        }),
        Ok(Err(error)) => Err(error),
        Err(_) => Ok(ExecOutput {
            code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
        }),
    }
}

fn clip(text: String) -> String {
    if text.len() <= OUTPUT_LIMIT {
        return text;
    }
    text.chars().take(OUTPUT_LIMIT).collect()
}

fn label_for(id: &str) -> &'static str {
    match id {
        "uv" => "uv",
        "uvx" => "uvx",
        "node" => "Node.js",
        "npx" => "npx",
        "docker" => "Docker",
        _ => "运行环境",
    }
}

fn permission_denied(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("permission denied")
        || lower.contains("access is denied")
        || lower.contains("拒绝访问")
        || lower.contains("没有执行权限")
        || lower.contains("eacces")
}

/// 日志里是否出现"Docker 服务未启动"的特征（MCP 启动失败提示复用同一套判断）。
pub fn logs_daemon_unreachable(text: &str) -> bool {
    daemon_unreachable(text)
}

fn daemon_unreachable(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("cannot connect to the docker daemon")
        || lower.contains("is the docker daemon running")
        || lower.contains("error during connect")
        || lower.contains("docker_engine")
        || lower.contains("daemon is not running")
        || lower.contains("failed to connect to the docker")
        || lower.contains("connect: no such file or directory")
}

/// 探测一个已知运行时（uv / uvx / node / npx / docker）。
pub async fn probe_runtime(resolver: &Resolver, id: &str) -> RuntimeProbe {
    probe_runtime_with(resolver, id, VERSION_TIMEOUT).await
}

async fn probe_runtime_with(resolver: &Resolver, id: &str, budget: Duration) -> RuntimeProbe {
    let started = Instant::now();
    let label = label_for(id);
    let Some(program) = resolver.resolve(id) else {
        let mut probe = RuntimeProbe {
            id: id.to_string(),
            label: label.to_string(),
            status: status::MISSING.to_string(),
            path: None,
            version: None,
            source: None,
            message: format!("未安装 {label}"),
            detail: Some(format!("查找范围：{}", resolver.summary())),
            duration_ms: started.elapsed().as_millis() as u64,
        };
        // 单独说明 uv / uvx 的关系：只装了一个不算"全都装好"。
        if id == "uvx" {
            if let Some(uv) = resolver.resolve("uv") {
                probe.message = "未找到 uvx，但已安装 uv".to_string();
                probe.detail = Some(format!(
                    "uv 位于 {}；将用 `uv tool run` 代替 uvx。{}",
                    mask_path(&uv.path.to_string_lossy()),
                    resolver.summary()
                ));
            }
        } else if id == "npx" {
            if let Some(node) = resolver.resolve("node") {
                probe.message = "未找到 npx，但已安装 Node.js".to_string();
                probe.detail = Some(format!(
                    "node 位于 {}；npm/npx 通常与 Node.js 一起安装，请检查安装是否完整。{}",
                    mask_path(&node.path.to_string_lossy()),
                    resolver.summary()
                ));
            }
        }
        return probe;
    };

    if id == "docker" {
        return probe_docker(program, started).await;
    }

    match run(&program, &["--version".to_string()], budget).await {
        Ok(output) if !output.timed_out && output.code == Some(0) => {
            let version = output.first_line();
            let mut detail = format!(
                "检测方式：{} --version；来源：{}；路径：{}",
                label,
                program.source.as_str(),
                mask_path(&program.path.to_string_lossy())
            );
            let mut message = match &version {
                Some(version) => format!("已安装 {label}（{version}）"),
                None => format!("已安装 {label}"),
            };
            if !program.prefix.is_empty() {
                message = format!("{message}，将用 `uv tool run` 代替 uvx");
                detail.push_str("；uvx 缺失，使用 uv tool run 回退");
            }
            if id == "uvx" && is_name(&base_name(&program.path), "uv") {
                detail.push_str("；未找到独立的 uvx");
            }
            RuntimeProbe {
                id: id.to_string(),
                label: label.to_string(),
                status: status::READY.to_string(),
                path: Some(mask_path(&program.path.to_string_lossy())),
                version,
                source: Some(program.source.as_str().to_string()),
                message,
                detail: Some(detail),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
        Ok(output) if output.timed_out => RuntimeProbe {
            id: id.to_string(),
            label: label.to_string(),
            status: status::UNKNOWN.to_string(),
            path: Some(mask_path(&program.path.to_string_lossy())),
            version: None,
            source: Some(program.source.as_str().to_string()),
            message: format!("{label} 检测超时，无法确认状态"),
            detail: Some(format!(
                "路径：{}；`{label} --version` 在 {:.1} 秒内没有结束",
                mask_path(&program.path.to_string_lossy()),
                budget.as_secs_f32()
            )),
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Ok(output) => {
            let text = output.combined();
            let denied = permission_denied(&text);
            RuntimeProbe {
                id: id.to_string(),
                label: label.to_string(),
                status: status::UNAVAILABLE.to_string(),
                path: Some(mask_path(&program.path.to_string_lossy())),
                version: None,
                source: Some(program.source.as_str().to_string()),
                message: if denied {
                    format!("找到 {label}，但没有执行权限")
                } else {
                    format!("找到 {label}，但它无法运行")
                },
                detail: Some(format!(
                    "路径：{}；退出码：{}；输出：{}",
                    mask_path(&program.path.to_string_lossy()),
                    output
                        .code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "未知".to_string()),
                    excerpt(&text)
                )),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
        Err(error) => RuntimeProbe {
            id: id.to_string(),
            label: label.to_string(),
            status: status::UNAVAILABLE.to_string(),
            path: Some(mask_path(&program.path.to_string_lossy())),
            version: None,
            source: Some(program.source.as_str().to_string()),
            message: if error.kind() == std::io::ErrorKind::PermissionDenied {
                format!("找到 {label}，但没有执行权限")
            } else {
                format!("找到 {label}，但无法启动")
            },
            detail: Some(format!(
                "路径：{}；错误：{error}",
                mask_path(&program.path.to_string_lossy())
            )),
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

async fn probe_docker(program: ResolvedProgram, started: Instant) -> RuntimeProbe {
    let path_text = mask_path(&program.path.to_string_lossy());
    let cli = run(&program, &["--version".to_string()], VERSION_TIMEOUT).await;
    match &cli {
        Ok(output) if !output.timed_out && output.code == Some(0) => {}
        Ok(output) if output.timed_out => {
            return RuntimeProbe {
                id: "docker".to_string(),
                label: "Docker".to_string(),
                status: status::UNKNOWN.to_string(),
                path: Some(path_text.clone()),
                version: None,
                source: Some(program.source.as_str().to_string()),
                message: "Docker 检测超时，无法确认状态".to_string(),
                detail: Some(format!("`docker --version` 在 {} 秒内没有结束", VERSION_TIMEOUT.as_secs())),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }
        Ok(output) => {
            let text = output.combined();
            return RuntimeProbe {
                id: "docker".to_string(),
                label: "Docker".to_string(),
                status: status::UNAVAILABLE.to_string(),
                path: Some(path_text.clone()),
                version: None,
                source: Some(program.source.as_str().to_string()),
                message: if permission_denied(&text) {
                    "找到 Docker，但没有执行权限".to_string()
                } else {
                    "找到 Docker，但它无法运行".to_string()
                },
                detail: Some(format!(
                    "`docker --version` 退出码 {}；输出：{}",
                    output
                        .code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "未知".to_string()),
                    excerpt(&text)
                )),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }
        Err(error) => {
            return RuntimeProbe {
                id: "docker".to_string(),
                label: "Docker".to_string(),
                status: status::UNAVAILABLE.to_string(),
                path: Some(path_text.clone()),
                version: None,
                source: Some(program.source.as_str().to_string()),
                message: "找到 Docker，但无法启动".to_string(),
                detail: Some(format!("{error}")),
                duration_ms: started.elapsed().as_millis() as u64,
            };
        }
    }

    let cli_version = cli.ok().and_then(|output| output.first_line());
    match run(
        &program,
        &[
            "info".to_string(),
            "--format".to_string(),
            "{{.ServerVersion}}".to_string(),
        ],
        DOCKER_INFO_TIMEOUT,
    )
    .await
    {
        Ok(output) if !output.timed_out && output.code == Some(0) => {
            let server = output.first_line();
            RuntimeProbe {
                id: "docker".to_string(),
                label: "Docker".to_string(),
                status: status::READY.to_string(),
                path: Some(path_text.clone()),
                version: server.clone().or(cli_version.clone()),
                source: Some(program.source.as_str().to_string()),
                message: match &server {
                    Some(version) => format!("Docker 已就绪（服务 {version}）"),
                    None => "Docker 已就绪".to_string(),
                },
                detail: Some(format!(
                    "CLI：{}；服务：{}；路径：{path_text}；来源：{}",
                    cli_version.as_deref().unwrap_or("未知"),
                    server.as_deref().unwrap_or("未知"),
                    program.source.as_str()
                )),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
        Ok(output) if output.timed_out => RuntimeProbe {
            id: "docker".to_string(),
            label: "Docker".to_string(),
            status: status::UNKNOWN.to_string(),
            path: Some(path_text.clone()),
            version: cli_version,
            source: Some(program.source.as_str().to_string()),
            message: "Docker 服务状态检测超时，无法确认".to_string(),
            detail: Some(format!(
                "`docker info` 在 {} 秒内没有返回；CLI 路径：{path_text}",
                DOCKER_INFO_TIMEOUT.as_secs()
            )),
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Ok(output) => {
            let text = output.combined();
            let stopped = daemon_unreachable(&text);
            let denied = permission_denied(&text);
            RuntimeProbe {
                id: "docker".to_string(),
                label: "Docker".to_string(),
                status: if stopped {
                    status::NOT_RUNNING.to_string()
                } else {
                    status::UNAVAILABLE.to_string()
                },
                path: Some(path_text.clone()),
                version: cli_version,
                source: Some(program.source.as_str().to_string()),
                message: if stopped {
                    "Docker 已安装，但服务尚未启动".to_string()
                } else if denied {
                    "Docker 服务在运行，但当前用户没有访问权限".to_string()
                } else {
                    "Docker 已安装，但服务不可用".to_string()
                },
                detail: Some(format!(
                    "`docker info` 退出码 {}；输出：{}",
                    output
                        .code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "未知".to_string()),
                    excerpt(&text)
                )),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
        Err(error) => RuntimeProbe {
            id: "docker".to_string(),
            label: "Docker".to_string(),
            status: status::UNAVAILABLE.to_string(),
            path: Some(path_text),
            version: cli_version,
            source: Some(program.source.as_str().to_string()),
            message: "Docker 已安装，但服务不可用".to_string(),
            detail: Some(format!("`docker info` 启动失败：{error}")),
            duration_ms: started.elapsed().as_millis() as u64,
        },
    }
}

/// 并行探测所有运行环境。每次调用都重新读 PATH / 注册表，所以装完环境后
/// "重新检测"就能看到最新结果，不需要重启应用。
pub async fn probe_all() -> RuntimeReport {
    let resolver = Resolver::system();
    let (uv, uvx, node, npx, docker) = tokio::join!(
        probe_runtime(&resolver, "uv"),
        probe_runtime(&resolver, "uvx"),
        probe_runtime(&resolver, "node"),
        probe_runtime(&resolver, "npx"),
        probe_runtime(&resolver, "docker"),
    );
    let runtimes = vec![uv, uvx, node, npx, docker];
    let mut statuses = Map::new();
    for probe in &runtimes {
        statuses.insert(probe.id.clone(), Value::String(probe.status.clone()));
    }
    RuntimeReport {
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0),
        statuses: Value::Object(statuses),
        runtimes,
    }
}

/// 探测用户自定义的命令（可能是绝对路径，也可能是裸命令名）。
///
/// 只对已知的运行时执行 `--version`：未知程序不在这里启动，避免"检测"变成
/// 启动用户没有授权的服务。
pub async fn probe_command(command: &str) -> CommandProbe {
    let started = Instant::now();
    let resolver = Resolver::system();
    let probe = |status: &str, path: Option<String>, version: Option<String>, message: String, detail: String, elapsed: u64| CommandProbe {
        command: command.to_string(),
        resolved: path.is_some(),
        status: status.to_string(),
        path,
        version,
        message,
        detail: Some(detail),
        duration_ms: elapsed,
    };

    let Some(program) = resolver.resolve(command) else {
        return probe(
            status::MISSING,
            None,
            None,
            format!("找不到可执行文件：{command}"),
            format!("查找范围：{}", resolver.summary()),
            started.elapsed().as_millis() as u64,
        );
    };
    let path_text = mask_path(&program.path.to_string_lossy());
    let base = base_name(&program.path);
    let known = ["uv", "uvx", "node", "npx", "npm", "pnpm", "yarn", "bun", "docker", "python", "python3", "py"];
    if !known.iter().any(|name| base.starts_with(name)) {
        return probe(
            status::READY,
            Some(path_text.clone()),
            None,
            format!("已找到可执行文件：{command}"),
            format!("路径：{path_text}；未执行版本探测（避免启动未知程序）"),
            started.elapsed().as_millis() as u64,
        );
    }
    match run(&program, &["--version".to_string()], VERSION_TIMEOUT).await {
        Ok(output) if !output.timed_out && output.code == Some(0) => probe(
            status::READY,
            Some(path_text.clone()),
            output.first_line(),
            format!("已找到并确认可运行：{command}"),
            format!("路径：{path_text}；退出码 0"),
            started.elapsed().as_millis() as u64,
        ),
        Ok(output) if output.timed_out => probe(
            status::UNKNOWN,
            Some(path_text.clone()),
            None,
            format!("{command} 检测超时，无法确认状态"),
            format!("路径：{path_text}；`--version` 在 {} 秒内没有结束", VERSION_TIMEOUT.as_secs()),
            started.elapsed().as_millis() as u64,
        ),
        Ok(output) => {
            let text = output.combined();
            probe(
                status::UNAVAILABLE,
                Some(path_text.clone()),
                None,
                if permission_denied(&text) {
                    format!("找到 {command}，但没有执行权限")
                } else {
                    format!("找到 {command}，但它无法运行")
                },
                format!(
                    "路径：{path_text}；退出码：{}；输出：{}",
                    output.code.map(|code| code.to_string()).unwrap_or_else(|| "未知".to_string()),
                    excerpt(&text)
                ),
                started.elapsed().as_millis() as u64,
            )
        }
        Err(error) => probe(
            status::UNAVAILABLE,
            Some(path_text.clone()),
            None,
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                format!("找到 {command}，但没有执行权限")
            } else {
                format!("找到 {command}，但无法启动")
            },
            format!("路径：{path_text}；错误：{error}"),
            started.elapsed().as_millis() as u64,
        ),
    }
}

/// 诊断里展示路径时脱敏：家目录 → `~`，用户名 → `<user>`。
pub fn mask_path(raw: &str) -> String {
    let mut out = raw.to_string();
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy().to_string();
        if home.len() > 3 {
            out = out.replace(&home, "~");
            let home = home.replace('/', "\\");
            out = out.replace(&home, "~");
        }
    }
    for key in ["USERNAME", "USER"] {
        if let Ok(name) = std::env::var(key) {
            if name.len() >= 3 {
                out = out
                    .replace(&format!("Users\\{name}"), "Users\\<user>")
                    .replace(&format!("Users/{name}"), "Users/<user>")
                    .replace(&format!("/home/{name}"), "/home/<user>");
            }
        }
    }
    out
}

fn excerpt(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "（无输出）".to_string();
    }
    trimmed.lines().take(3).collect::<Vec<_>>().join(" / ").chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bls-mcp-runtime-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 写一个能跑的假程序，返回路径。Windows 用 `.cmd`，其它平台用带执行位的脚本。
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join(format!("{name}.cmd"));
            let text = format!("@echo off\r\n{body}\r\n");
            std::fs::write(&path, text).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            let path = dir.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }

    /// Windows 文件系统不区分大小写，`uvx.CMD` 与 `uvx.cmd` 是同一个文件。
    #[track_caller]
    fn assert_same_path(left: &Path, right: &Path) {
        #[cfg(windows)]
        assert!(
            left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy()),
            "{} != {}",
            left.display(),
            right.display()
        );
        #[cfg(not(windows))]
        assert_eq!(left, right);
    }

    fn search_dirs(list: &[(&Path, Source)]) -> Vec<SearchDir> {
        list.iter()
            .map(|(path, source)| SearchDir {
                path: path.to_path_buf(),
                source: *source,
            })
            .collect()
    }

    #[test]
    fn path_lists_keep_source_and_drop_empty_entries() {
        let separator = if cfg!(windows) { ";" } else { ":" };
        let raw = format!("{sep}a{sep}{sep}b{sep}", sep = separator);
        let dirs = split_path_list(&raw, Source::UserPath);
        assert_eq!(dirs.len(), 2);
        assert!(dirs.iter().all(|dir| dir.source == Source::UserPath));
    }

    #[test]
    fn uvx_can_be_found_outside_the_process_path() {
        let bin = temp_dir("uvx-outside-path");
        let uvx = write_script(&bin, "uvx", "echo uvx 0.13.10");
        let empty = temp_dir("empty");
        let resolver = Resolver::from_dirs(search_dirs(&[
            (&empty, Source::ProcessPath),
            (&bin, Source::UserPath),
        ]));
        let found = resolver.resolve("uvx").expect("uvx should be found");
        assert_same_path(&found.path, &uvx);
        assert_eq!(found.source, Source::UserPath);
        #[cfg(windows)]
        assert!(found.via_cmd);
    }

    #[cfg(windows)]
    #[test]
    fn resolves_dot_cmd_shim_and_uses_executable_path() {
        let bin = temp_dir("npx-shim");
        let npx = write_script(&bin, "npx", "echo 10.9.0");
        let _ = std::fs::write(bin.join("npx"), "").unwrap();
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        let found = resolver.resolve("npx").expect("npx.cmd should be found");
        assert_same_path(&found.path, &npx);
        assert!(found.via_cmd);
        // `.cmd` 必须经 cmd.exe：程序名是 cmd，真正的路径在命令行里，且被引号包住。
        let command = launch_command(&found, &["--version".to_string()]);
        assert_eq!(command.as_std().get_program(), "cmd");
        let line = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(line
            .to_lowercase()
            .contains(&npx.to_string_lossy().to_lowercase()));
        assert!(line.contains("--version"));
    }

    #[test]
    fn paths_with_spaces_are_resolved_and_quoted() {
        let bin = temp_dir("uv env with space").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let uvx = write_script(&bin, "uvx", "echo uvx 0.13.10");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::CommonDir)]));
        let found = resolver.resolve("uvx").expect("uvx under spaced path");
        assert_same_path(&found.path, &uvx);
        #[cfg(windows)]
        {
            let line = windows_command_line(&found.path, &["--version".to_string()]);
            assert!(line.starts_with('"'));
            assert!(line.contains("uv env with space"));
        }
    }

    #[tokio::test]
    async fn probe_ready_reports_version_and_path() {
        let bin = temp_dir("probe-ready");
        write_script(&bin, "uvx", "echo uvx 0.13.10");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::UserPath)]));
        let probe = probe_runtime(&resolver, "uvx").await;
        assert_eq!(probe.status, status::READY);
        assert_eq!(probe.version.as_deref(), Some("uvx 0.13.10"));
        assert!(probe.path.unwrap().contains("uvx"));
    }

    #[tokio::test]
    async fn probe_missing_is_not_unavailable() {
        let empty = temp_dir("probe-missing");
        let resolver = Resolver::from_dirs(search_dirs(&[(&empty, Source::ProcessPath)]));
        let probe = probe_runtime(&resolver, "uvx").await;
        assert_eq!(probe.status, status::MISSING);
        assert!(probe.detail.unwrap().contains("查找范围"));
    }

    #[tokio::test]
    async fn probe_nonzero_exit_is_unavailable() {
        let bin = temp_dir("probe-nonzero");
        write_script(&bin, "uvx", "exit 3");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        let probe = probe_runtime(&resolver, "uvx").await;
        assert_eq!(probe.status, status::UNAVAILABLE);
        assert!(probe.message.contains("无法运行"));
        assert!(probe.detail.unwrap().contains("退出码"));
    }

    #[tokio::test]
    async fn probe_timeout_is_unknown_not_missing() {
        let bin = temp_dir("probe-timeout");
        #[cfg(windows)]
        write_script(&bin, "uvx", "ping -n 4 127.0.0.1 >nul 2>nul");
        #[cfg(not(windows))]
        write_script(&bin, "uvx", "sleep 3");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        // 200ms 预算，避免等真实超时；状态必须是"未确认"，不能是"未安装"。
        let probe = probe_runtime_with(&resolver, "uvx", Duration::from_millis(200)).await;
        assert_eq!(probe.status, status::UNKNOWN);
        assert!(probe.message.contains("超时"));
    }

    #[tokio::test]
    async fn docker_cli_without_daemon_is_not_running() {
        let bin = temp_dir("docker-stopped");
        write_script(
            &bin,
            "docker",
            r#"if "%1"=="--version" (echo Docker version 27.0.0 & exit /b 0)
echo error during connect: This error may indicate that the docker daemon is not running. 1>&2
exit /b 1"#,
        );
        #[cfg(not(windows))]
        write_script(
            &bin,
            "docker",
            r#"if [ "$1" = "--version" ]; then echo "Docker version 27.0.0"; exit 0; fi
echo "error during connect: This error may indicate that the docker daemon is not running." >&2
exit 1"#,
        );
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        let probe = probe_runtime(&resolver, "docker").await;
        assert_eq!(probe.status, status::NOT_RUNNING);
        assert!(probe.message.contains("服务尚未启动"));
    }

    #[tokio::test]
    async fn custom_absolute_path_is_respected() {
        let bin = temp_dir("custom-absolute");
        let script = write_script(&bin, "my-mcp", "echo custom");
        let resolver = Resolver::from_dirs(search_dirs(&[(&temp_dir("custom-unused"), Source::ProcessPath)]));
        let found = resolver
            .resolve(&script.to_string_lossy())
            .expect("absolute path must resolve");
        assert_same_path(&found.path, &script);
        assert_eq!(found.source, Source::Custom);
    }

    #[test]
    fn quoted_absolute_path_is_accepted() {
        let bin = temp_dir("quoted-path");
        let script = write_script(&bin, "uvx", "echo uvx 0.13.10");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        let quoted = format!("\"{}\"", script.to_string_lossy());
        let found = resolver.resolve(&quoted).expect("quoted absolute path");
        assert_same_path(&found.path, &script);
        assert_eq!(found.source, Source::Custom);
    }

    #[test]
    fn absolute_path_without_extension_gets_pathext() {
        #[cfg(windows)]
        {
            let bin = temp_dir("no-ext");
            let exe = write_script(&bin, "uvx", "echo uvx 0.13.10");
            let raw = bin.join("uvx");
            let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
            let found = resolver
                .resolve(&raw.to_string_lossy())
                .expect("should complete with PATHEXT");
            assert_same_path(&found.path, &exe);
        }
    }

    #[tokio::test]
    async fn uvx_falls_back_to_uv_tool_run() {
        let bin = temp_dir("uv-fallback");
        let uv = write_script(&bin, "uv", "echo uv 0.13.10");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::UserPath)]));
        let found = resolver.resolve("uvx").expect("uvx falls back to uv");
        assert_same_path(&found.path, &uv);
        assert_eq!(found.prefix, vec!["tool".to_string(), "run".to_string()]);
        let args = found.arguments(&["demo-mcp".to_string()]);
        assert_eq!(args, vec!["tool", "run", "demo-mcp"]);
        let probe = probe_runtime(&resolver, "uvx").await;
        assert_eq!(probe.status, status::READY);
        assert!(probe.message.contains("uv tool run"));
    }

    #[tokio::test]
    async fn custom_command_probe_reports_missing_and_ready() {
        let bin = temp_dir("custom-probe");
        let script = write_script(&bin, "uvx", "echo uvx 0.13.10");
        let missing = probe_command("definitely-not-a-real-binary-xyz").await;
        assert_eq!(missing.status, status::MISSING);
        assert!(!missing.resolved);
        let ready = probe_command(&script.to_string_lossy()).await;
        assert_eq!(ready.status, status::READY);
        assert!(ready.resolved);
        assert_eq!(ready.version.as_deref(), Some("uvx 0.13.10"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn existing_but_not_executable_is_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let bin = temp_dir("no-exec-permission");
        let path = bin.join("uvx");
        std::fs::write(&path, "#!/bin/sh\necho uvx 0.13.10\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::ProcessPath)]));
        let probe = probe_runtime(&resolver, "uvx").await;
        assert_eq!(probe.status, status::UNAVAILABLE);
        assert!(probe.message.contains("权限"));
    }

    #[test]
    fn mask_path_hides_home_and_user_name() {
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();
        let masked = mask_path(&format!("{home}/.local/bin/uvx"));
        assert!(!masked.contains(&home));
        assert!(masked.starts_with('~'));
    }

    /// 复现线上故障：进程 PATH 里没有 `~/.local/bin`，但用户级 PATH 有。
    #[test]
    fn user_level_path_is_used_when_process_path_misses_it() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let uvx = home
            .join(".local")
            .join("bin")
            .join(if cfg!(windows) { "uvx.exe" } else { "uvx" });
        if !uvx.is_file() {
            // 本机没装 uv（CI）时跳过，不把测试变成环境依赖。
            return;
        }
        let process_only = std::env::var_os("PATH")
            .map(|raw| split_path_list(&raw.to_string_lossy(), Source::ProcessPath))
            .map(Resolver::from_dirs)
            .unwrap_or_else(|| Resolver::from_dirs(Vec::new()));
        if process_only.resolve("uvx").is_some() {
            // 当前进程 PATH 已经包含它，说明不是这条回归的场景。
            return;
        }
        let found = Resolver::system()
            .resolve("uvx")
            .expect("用户级 PATH 里的 uvx 必须能找到");
        assert_same_path(&found.path, &uvx);
        assert_eq!(found.source, Source::UserPath);
    }

    /// 装完运行环境后不需要重启应用：重新解析就能看到新文件。
    #[test]
    fn newly_installed_binary_is_visible_without_restart() {
        let bin = temp_dir("late-install");
        let resolver = Resolver::from_dirs(search_dirs(&[(&bin, Source::UserPath)]));
        assert!(resolver.resolve("uvx").is_none());
        write_script(&bin, "uvx", "echo uvx 0.13.10");
        assert!(resolver.resolve("uvx").is_some());
    }

    #[tokio::test]
    #[ignore]
    async fn diagnostic_report() {
        let report = probe_all().await;
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    }

    #[test]
    fn child_path_contains_search_dirs() {
        let resolver = Resolver::system();
        let path = resolver.search_path();
        assert!(!path.is_empty());
        #[cfg(windows)]
        assert!(path.to_string_lossy().contains(';'));
    }
}
