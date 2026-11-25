//! 服务器文件变更：**用真实内容**生成 Diff，而不是相信模型的说法。
//!
//! 一条变更记录的生命周期：
//! 1. `write_file` 准备执行前，先回读服务器上的原文（`before`）并算指纹；
//!    `proposedAfter` 是这次工具调用**明确提交**的内容。
//! 2. 用户确认后、真正发起写入前再回读一次：指纹变了就作废旧预览、生成新预览，
//!    旧确认不能用于新版本。
//! 3. 写入成功后重新回读（`actualAfter`），Diff 用 `before` 与它生成 ——
//!    服务器上实际发生了什么，只有回读能证明。
//!
//! 这里只做纯逻辑（快照解析 / 指纹 / 行级 Diff / 记录存储），不碰 Tauri、不碰 SSH；
//! 命令构造在 [`super::tools`]，执行与事件在 [`super::runner`]。

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 单个文件快照的上限：更大的文件不抓正文，只留元信息与限制说明。
pub const MAX_SNAPSHOT_BYTES: u64 = 256 * 1024;

/// Diff 的行数上限：再大就不在界面里逐行渲染（避免一次生成几万个节点）。
const MAX_DIFF_LINES: usize = 20_000;

/// LCS 动态规划的最大格子数：超过后退化成"整段替换"，仍然如实标注。
const MAX_LCS_CELLS: usize = 4_000_000;

/// 内存里最多保留多少条变更记录（超出后丢最旧的）。
const RETAIN_RECORDS: usize = 400;

/// 净变化记录的 id 前缀：`net:<taskId>:<path>`。
pub const NET_PREFIX: &str = "net:";

/// 回读脚本的标记行（与 [`snapshot_command`] 一一对应）。
pub const SNAP_MISSING: &str = "__BLS_SNAP_MISSING__";
pub const SNAP_DIR: &str = "__BLS_SNAP_DIR__";
pub const SNAP_SIZE: &str = "__BLS_SNAP_SIZE__";
pub const SNAP_PATH: &str = "__BLS_SNAP_PATH__";
pub const SNAP_TOO_LARGE: &str = "__BLS_SNAP_TOO_LARGE__";
pub const SNAP_B64: &str = "__BLS_SNAP_B64__";
pub const SNAP_ERROR: &str = "__BLS_SNAP_ERROR__";
/// 软链接：值是被解析后的真实路径（正文仍按目标文件读取）。
pub const SNAP_LINK: &str = "__BLS_SNAP_LINK__";

/// 只读回读一段内容的命令。
///
/// 输出协议（每段一段标记行，正文在 `SNAP_B64` 之后）：
/// * 不存在 → `SNAP_MISSING`（新建文件是合法的，不是错误）；
/// * 目录 / 过大 / 读失败 → 各自的标记，调用方据此显示**限制说明**而不是假 Diff；
/// * 存在 → `SNAP_SIZE` / `SNAP_PATH` / `SNAP_B64` + base64 正文。
pub fn snapshot_command(path: &str) -> String {
    let quoted = crate::safe::shell_quote(path);
    format!(
        "__bls_snap={quoted}\n\
         if [ -L \"$__bls_snap\" ]; then printf '\\n{LINK}%s\\n' \"$(readlink -f \"$__bls_snap\" 2>/dev/null)\"; fi\n\
         if [ -d \"$__bls_snap\" ]; then printf '\\n{DIR}\\n'; exit 0; fi\n\
         if [ ! -e \"$__bls_snap\" ]; then printf '\\n{MISSING}\\n'; exit 0; fi\n\
         if [ ! -r \"$__bls_snap\" ]; then printf '\\n{ERROR}\\n'; exit 0; fi\n\
         __bls_size=$(wc -c < \"$__bls_snap\" 2>/dev/null)\n\
         if [ -z \"$__bls_size\" ]; then printf '\\n{ERROR}\\n'; exit 0; fi\n\
         printf '\\n{SIZE}%s\\n' \"$__bls_size\"\n\
         __bls_real=$(readlink -f \"$__bls_snap\" 2>/dev/null || printf %s \"$__bls_snap\")\n\
         printf '\\n{PATH}%s\\n' \"$__bls_real\"\n\
         if [ \"$__bls_size\" -gt {limit} ] 2>/dev/null; then printf '\\n{LARGE}%s\\n' \"$__bls_size\"; exit 0; fi\n\
         printf '\\n{B64}\\n'\n\
         base64 \"$__bls_snap\" 2>/dev/null || printf '\\n{ERROR}\\n'",
        LINK = SNAP_LINK,
        DIR = SNAP_DIR,
        MISSING = SNAP_MISSING,
        SIZE = SNAP_SIZE,
        PATH = SNAP_PATH,
        LARGE = SNAP_TOO_LARGE,
        ERROR = SNAP_ERROR,
        B64 = SNAP_B64,
        limit = MAX_SNAPSHOT_BYTES,
    )
}

/// 一份文件快照。`content` **已脱敏**后才入库与展示。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    /// 读取那一刻文件是否存在（新建文件为 `false`）。
    pub exists: bool,
    /// 规范路径（`readlink -f` 的结果；读不到时用请求的路径）。
    pub path: String,
    /// 内容指纹（sha256 十六进制）；不存在时为空串。
    pub sha: String,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
    /// 目标是目录（不是文件）：不能逐行比较。
    pub is_dir: bool,
    /// 抓到的正文里出现过被替换的敏感值（密码 / 令牌 / 私钥…）。
    pub redacted: bool,
    /// 已脱敏的文本；二进制 / 过大 / 未读到内容时为空串。
    pub content: String,
    /// 不能逐行比较的原因（二进制、过大、目录…）。
    pub note: Option<String>,
}

impl FileSnapshot {
    pub fn absent(path: &str) -> Self {
        Self {
            exists: false,
            path: path.to_string(),
            sha: String::new(),
            size: 0,
            binary: false,
            too_large: false,
            is_dir: false,
            redacted: false,
            content: String::new(),
            note: None,
        }
    }

    /// 从**已知正文**构造快照。
    ///
    /// 计划里的上传步骤由前端知道目标与内容，不必再回读；走与服务器回读相同的
    /// 脱敏入口，Diff 里同样不会出现明文密码 / 私钥。
    pub fn from_text(path: &str, text: &str) -> Self {
        let (content, redacted) = sanitize(text);
        Self {
            exists: true,
            path: path.to_string(),
            sha: sha_of(content.as_bytes()),
            size: text.len() as u64,
            binary: false,
            too_large: false,
            is_dir: false,
            redacted,
            content,
            note: None,
        }
    }

    /// 能否拿它做逐行比较。
    pub fn comparable(&self) -> bool {
        !self.binary && !self.too_large && !self.is_dir
    }
}

/// 把私钥块（PEM）的正文整段换成 `***`。
///
/// 逐行脱敏只认 `key=value` 形态，`-----BEGIN PRIVATE KEY-----` 那种多行块
/// 的 base64 正文不会被认出来 —— 但它恰恰是最不该进 Diff 的内容。
fn mask_private_keys(text: &str) -> (String, bool) {
    let mut out = String::with_capacity(text.len());
    let mut masked = false;
    let mut inside = false;
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let upper = line.to_ascii_uppercase();
        let is_begin = upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY");
        let is_end = upper.contains("-----END") && upper.contains("PRIVATE KEY");
        if is_begin {
            inside = true;
            masked = true;
            out.push_str(line);
            continue;
        }
        if inside {
            if is_end {
                inside = false;
                out.push_str(line);
            } else {
                out.push_str("***");
            }
            continue;
        }
        out.push_str(line);
    }
    (out, masked)
}

/// 快照 / 提交内容入库前的**唯一脱敏入口**：逐行 keys + 私钥块。
pub fn sanitize(text: &str) -> (String, bool) {
    let line_redacted = super::protocol::redact(text);
    let touched_lines = line_redacted != text;
    let (masked, touched_keys) = mask_private_keys(&line_redacted);
    (masked, touched_lines || touched_keys)
}

fn sha_of(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    head.contains(&0u8)
}

/// 把回读脚本的输出解析成快照。
///
/// 没有任何已知标记时返回错误：**拿不到内容就不生成 Diff**，而不是把它当成空文件。
pub fn parse_snapshot(stdout: &str, requested: &str) -> Result<FileSnapshot, String> {
    let mut snapshot = FileSnapshot::absent(requested);
    let mut size: Option<u64> = None;
    let mut note: Option<String> = None;
    let mut payload: Vec<String> = Vec::new();
    let mut in_payload = false;
    // 已经看到正文标记 = 协议完整走到了"读正文"这一步。
    let mut body_started = false;
    let mut failed: Option<String> = None;

    for line in stdout.split('\n') {
        let line = line.trim_end_matches('\r');
        if in_payload {
            let value = line.trim();
            if value.is_empty() {
                continue;
            }
            // 读到一半失败（无权限 / base64 不存在）：不能把 ERROR 当正文。
            if value == SNAP_ERROR {
                failed = Some("服务器拒绝读取这个文件（可能无权限）".to_string());
                in_payload = false;
                continue;
            }
            payload.push(value.to_string());
            continue;
        }
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix(SNAP_SIZE) {
            size = value.trim().parse::<u64>().ok();
            continue;
        }
        if let Some(value) = trimmed.strip_prefix(SNAP_LINK) {
            let value = value.trim();
            if !value.is_empty() {
                note = Some(format!("符号链接 → {value}"));
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix(SNAP_PATH) {
            let value = value.trim();
            if !value.is_empty() {
                snapshot.path = value.to_string();
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix(SNAP_TOO_LARGE) {
            snapshot.too_large = true;
            size = value.trim().parse::<u64>().ok().or(size);
            note = Some("文件超过 256 KB，未抓取正文".to_string());
            continue;
        }
        if trimmed == SNAP_MISSING {
            return Ok(FileSnapshot::absent(requested));
        }
        if trimmed == SNAP_DIR {
            snapshot.is_dir = true;
            note = Some("目标是目录，不是文件".to_string());
            continue;
        }
        if trimmed == SNAP_ERROR {
            failed = Some("服务器拒绝读取这个文件（可能无权限或不是普通文件）".to_string());
            continue;
        }
        if trimmed == SNAP_B64 {
            in_payload = true;
            body_started = true;
            continue;
        }
    }

    if let Some(reason) = failed {
        return Err(reason);
    }
    if snapshot.is_dir {
        snapshot.note = note;
        return Ok(snapshot);
    }
    snapshot.size = size.unwrap_or(0);
    if snapshot.too_large {
        snapshot.note = note;
        return Ok(snapshot);
    }
    if payload.is_empty() {
        /*
         * **只有完整走完协议且大小为 0** 才算空文件（`base64` 对空文件没有输出）。
         *
         * 只看到 SIZE 就判空，会把"读到一半断开 / 没权限"错当成"空文件"，
         * 于是 A → B 的改动被当成"写入前就是空的"，Diff 全变成新增行。
         */
        if body_started && snapshot.size == 0 {
            snapshot.exists = true;
            snapshot.sha = sha_of(b"");
            snapshot.content = String::new();
            return Ok(snapshot);
        }
        return Err("回读结果不完整：没有拿到文件正文".to_string());
    }

    use base64::Engine as _;
    let joined = payload.join("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(joined.as_bytes())
        .map_err(|error| format!("回读内容不是合法 base64：{error}"))?;
    snapshot.exists = true;
    let declared = snapshot.size;
    let actual = bytes.len() as u64;
    /*
     * 声明的字节数必须和真正解出来的长度一致。
     *
     * 不一致说明 `wc -c` 与 `base64` 之间文件被改过（日志在增长、别人在写），
     * 这份正文不能当成"那一刻的完整内容"去做 Diff。
     */
    if declared != 0 && declared != actual {
        return Err(format!(
            "回读字节数与声明大小不一致（声明 {declared}，实际 {actual}），文件可能在读取期间被改动"
        ));
    }
    snapshot.size = actual;
    snapshot.sha = sha_of(&bytes);
    if looks_binary(&bytes) || std::str::from_utf8(&bytes).is_err() {
        snapshot.binary = true;
        snapshot.content = String::new();
        snapshot.note = Some("二进制文件，只记录指纹与大小".to_string());
        return Ok(snapshot);
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let (sanitized, redacted) = sanitize(&text);
    snapshot.redacted = redacted;
    if snapshot.redacted {
        snapshot.note = Some("已对密码 / 令牌 / 私钥等敏感内容脱敏".to_string());
    }
    snapshot.content = sanitized;
    // 软链接之类只在头部给出的说明要保留下来（脱敏说明优先）。
    if snapshot.note.is_none() {
        snapshot.note = note;
    }
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// 行级 Diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
    /// 旧文件行号（新增行为 `None`）。
    pub old_no: Option<u32>,
    /// 新文件行号（删除行为 `None`）。
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub hunks: Vec<DiffHunk>,
    pub additions: u32,
    pub deletions: u32,
    /// 未修改行总数（界面据此显示「N unmodified lines」）。
    pub unchanged: u32,
    /// 内容太大 / 太散，没有逐行比较。
    pub too_large: bool,
    pub note: Option<String>,
}

/// 按行切分：末尾换行不算额外一行，空行保留。
fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Equal,
    Add,
    Del,
}

/// 最长公共子序列 → 编辑序列；规模过大时退化成"整段替换"。
fn edit_script(a: &[&str], b: &[&str]) -> Vec<(Op, usize, usize)> {
    // 先剥掉公共前后缀：配置文件的改动通常只占几行，剥完规模会小一个量级。
    let mut start = 0usize;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end = 0usize;
    while end < a.len() - start
        && end < b.len() - start
        && a[a.len() - 1 - end] == b[b.len() - 1 - end]
    {
        end += 1;
    }
    let mut ops: Vec<(Op, usize, usize)> = Vec::with_capacity(a.len() + b.len());
    for index in 0..start {
        ops.push((Op::Equal, index, index));
    }
    let mid_a = &a[start..a.len() - end];
    let mid_b = &b[start..b.len() - end];
    if !mid_a.is_empty() && !mid_b.is_empty() {
        let cells = mid_a.len().saturating_mul(mid_b.len());
        if cells <= MAX_LCS_CELLS {
            let width = mid_b.len() + 1;
            let mut table = vec![0u32; (mid_a.len() + 1) * width];
            for i in (0..mid_a.len()).rev() {
                for j in (0..mid_b.len()).rev() {
                    table[i * width + j] = if mid_a[i] == mid_b[j] {
                        table[(i + 1) * width + j + 1] + 1
                    } else {
                        table[(i + 1) * width + j].max(table[i * width + j + 1])
                    };
                }
            }
            let (mut i, mut j) = (0usize, 0usize);
            while i < mid_a.len() && j < mid_b.len() {
                if mid_a[i] == mid_b[j] {
                    ops.push((Op::Equal, start + i, start + j));
                    i += 1;
                    j += 1;
                } else if table[(i + 1) * width + j] >= table[i * width + j + 1] {
                    ops.push((Op::Del, start + i, start + j));
                    i += 1;
                } else {
                    ops.push((Op::Add, start + i, start + j));
                    j += 1;
                }
            }
            while i < mid_a.len() {
                ops.push((Op::Del, start + i, start + j));
                i += 1;
            }
            while j < mid_b.len() {
                ops.push((Op::Add, start + i, start + j));
                j += 1;
            }
        } else {
            for index in 0..mid_a.len() {
                ops.push((Op::Del, start + index, start));
            }
            for index in 0..mid_b.len() {
                ops.push((Op::Add, start + mid_a.len(), start + index));
            }
        }
    } else {
        for index in 0..mid_a.len() {
            ops.push((Op::Del, start + index, start));
        }
        for index in 0..mid_b.len() {
            ops.push((Op::Add, start, start + index));
        }
    }
    for index in 0..end {
        ops.push((Op::Equal, a.len() - end + index, b.len() - end + index));
    }
    ops
}

/// 生成统一 Diff：每段带 3 行上下文，靠近的改动合并成一段。
pub fn diff_lines(before: &str, after: &str) -> FileDiff {
    let a = split_lines(before);
    let b = split_lines(after);
    if a.len() + b.len() > MAX_DIFF_LINES {
        return FileDiff {
            hunks: Vec::new(),
            additions: b.len() as u32,
            deletions: a.len() as u32,
            unchanged: 0,
            too_large: true,
            note: Some(format!("文件超过 {MAX_DIFF_LINES} 行，未逐行比较")),
        };
    }

    let script = edit_script(&a, &b);
    let mut additions = 0u32;
    let mut deletions = 0u32;
    let mut unchanged = 0u32;
    let mut numbered: Vec<(Op, String, Option<u32>, Option<u32>)> =
        Vec::with_capacity(script.len());
    for (op, old_index, new_index) in script {
        match op {
            Op::Equal => {
                unchanged += 1;
                numbered.push((
                    Op::Equal,
                    a[old_index].to_string(),
                    Some(old_index as u32 + 1),
                    Some(new_index as u32 + 1),
                ));
            }
            Op::Del => {
                deletions += 1;
                numbered.push((
                    Op::Del,
                    a[old_index].to_string(),
                    Some(old_index as u32 + 1),
                    None,
                ));
            }
            Op::Add => {
                additions += 1;
                numbered.push((
                    Op::Add,
                    b[new_index].to_string(),
                    None,
                    Some(new_index as u32 + 1),
                ));
            }
        }
    }

    // 需要展示的下标：有改动的行 + 前后 3 行上下文，重叠区间合并。
    const CONTEXT: usize = 3;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, (op, ..)) in numbered.iter().enumerate() {
        if *op == Op::Equal {
            continue;
        }
        let from = index.saturating_sub(CONTEXT);
        let to = (index + CONTEXT).min(numbered.len().saturating_sub(1));
        match ranges.last_mut() {
            Some((_, last_to)) if from <= *last_to + 1 => *last_to = (*last_to).max(to),
            _ => ranges.push((from, to)),
        }
    }

    let mut hunks = Vec::new();
    for (from, to) in ranges {
        let slice = &numbered[from..=to];
        let old_start = slice
            .iter()
            .find_map(|(op, _, old, _)| (*op != Op::Add).then_some(*old).flatten())
            .unwrap_or(0);
        let new_start = slice
            .iter()
            .find_map(|(op, _, _, new)| (*op != Op::Del).then_some(*new).flatten())
            .unwrap_or(0);
        let old_lines = slice.iter().filter(|(op, ..)| *op != Op::Add).count() as u32;
        let new_lines = slice.iter().filter(|(op, ..)| *op != Op::Del).count() as u32;
        let lines = slice
            .iter()
            .map(|(op, text, old, new)| DiffLine {
                kind: match op {
                    Op::Equal => DiffKind::Context,
                    Op::Add => DiffKind::Add,
                    Op::Del => DiffKind::Del,
                },
                text: text.clone(),
                old_no: *old,
                new_no: *new,
            })
            .collect();
        hunks.push(DiffHunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines,
        });
    }

    FileDiff {
        hunks,
        additions,
        deletions,
        unchanged,
        too_large: false,
        note: None,
    }
}

// ---------------------------------------------------------------------------
// 变更记录
// ---------------------------------------------------------------------------

/// `stage`：这条记录展示哪一版内容。
/// * `proposed` —— 拟修改（还没写）；
/// * `actual`   —— 服务器上实际回读的结果；
/// * `none`     —— 没有可展示的 Diff（未采集 / 读取失败 / 二进制）。
#[derive(Debug, Clone)]
pub struct ChangeRecord {
    pub id: String,
    pub task_id: String,
    pub call_id: String,
    pub step_index: u32,
    pub workspace_id: Option<String>,
    pub server_id: Option<String>,
    pub server: String,
    pub tool: String,
    pub path: String,
    pub status: String,
    pub stage: String,
    pub before: Option<FileSnapshot>,
    pub proposed: String,
    pub actual: Option<FileSnapshot>,
    /// 工具提交的内容是否已脱敏（影响展示提示）。
    pub redacted: bool,
    pub backup_path: Option<String>,
    /// 备份是否**已被验证存在**（只有写入成功后 `cp` 的标记才作数）。
    pub backup_verified: bool,
    pub note: Option<String>,
    /// 这条记录是"该操作未采集文件差异"的说明项（普通 shell）。
    pub uncollected: bool,
    /// 已确认发生变化、但**没有逐行差异**时的原因（新增空文件 / 二进制已修改 /
    /// 敏感内容已变化…）。界面在没有 `+N / -N` 时用它代替计数。
    pub reason: Option<String>,
    /// 缓存的增删行数：列表要显示 `+N / -N`，但不能为每条记录跑一次逐行比较。
    ///
    /// 内容变化（写入预览 / 回读完成）时由 [`ChangeRecord::recount`] 重算。
    pub additions: u32,
    pub deletions: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl ChangeRecord {
    /// 能不能逐行比较。
    ///
    /// **读不到原文就不比较**：把"没读到"当成空文件会凭空生成一份"全新增"的假 Diff。
    fn comparable(&self) -> bool {
        // 没有原文做基准就没有可信的 Diff：宁可显示"未采集"，也不生成"全新增"。
        let before_ok = self
            .before
            .as_ref()
            .is_some_and(|snapshot| snapshot.comparable());
        match self.stage.as_str() {
            "actual" => {
                before_ok
                    && self
                        .actual
                        .as_ref()
                        .is_some_and(|snapshot| snapshot.comparable())
            }
            "proposed" => before_ok,
            _ => false,
        }
    }

    fn diff(&self) -> FileDiff {
        if !self.comparable() {
            return FileDiff::default();
        }
        let before = self
            .before
            .as_ref()
            .map(|snapshot| snapshot.content.as_str())
            .unwrap_or("");
        let after = match self.stage.as_str() {
            "actual" => self.actual.as_ref().map(|item| item.content.as_str()),
            _ => Some(self.proposed.as_str()),
        };
        let Some(after) = after else {
            return FileDiff::default();
        };
        diff_lines(before, after)
    }

    /// 内容变了就重算一次增删行数（缓存给列表用）。
    pub fn recount(&mut self) {
        let diff = self.diff();
        self.additions = diff.additions;
        self.deletions = diff.deletions;
    }

    pub fn summary(&self) -> FileChangeSummary {
        let exists = match self.stage.as_str() {
            "actual" => self.actual.as_ref().is_some_and(|item| item.exists),
            _ => self.before.as_ref().is_some_and(|item| item.exists),
        };
        FileChangeSummary {
            id: self.id.clone(),
            task_id: self.task_id.clone(),
            call_id: self.call_id.clone(),
            step_index: self.step_index,
            workspace_id: self.workspace_id.clone(),
            server: self.server.clone(),
            server_id: self.server_id.clone(),
            tool: self.tool.clone(),
            path: self.path.clone(),
            status: self.status.clone(),
            stage: self.stage.clone(),
            created: self.before.as_ref().is_some_and(|item| !item.exists),
            binary: self.binary(),
            too_large: self.too_large(),
            additions: self.additions as i64,
            deletions: self.deletions as i64,
            diff_ready: self.comparable(),
            backup_path: self.backup_path.clone(),
            backup_verified: self.backup_verified,
            can_open: exists,
            uncollected: self.uncollected,
            note: self.note.clone(),
            reason: self.reason.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    fn binary(&self) -> bool {
        self.before.as_ref().is_some_and(|item| item.binary)
            || self.actual.as_ref().is_some_and(|item| item.binary)
    }

    fn too_large(&self) -> bool {
        self.before.as_ref().is_some_and(|item| item.too_large)
            || self.actual.as_ref().is_some_and(|item| item.too_large)
    }

    pub fn detail(&self) -> FileChangeDetail {
        let mut limits: Vec<String> = Vec::new();
        if self.binary() {
            limits.push("二进制文件：只显示指纹与大小，不做逐行比较".to_string());
        }
        if self.too_large() {
            limits.push(format!(
                "文件超过 {} KB：未抓取正文，不生成逐行 Diff",
                MAX_SNAPSHOT_BYTES / 1024
            ));
        }
        if self.redacted {
            limits.push("密码 / 令牌等敏感内容已脱敏，Diff 中显示为 ***".to_string());
        }
        if let Some(note) = &self.note {
            if !limits.contains(note) {
                limits.push(note.clone());
            }
        }
        let diff = self.diff();
        if let Some(note) = &diff.note {
            if !limits.contains(note) {
                limits.push(note.clone());
            }
        }
        let comparable = self.comparable();
        let before_text = comparable
            .then(|| self.before.as_ref().map(|item| item.content.clone()))
            .flatten();
        let after_text = comparable
            .then(|| match self.stage.as_str() {
                "actual" => self.actual.as_ref().map(|item| item.content.clone()),
                "proposed" => Some(self.proposed.clone()),
                _ => None,
            })
            .flatten();
        // 详情里的计数以刚算出的 Diff 为准（与正文逐行一致）。
        let mut summary = self.summary();
        if comparable {
            summary.additions = diff.additions as i64;
            summary.deletions = diff.deletions as i64;
        }
        FileChangeDetail {
            summary,
            before: self.before.as_ref().map(|item| SnapshotView {
                exists: item.exists,
                path: item.path.clone(),
                sha: item.sha.clone(),
                size: item.size,
                binary: item.binary,
                too_large: item.too_large,
                note: item.note.clone(),
            }),
            after: self.actual.as_ref().map(|item| SnapshotView {
                exists: item.exists,
                path: item.path.clone(),
                sha: item.sha.clone(),
                size: item.size,
                binary: item.binary,
                too_large: item.too_large,
                note: item.note.clone(),
            }),
            diff,
            before_text,
            after_text,
            limits,
            redacted: self.redacted,
        }
    }
}

/// 变更列表项：**只带标识与摘要**，正文按需用 [`FileChangeDetail`] 取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeSummary {
    pub id: String,
    pub task_id: String,
    pub call_id: String,
    pub step_index: u32,
    pub workspace_id: Option<String>,
    pub server: String,
    pub server_id: Option<String>,
    pub tool: String,
    pub path: String,
    /// `proposed` / `written` / `unchanged` / `write_failed` / `readback_failed` /
    /// `rejected` / `withdrawn` / `stale` / `uncollected` / `unavailable`
    pub status: String,
    /// `proposed` / `actual` / `none`。
    pub stage: String,
    /// 修改前不存在 = 全新增。
    pub created: bool,
    pub binary: bool,
    pub too_large: bool,
    pub additions: i64,
    pub deletions: i64,
    /// 有没有可逐行展示的 Diff。
    pub diff_ready: bool,
    pub backup_path: Option<String>,
    /// 备份**已验证存在**（只是计划中的备份名为 false）。
    pub backup_verified: bool,
    /// 目标文件在最近一次回读里确认存在。
    pub can_open: bool,
    /// 普通 shell 之类的"未采集差异"说明项。
    pub uncollected: bool,
    /// 已确认变化、但没有逐行差异时的原因（新增空文件 / 二进制已修改 / 敏感内容已变化）。
    ///
    /// 老数据里没有这个字段（`serde(default)`）；界面在计数为 0 时用它代替 `+0 -0`。
    #[serde(default)]
    pub reason: Option<String>,
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotView {
    pub exists: bool,
    pub path: String,
    pub sha: String,
    pub size: u64,
    pub binary: bool,
    pub too_large: bool,
    pub note: Option<String>,
}

/// 按需加载的 Diff 正文。历史记录用的是**当时的快照**，不会随服务器再变。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDetail {
    pub summary: FileChangeSummary,
    pub before: Option<SnapshotView>,
    pub after: Option<SnapshotView>,
    pub diff: FileDiff,
    /// 两版正文（已脱敏）：界面用它展开被折叠的未修改长段。
    ///
    /// 只有能逐行比较时才带；二进制 / 过大 / 未采集的内容不会出现在这里。
    pub before_text: Option<String>,
    pub after_text: Option<String>,
    /// 可见的限制说明（二进制 / 过大 / 脱敏 / 回读失败…）。
    pub limits: Vec<String>,
    pub redacted: bool,
}

/// 新建一条变更记录用的草稿。
pub struct ChangeDraft {
    pub id: String,
    pub task_id: String,
    pub call_id: String,
    pub step_index: u32,
    pub workspace_id: Option<String>,
    pub server_id: Option<String>,
    pub server: String,
    pub tool: String,
    pub path: String,
}

/// 落库的历史变更：摘要 + 当时的 Diff 正文（已脱敏、已限长）。
///
/// 应用重启后内存注册表是空的：打开历史任务时用它把同一条记录原样放回来，
/// id 不变，面板照旧按 changeId 取详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredChange {
    pub summary: FileChangeSummary,
    pub detail: FileChangeDetail,
}

/// 落库前单份正文的截断上限（脱敏在前，这里只防体积）。
pub const MAX_STORED_TEXT_BYTES: usize = 64 * 1024;
/// 落库前单条记录保留的 Diff 行数上限。
const MAX_STORED_HUNK_LINES: usize = 2_000;

impl StoredChange {
    pub fn from_record(record: &ChangeRecord) -> Self {
        let mut detail = record.detail();
        detail.before_text = clip_text(detail.before_text);
        detail.after_text = clip_text(detail.after_text);
        let mut kept = 0usize;
        detail.diff.hunks = detail
            .diff
            .hunks
            .into_iter()
            .filter_map(|mut hunk| {
                if kept >= MAX_STORED_HUNK_LINES {
                    return None;
                }
                let room = MAX_STORED_HUNK_LINES - kept;
                hunk.lines.truncate(room);
                kept += hunk.lines.len();
                Some(hunk)
            })
            .collect();
        Self {
            summary: record.summary(),
            detail,
        }
    }
}

fn clip_text(text: Option<String>) -> Option<String> {
    text.map(|value| {
        if value.len() <= MAX_STORED_TEXT_BYTES {
            return value;
        }
        let mut cut = MAX_STORED_TEXT_BYTES;
        while cut > 0 && !value.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n…（历史 Diff 已截断）", &value[..cut])
    })
}

/// 一次运行的**净变化**结果。
///
/// 与逐条列表分开是有意的：`rows` 为空既可能表示"本轮确实没有净变化"，
/// 也可能表示"内存里没有本轮记录"。`available` 把这两种情况分开，
/// 界面据此决定显示「本轮无文件净变化」还是回落到逐条历史。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetChangeSet {
    /// 有没有可用于计算净变化的本轮记录（重启后为 false）。
    pub available: bool,
    /// 有净变化 / 未确认 / 未采集的条目；无净变化的已经被剔除。
    pub rows: Vec<FileChangeSummary>,
    /// 被剔除的「无净变化」路径数（原样保存 / A→B→A / 写失败但没有改动）。
    pub unchanged: usize,
}

/// 一条路径的净变化结论：决定它要不要出现在默认列表里。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NetVerdict {
    /// 有净变化（含"确认变了但没有逐行差异"）。
    Changed,
    /// 首末一致：隐藏。
    Unchanged,
    /// 拿不到可信的最终状态：照常显示，但不算已确认变更。
    Unconfirmed,
}

/// 存在状态 + 类型 + 指纹的比较结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NetDiff {
    Same,
    Created,
    Deleted,
    Modified,
    TypeChanged,
    /// 缺指纹，判断不了（过大 / 只读到元信息）。
    Unknown,
}

fn net_diff(before: &FileSnapshot, after: &FileSnapshot) -> NetDiff {
    if before.is_dir != after.is_dir {
        return NetDiff::TypeChanged;
    }
    match (before.exists, after.exists) {
        (false, false) => NetDiff::Same,
        (false, true) => NetDiff::Created,
        (true, false) => NetDiff::Deleted,
        (true, true) => {
            if before.is_dir {
                // 目录只看存在性：目录里的文件按各自路径单独记账。
                return NetDiff::Same;
            }
            if !before.sha.is_empty() && !after.sha.is_empty() {
                return if before.sha == after.sha {
                    NetDiff::Same
                } else {
                    NetDiff::Modified
                };
            }
            // 没有正文就没有指纹：大小不同能确定改了，大小相同不能证明没改。
            if before.too_large || after.too_large {
                if before.size == after.size {
                    NetDiff::Unknown
                } else {
                    NetDiff::Modified
                }
            } else {
                NetDiff::Unknown
            }
        }
    }
}

/// 已确认变化、但没有逐行差异时的原因文案。
fn net_reason(
    before: &FileSnapshot,
    after: &FileSnapshot,
    diff: NetDiff,
    additions: u32,
    deletions: u32,
) -> Option<String> {
    if before.is_dir || after.is_dir {
        return Some("目标是目录：只记录存在状态".to_string());
    }
    if before.binary || after.binary {
        return Some("二进制已修改（只记录指纹与大小）".to_string());
    }
    if before.too_large || after.too_large {
        return Some("文件超过 256 KB：只确认了大小，未逐行比较".to_string());
    }
    match diff {
        NetDiff::Created if after.size == 0 => Some("新增空文件".to_string()),
        NetDiff::Deleted if before.size == 0 => Some("删除空文件".to_string()),
        NetDiff::TypeChanged => Some("文件类型发生了变化（文件 ↔ 目录）".to_string()),
        _ if additions == 0 && deletions == 0 => Some(
            if before.redacted || after.redacted {
                "敏感内容已变化，差异已隐藏".to_string()
            } else {
                "内容已变化，但没有逐行差异".to_string()
            },
        ),
        _ => None,
    }
}

/// 变更记录注册表：**会话级内存**，按 taskId / workspaceId 查询。
///
/// 历史 Diff 保留当时的快照；服务器上的文件之后再改，这里也不会跟着变。
/// `history` 是从任务历史恢复的只读记录：内存里有同 id 的记录时以内存为准。
#[derive(Debug, Clone, Default)]
pub struct ChangeRegistry {
    records: Arc<Mutex<Vec<ChangeRecord>>>,
    history: Arc<Mutex<std::collections::HashMap<String, StoredChange>>>,
}

impl ChangeRegistry {
    pub fn create(&self, draft: ChangeDraft, status: &str, stage: &str) -> String {
        let now = crate::db::AppDb::now();
        let record = ChangeRecord {
            id: draft.id.clone(),
            task_id: draft.task_id,
            call_id: draft.call_id,
            step_index: draft.step_index,
            workspace_id: draft.workspace_id,
            server_id: draft.server_id,
            server: draft.server,
            tool: draft.tool,
            path: draft.path,
            status: status.to_string(),
            stage: stage.to_string(),
            before: None,
            proposed: String::new(),
            actual: None,
            redacted: false,
            backup_path: None,
            backup_verified: false,
            note: None,
            uncollected: false,
            reason: None,
            additions: 0,
            deletions: 0,
            created_at: now,
            updated_at: now,
        };
        if let Ok(mut records) = self.records.lock() {
            records.push(record);
            if records.len() > RETAIN_RECORDS {
                let drop = records.len() - RETAIN_RECORDS;
                records.drain(0..drop);
            }
        }
        draft.id
    }

    pub fn update<F: FnOnce(&mut ChangeRecord)>(&self, id: &str, change: F) {
        if let Ok(mut records) = self.records.lock() {
            if let Some(record) = records.iter_mut().find(|record| record.id == id) {
                change(record);
                record.updated_at = crate::db::AppDb::now();
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<FileChangeSummary> {
        let live = self.records.lock().ok().and_then(|records| {
            records
                .iter()
                .find(|record| record.id == id)
                .map(|record| record.summary())
        });
        if live.is_some() {
            return live;
        }
        self.history
            .lock()
            .ok()
            .and_then(|history| history.get(id).map(|item| item.summary.clone()))
    }

    /// 这个任务下的全部记录（落库时用）。
    pub fn records_for_task(&self, task_id: &str) -> Vec<ChangeRecord> {
        self.records
            .lock()
            .map(|records| {
                records
                    .iter()
                    .filter(|record| record.task_id == task_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /**
     * 本轮**净变化**：同一路径只留一条，前 = 首次操作前，后 = 最后一次验证后。
     *
     * 面板默认显示这个：一轮里同一文件改三次，列表只出现一行，增删行按
     * "第一次操作前 → 最后一次回读后"统计，不会把三次的增删累加。
     *
     * **前后一致的文件不出现在结果里**（原样保存 / A→B→A / 写失败但没有改动），
     * 只把数量放进 `unchanged`。所以 `rows` 为空且 `available=true` 表示
     * "本轮确实没有净变化"，与"内存里没有本轮记录"（`available=false`）是两件事。
     */
    pub fn net_changes(&self, workspace_id: Option<&str>, task_id: &str) -> NetChangeSet {
        let Ok(records) = self.records.lock() else {
            return NetChangeSet::default();
        };
        let mut groups: Vec<(String, Vec<ChangeRecord>)> = Vec::new();
        let mut total = 0usize;
        for record in records.iter().filter(|item| item.task_id == task_id) {
            if workspace_id.is_some_and(|space| record.workspace_id.as_deref() != Some(space)) {
                continue;
            }
            total += 1;
            // 未采集的占位没有路径，按记录自身分组（不合并）。
            let key = if record.path.is_empty() {
                format!("\u{0}{}", record.id)
            } else {
                record.path.clone()
            };
            match groups.iter_mut().find(|(item, _)| item == &key) {
                Some((_, group)) => group.push(record.clone()),
                None => groups.push((key, vec![record.clone()])),
            }
        }
        if total == 0 {
            // 内存里没有本轮记录（重启后看历史 / 还没跑过）：不能报告"无净变化"。
            return NetChangeSet::default();
        }
        let mut rows: Vec<FileChangeSummary> = Vec::new();
        let mut unchanged = 0usize;
        for (key, group) in &groups {
            let (record, verdict) = self.net_record(task_id, key, group);
            match verdict {
                NetVerdict::Unchanged => unchanged += 1,
                _ => rows.push(record.summary()),
            }
        }
        rows.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        NetChangeSet {
            available: true,
            rows,
            unchanged,
        }
    }

    /// 一条路径的净变化：**用存在状态、类型与可信指纹判定**，不看逐条记录的
    /// 增删行累加。
    fn net_record(
        &self,
        task_id: &str,
        key: &str,
        group: &[ChangeRecord],
    ) -> (ChangeRecord, NetVerdict) {
        let net_id = format!("{NET_PREFIX}{task_id}:{key}");

        // 未采集的占位（普通 shell / 读不到快照）：原样展示，不参与净变化判定。
        if group.iter().all(|record| record.uncollected) {
            let mut record = group[group.len() - 1].clone();
            record.id = net_id;
            record.reason = Some("未采集文件差异：这次操作没有可比对的前后快照".to_string());
            return (record, NetVerdict::Unconfirmed);
        }

        // 只有真正执行过的写操作会动服务器：拟修改 / 被拒 / 撤回 / 作废都不算。
        let executed: Vec<&ChangeRecord> = group
            .iter()
            .filter(|record| {
                matches!(
                    record.status.as_str(),
                    "written" | "unchanged" | "write_failed" | "readback_failed" | "unavailable"
                )
            })
            .collect();
        if executed.is_empty() {
            // 全是被拒或还在等确认的预览：本轮没有任何被应用的变化。
            let mut net = group[group.len() - 1].clone();
            net.id = net_id;
            return (net, NetVerdict::Unchanged);
        }

        let first = executed[0];
        let last = executed[executed.len() - 1];
        let baseline = first.before.clone();
        let final_state = last.actual.clone();
        let tries = executed.len();
        let tries_note = (tries > 1).then(|| {
            format!(
                "本轮共 {tries} 次修改：对比首次操作前与最后一次验证后"
            )
        });

        let mut net = last.clone();
        net.id = net_id;
        net.task_id = task_id.to_string();
        net.before = baseline.clone();
        net.actual = None;
        net.reason = None;
        net.stage = "none".to_string();
        net.note = tries_note;

        let missing_baseline = baseline.is_none();
        let (before, after) = match (baseline, final_state) {
            (Some(before), Some(after)) => (before, after),
            _ => {
                /*
                 * 最后一次操作**自己没有可信回读**：更早的快照不能拿来当最终状态
                 * —— 那会把"中间那次成功"伪装成"这轮最终结果"。
                 */
                net.status = if last.status == "unavailable" {
                    "unavailable".to_string()
                } else {
                    "readback_failed".to_string()
                };
                net.additions = 0;
                net.deletions = 0;
                net.reason = Some(if missing_baseline {
                    "没有可用的写入前快照：无法判断净变化".to_string()
                } else {
                    "最终状态未确认：最后一次回读失败，未用更早的快照代替".to_string()
                });
                return (net, NetVerdict::Unconfirmed);
            }
        };

        let diff = net_diff(&before, &after);
        net.actual = Some(after.clone());
        net.stage = "actual".to_string();

        match diff {
            NetDiff::Same => {
                // 首末一致（原样保存 / A→B→A / 写失败但没有改动）：默认列表隐藏。
                net.status = "unchanged".to_string();
                net.additions = 0;
                net.deletions = 0;
                return (net, NetVerdict::Unchanged);
            }
            NetDiff::Unknown => {
                // 没有指纹（过大 / 只读到元信息）：存在不等于内容没变，别假装已确认。
                net.status = "unavailable".to_string();
                net.additions = 0;
                net.deletions = 0;
                net.reason = Some("缺少可信指纹：只确认了文件存在，无法判断内容是否变化".to_string());
                return (net, NetVerdict::Unconfirmed);
            }
            _ => {}
        }

        net.status = if diff == NetDiff::Deleted {
            "deleted".to_string()
        } else {
            "written".to_string()
        };
        net.recount();
        // 二进制 / 过大 / 目录没有逐行差异：不画 +N/-N，改成一句原因。
        if !net.comparable() {
            net.additions = 0;
            net.deletions = 0;
        }
        net.reason = net_reason(&before, &after, diff, net.additions, net.deletions);
        (net, NetVerdict::Changed)
    }

    /// 把历史落库的记录放回可查询状态：id 不变，已有同 id 的内存记录时不覆盖。
    pub fn remember(&self, stored: Vec<StoredChange>) {
        let Ok(mut history) = self.history.lock() else {
            return;
        };
        for item in stored {
            history.entry(item.summary.id.clone()).or_insert(item);
        }
    }

    /// 取一条完整记录（执行器核对版本时要用 `before` 的指纹与内容）。
    pub fn record(&self, id: &str) -> Option<ChangeRecord> {
        self.records
            .lock()
            .ok()
            .and_then(|records| records.iter().find(|record| record.id == id).cloned())
    }

    pub fn detail(&self, id: &str) -> Option<FileChangeDetail> {
        // 净变化是即时算出来的：id 里带着任务与路径，取详情时按同样规则重算。
        if let Some(rest) = id.strip_prefix(NET_PREFIX) {
            let (task, key) = rest.split_once(':')?;
            let records = self.records.lock().ok()?;
            let group: Vec<ChangeRecord> = records
                .iter()
                .filter(|item| item.task_id == task)
                .filter(|item| {
                    if item.path.is_empty() {
                        format!("\u{0}{}", item.id) == key
                    } else {
                        item.path == key
                    }
                })
                .cloned()
                .collect();
            if group.is_empty() {
                return None;
            }
            return Some(self.net_record(task, key, &group).0.detail());
        }
        let live = self.records.lock().ok().and_then(|records| {
            records
                .iter()
                .find(|record| record.id == id)
                .map(|record| record.detail())
        });
        if live.is_some() {
            return live;
        }
        self.history
            .lock()
            .ok()
            .and_then(|history| history.get(id).map(|item| item.detail.clone()))
    }

    /// 按对话 / 任务列出：**新的在前**，同一任务内按步骤顺序。
    pub fn list(
        &self,
        workspace_id: Option<&str>,
        task_id: Option<&str>,
    ) -> Vec<FileChangeSummary> {
        let Ok(records) = self.records.lock() else {
            return Vec::new();
        };
        let mut out: Vec<FileChangeSummary> = records
            .iter()
            .filter(|record| {
                task_id.is_none_or(|task| record.task_id == task)
                    && workspace_id
                        .is_none_or(|space| record.workspace_id.as_deref() == Some(space))
            })
            .map(|record| record.summary())
            .collect();
        // 历史记录（应用重启后从任务历史恢复）也参与筛选；同 id 以内存为准。
        if let Ok(history) = self.history.lock() {
            for item in history.values() {
                let summary = &item.summary;
                if out.iter().any(|live| live.id == summary.id) {
                    continue;
                }
                if !task_id.is_none_or(|task| summary.task_id == task) {
                    continue;
                }
                if !workspace_id.is_none_or(|space| summary.workspace_id.as_deref() == Some(space))
                {
                    continue;
                }
                out.push(summary.clone());
            }
        }
        out.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.step_index.cmp(&a.step_index))
        });
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    /// 模拟 `snapshot_command` 的输出（size / 规范路径 / base64 正文）。
    fn snapshot_output(content: &str) -> String {
        format!(
            "\n{size}{len}\n\n{path}/etc/nginx/nginx.conf\n{b64}\n{payload}\n",
            size = SNAP_SIZE,
            len = content.len(),
            path = SNAP_PATH,
            b64 = SNAP_B64,
            payload = base64::engine::general_purpose::STANDARD.encode(content.as_bytes()),
        )
    }

    #[test]
    fn missing_and_directory_are_not_errors() {
        let missing = parse_snapshot(&format!("\n{SNAP_MISSING}\n"), "/tmp/a.conf").unwrap();
        assert!(!missing.exists);
        assert!(missing.comparable());
        let dir = parse_snapshot(&format!("\n{SNAP_DIR}\n"), "/etc").unwrap();
        assert!(!dir.comparable(), "目录不能生成 Diff");
        assert!(dir.note.is_some());
    }

    #[test]
    fn unreadable_output_is_an_error_not_an_empty_file() {
        assert!(parse_snapshot("ok: cat /etc/passwd\n", "/etc/passwd").is_err());
    }

    /// 空文件：**协议完整走完 + 大小为 0** 两个条件同时成立才算。
    #[test]
    fn empty_file_requires_the_full_protocol() {
        let empty = format!(
            "\n{size}0\n\n{path}/etc/a.conf\n{b64}\n",
            size = SNAP_SIZE,
            path = SNAP_PATH,
            b64 = SNAP_B64,
        );
        let parsed = parse_snapshot(&empty, "/etc/a.conf").unwrap();
        assert!(parsed.exists);
        assert_eq!(parsed.size, 0);
        assert!(parsed.content.is_empty());
        assert!(parsed.comparable());

        // 只看到 SIZE（输出被截断）：必须报错，不能当成"写入前是空文件"。
        let cut = format!("\n{SNAP_SIZE}42\n");
        assert!(parse_snapshot(&cut, "/etc/a.conf").is_err());
    }

    /// 正文标记之后的 ERROR（无权限 / base64 不存在）不能被当成文件内容。
    #[test]
    fn error_after_the_body_marker_is_not_content() {
        let out = format!(
            "\n{size}10\n\n{path}/etc/secret\n{b64}\n{error}\n",
            size = SNAP_SIZE,
            path = SNAP_PATH,
            b64 = SNAP_B64,
            error = SNAP_ERROR,
        );
        assert!(parse_snapshot(&out, "/etc/secret").is_err());
    }

    /// 协议顺序：正文标记必须在 `base64` 输出**之前**。
    ///
    /// 反了的话解析器会把整份正文当成头部丢掉，每个文件都被读成空文件 ——
    /// A 改成 B 也只剩"新增行"，等于文件变更整体失效。
    #[test]
    fn snapshot_protocol_puts_the_marker_before_the_body() {
        let command = snapshot_command("/etc/a.conf");
        let marker = command.find(SNAP_B64).expect("body marker");
        let body = command
            .find("base64 \"$__bls_snap\"")
            .expect("base64 output");
        assert!(
            marker < body,
            "正文标记要在 base64 输出之前，否则整份正文会当成空文件"
        );
    }

    /// 非空文本 A → B：解析出来的两份快照要能生成一行增、一行删。
    #[test]
    fn changing_non_empty_text_produces_a_diff() {
        let before = parse_snapshot(&snapshot_output("listen 80;\n"), "/etc/a.conf").unwrap();
        let after = parse_snapshot(&snapshot_output("listen 8080;\n"), "/etc/a.conf").unwrap();
        assert_eq!(before.size, "listen 80;\n".len() as u64);
        assert_eq!(after.size, "listen 8080;\n".len() as u64);
        let diff = diff_lines(&before.content, &after.content);
        assert_eq!(diff.additions, 1);
        assert_eq!(diff.deletions, 1);
        assert_eq!(diff.hunks.len(), 1);
    }

    /// 声明的字节数与解码后的长度不一致：不能当成"那一刻的完整内容"。
    #[test]
    fn declared_size_must_match_the_decoded_bytes() {
        let payload = base64::engine::general_purpose::STANDARD.encode(b"ab\n");
        let out = format!(
            "\n{size}99\n\n{path}/tmp/a\n{b64}\n{payload}\n",
            size = SNAP_SIZE,
            path = SNAP_PATH,
            b64 = SNAP_B64,
        );
        assert!(parse_snapshot(&out, "/tmp/a").is_err());
    }

    /// 一轮里同一文件改两次：净变化只留一条，对比首次前与末次后。
    #[test]
    fn net_change_collapses_repeated_edits_of_one_path() {
        let registry = ChangeRegistry::default();
        for (id, before, after) in [("c1", "a\n", "b\n"), ("c2", "b\n", "c\n")] {
            registry.create(
                ChangeDraft {
                    id: id.to_string(),
                    task_id: "t1".to_string(),
                    call_id: "call".to_string(),
                    step_index: 0,
                    workspace_id: Some("w1".to_string()),
                    server_id: None,
                    server: "prod".to_string(),
                    tool: "write_file".to_string(),
                    path: "/etc/a.conf".to_string(),
                },
                "written",
                "actual",
            );
            registry.update(id, |record| {
                record.before = Some(FileSnapshot::from_text("/etc/a.conf", before));
                record.actual = Some(FileSnapshot::from_text("/etc/a.conf", after));
                record.recount();
            });
        }

        let net = registry.net_changes(Some("w1"), "t1");
        assert!(net.available);
        assert_eq!(net.rows.len(), 1, "同一路径只出现一次");
        assert_eq!(net.rows[0].additions, 1, "a → c 是一行增");
        assert_eq!(net.rows[0].deletions, 1, "a → c 是一行删");
        assert!(net.rows[0]
            .note
            .clone()
            .unwrap_or_default()
            .contains("2 次修改"));

        let detail = registry.detail(&net.rows[0].id).expect("净变化详情");
        assert!(detail.before_text.unwrap_or_default().contains('a'));
        assert!(detail.after_text.unwrap_or_default().contains('c'));

        // 归属过滤：别的对话看不到这条。
        let other = registry.net_changes(Some("other"), "t1");
        assert!(!other.available);
        assert!(other.rows.is_empty());
    }

    #[test]
    fn symlink_target_is_reported_in_the_note() {
        let payload = base64::engine::general_purpose::STANDARD.encode(b"srv\n");
        let out = format!(
            "\n{link}/etc/nginx/sites-enabled/site.conf\n{size}4\n\n{path}/etc/nginx/sites-enabled/site.conf\n{b64}\n{payload}\n",
            link = SNAP_LINK,
            size = SNAP_SIZE,
            path = SNAP_PATH,
            b64 = SNAP_B64,
            payload = payload,
        );
        let parsed = parse_snapshot(&out, "/etc/nginx/sites-enabled/site.conf").unwrap();
        assert!(
            parsed.note.unwrap_or_default().contains("符号链接"),
            "软链接要能看出来"
        );
    }

    #[test]
    fn snapshot_parses_base64_and_flags_binary() {
        let text = parse_snapshot(&snapshot_output("server {\n  listen 80;\n}\n"), "/x").unwrap();
        assert!(text.exists);
        assert_eq!(text.content, "server {\n  listen 80;\n}\n");
        assert_eq!(text.sha.len(), 64);

        let binary = base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 3]);
        let out = format!("\n{SNAP_SIZE}4\n\n{SNAP_PATH}/bin/a\n{SNAP_B64}\n{binary}\n");
        let parsed = parse_snapshot(&out, "/bin/a").unwrap();
        assert!(parsed.binary);
        assert!(parsed.content.is_empty());
    }

    #[test]
    fn large_files_keep_metadata_only() {
        let out = format!("\n{SNAP_SIZE}900000\n\n{SNAP_TOO_LARGE}900000\n");
        let parsed = parse_snapshot(&out, "/var/log/big").unwrap();
        assert!(parsed.too_large);
        assert_eq!(parsed.size, 900_000);
        assert!(!parsed.comparable());
    }

    /// 应用重启后：内存注册表是空的，靠任务历史里那份 JSON 把记录与 Diff 放回来。
    #[test]
    fn stored_changes_survive_a_json_round_trip() {
        let registry = ChangeRegistry::default();
        registry.create(
            ChangeDraft {
                id: "c1".to_string(),
                task_id: "t1".to_string(),
                call_id: "editor-save".to_string(),
                step_index: 0,
                workspace_id: Some("w1".to_string()),
                server_id: Some("s1".to_string()),
                server: "prod".to_string(),
                tool: "editor".to_string(),
                path: "/etc/nginx/conf.d/ops.conf".to_string(),
            },
            "written",
            "actual",
        );
        registry.update("c1", |record| {
            record.before = Some(FileSnapshot::from_text(
                "/etc/nginx/conf.d/ops.conf",
                "server {\n  listen 80;\n}\n",
            ));
            record.actual = Some(FileSnapshot::from_text(
                "/etc/nginx/conf.d/ops.conf",
                "server {\n  listen 8080;\n}\n",
            ));
            record.recount();
        });

        let stored: Vec<StoredChange> = registry
            .records_for_task("t1")
            .iter()
            .map(StoredChange::from_record)
            .collect();
        let json = serde_json::to_string(&stored).expect("serialize");
        let back: Vec<StoredChange> = serde_json::from_str(&json).expect("deserialize");

        // 新进程：内存里什么都没有。
        let fresh = ChangeRegistry::default();
        assert!(fresh.list(None, Some("t1")).is_empty());
        fresh.remember(back);

        let list = fresh.list(Some("w1"), Some("t1"));
        assert_eq!(list.len(), 1, "历史记录要能按对话 + 任务查回来");
        assert_eq!(list[0].additions, 1);
        assert_eq!(list[0].deletions, 1);
        let detail = fresh.detail("c1").expect("历史详情要能取到");
        assert_eq!(detail.diff.hunks.len(), 1, "逐行 Diff 也要一起回来");
        assert!(detail.before_text.is_some() && detail.after_text.is_some());
    }

    #[test]
    fn secrets_are_redacted_before_the_snapshot_is_kept() {
        let parsed = parse_snapshot(
            &snapshot_output("username=root\npassword=super-secret\n"),
            "/etc/app.conf",
        )
        .unwrap();
        assert!(
            parsed.content.contains("password=***"),
            "{}",
            parsed.content
        );
        assert!(!parsed.content.contains("super-secret"));
        assert!(parsed.note.is_some());
    }

    /// 私钥是多行 PEM 块：逐行 `key=value` 脱敏认不出来，必须整段盖掉。
    #[test]
    fn private_key_blocks_are_masked() {
        let text = "host=prod\n-----BEGIN OPENSSH PRIVATE KEY-----\n\
                    b3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nport=22\n";
        let (out, touched) = sanitize(text);
        assert!(touched);
        assert!(out.contains("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(out.contains("-----END OPENSSH PRIVATE KEY-----"));
        assert!(!out.contains("b3BlbnNzaC1rZXktdjEAAAAA"));
        assert!(out.contains("port=22"));
        // 普通文本不误伤。
        let (plain, changed) = sanitize("server {\n  listen 80;\n}\n");
        assert!(!changed);
        assert_eq!(plain, "server {\n  listen 80;\n}\n");
    }

    #[test]
    fn diff_counts_additions_and_deletions() {
        let diff = diff_lines("a\nb\nc\n", "a\nB\nc\nd\n");
        assert_eq!(diff.additions, 2, "{diff:?}");
        assert_eq!(diff.deletions, 1, "{diff:?}");
        // 正文与计数必须一致：把 hunk 里的增删行数出来比对。
        let adds = diff
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .filter(|line| line.kind == DiffKind::Add)
            .count() as u32;
        let dels = diff
            .hunks
            .iter()
            .flat_map(|hunk| hunk.lines.iter())
            .filter(|line| line.kind == DiffKind::Del)
            .count() as u32;
        assert_eq!(adds, diff.additions);
        assert_eq!(dels, diff.deletions);
    }

    #[test]
    fn unchanged_files_have_no_hunks() {
        let diff = diff_lines("a\nb\n", "a\nb\n");
        assert!(diff.hunks.is_empty());
        assert_eq!(diff.additions, 0);
        assert_eq!(diff.deletions, 0);
        assert_eq!(diff.unchanged, 2);
    }

    #[test]
    fn new_file_is_all_additions() {
        let diff = diff_lines("", "server {\n}\n");
        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 0);
        assert_eq!(diff.hunks.len(), 1);
        assert!(diff.hunks[0]
            .lines
            .iter()
            .all(|line| line.kind == DiffKind::Add));
    }

    #[test]
    fn far_apart_changes_become_separate_hunks() {
        let before: String = (0..40).map(|index| format!("line {index}\n")).collect();
        let after = before
            .replace("line 2\n", "line two\n")
            .replace("line 35\n", "line thirty-five\n");
        let diff = diff_lines(&before, &after);
        assert_eq!(diff.hunks.len(), 2, "{diff:?}");
        assert_eq!(diff.additions, 2);
        assert_eq!(diff.deletions, 2);
    }

    #[test]
    fn registry_filters_by_workspace_and_task() {
        let registry = ChangeRegistry::default();
        for (id, task, space) in [("c1", "t1", "w1"), ("c2", "t1", "w1"), ("c3", "t2", "w2")] {
            registry.create(
                ChangeDraft {
                    id: id.to_string(),
                    task_id: task.to_string(),
                    call_id: format!("call-{id}"),
                    step_index: 0,
                    workspace_id: Some(space.to_string()),
                    server_id: None,
                    server: "prod".to_string(),
                    tool: "write_file".to_string(),
                    path: "/etc/nginx/nginx.conf".to_string(),
                },
                "proposed",
                "proposed",
            );
        }
        assert_eq!(registry.list(Some("w1"), None).len(), 2);
        assert_eq!(registry.list(Some("w2"), None).len(), 1);
        assert_eq!(registry.list(None, Some("t1")).len(), 2);
        assert_eq!(registry.list(Some("w2"), Some("t1")).len(), 0);
    }

    #[test]
    fn recorded_preview_keeps_its_own_content() {
        let registry = ChangeRegistry::default();
        let id = registry.create(
            ChangeDraft {
                id: "c1".to_string(),
                task_id: "t1".to_string(),
                call_id: "call-1".to_string(),
                step_index: 0,
                workspace_id: None,
                server_id: None,
                server: "prod".to_string(),
                tool: "write_file".to_string(),
                path: "/etc/a.conf".to_string(),
            },
            "proposed",
            "proposed",
        );
        registry.update(&id, |record| {
            record.before = Some(FileSnapshot {
                exists: true,
                path: "/etc/a.conf".to_string(),
                sha: "a".to_string(),
                size: 4,
                binary: false,
                too_large: false,
                is_dir: false,
                redacted: false,
                content: "old\n".to_string(),
                note: None,
            });
            record.proposed = "new\n".to_string();
            record.recount();
        });
        let detail = registry.detail(&id).unwrap();
        assert_eq!(detail.summary.additions, 1);
        assert_eq!(detail.summary.deletions, 1);
        assert_eq!(detail.diff.hunks.len(), 1);
        // 之后再改记录里的 before，也不能影响已经取出的 detail（快照是值拷贝）。
        registry.update(&id, |record| record.proposed = "third\n".to_string());
        assert_eq!(detail.diff.additions, 1);
        assert_eq!(registry.detail(&id).unwrap().summary.deletions, 1);
    }

    /* ---------------- 净变化：首末对比 / 隐藏无变化 / 未确认 ---------------- */

    fn snap(text: &str) -> FileSnapshot {
        FileSnapshot::from_text("/etc/a.conf", text)
    }

    fn absent() -> FileSnapshot {
        FileSnapshot::absent("/etc/a.conf")
    }

    /// 造一条执行过的记录：`before` 是操作前，`after` 是回读结果（None = 回读失败）。
    fn apply(
        registry: &ChangeRegistry,
        id: &str,
        before: FileSnapshot,
        after: Option<FileSnapshot>,
        status: &str,
    ) {
        registry.create(
            ChangeDraft {
                id: id.to_string(),
                task_id: "t1".to_string(),
                call_id: format!("call-{id}"),
                step_index: 0,
                workspace_id: Some("w1".to_string()),
                server_id: None,
                server: "prod".to_string(),
                tool: "write_file".to_string(),
                path: "/etc/a.conf".to_string(),
            },
            status,
            if after.is_some() { "actual" } else { "none" },
        );
        registry.update(id, |record| {
            record.before = Some(before);
            record.actual = after;
            record.recount();
        });
    }

    /// A → B → A：首末一致，默认列表里不出现，但计一次「无净变化」。
    #[test]
    fn net_change_hides_a_file_that_ends_where_it_started() {
        let registry = ChangeRegistry::default();
        apply(&registry, "c1", snap("a\n"), Some(snap("b\n")), "written");
        apply(&registry, "c2", snap("b\n"), Some(snap("a\n")), "written");
        let net = registry.net_changes(Some("w1"), "t1");
        assert!(net.available);
        assert!(net.rows.is_empty(), "A→B→A 不能算净变化：{:?}", net.rows);
        assert_eq!(net.unchanged, 1);
    }

    /// 原样保存 + 写入失败但回读确认没改动：都从默认列表隐藏。
    #[test]
    fn net_change_hides_untouched_and_failed_writes() {
        let registry = ChangeRegistry::default();
        apply(&registry, "c1", snap("same\n"), Some(snap("same\n")), "unchanged");
        apply(
            &registry,
            "c2",
            snap("same\n"),
            Some(snap("same\n")),
            "write_failed",
        );
        let net = registry.net_changes(Some("w1"), "t1");
        assert!(net.rows.is_empty(), "{:?}", net.rows);
        assert_eq!(net.unchanged, 1, "同一路径只算一次");
    }

    /// A → B → B：真的变了，计数按首末对比（不是两次写入相加）。
    #[test]
    fn net_change_keeps_the_real_difference_of_repeated_writes() {
        let registry = ChangeRegistry::default();
        apply(&registry, "c1", snap("a\n"), Some(snap("b\n")), "written");
        apply(&registry, "c2", snap("b\n"), Some(snap("b\n")), "unchanged");
        let net = registry.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].status, "written");
        assert_eq!(net.rows[0].additions, 1);
        assert_eq!(net.rows[0].deletions, 1);
    }

    /// 新建 / 删除空文件：零行变化也必须留在列表里，并说明原因。
    #[test]
    fn net_change_keeps_empty_files_with_a_reason() {
        let registry = ChangeRegistry::default();
        apply(&registry, "created", absent(), Some(snap("")), "written");
        apply(&registry, "deleted", snap(""), Some(absent()), "written");
        let net = registry.net_changes(Some("w1"), "t1");
        // 两条记录的路径相同，A→B 语义上它们是同一个文件：新建后又删除 = 没有净变化。
        assert!(net.rows.is_empty(), "{:?}", net.rows);
        assert_eq!(net.unchanged, 1);

        let single = ChangeRegistry::default();
        apply(&single, "created", absent(), Some(snap("")), "written");
        let net = single.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert!(net.rows[0].created);
        assert_eq!(net.rows[0].additions, 0);
        assert_eq!(net.rows[0].deletions, 0);
        assert_eq!(net.rows[0].reason.as_deref(), Some("新增空文件"));

        let removed = ChangeRegistry::default();
        apply(&removed, "deleted", snap(""), Some(absent()), "written");
        let net = removed.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].status, "deleted");
        assert_eq!(net.rows[0].reason.as_deref(), Some("删除空文件"));
    }

    fn binary_snap(sha: &str) -> FileSnapshot {
        FileSnapshot {
            exists: true,
            path: "/bin/app".to_string(),
            sha: sha.to_string(),
            size: 8,
            binary: true,
            too_large: false,
            is_dir: false,
            redacted: false,
            content: String::new(),
            note: None,
        }
    }

    /// 二进制改动：指纹变了但没法逐行比较 —— 留在列表里，写清原因，不画 +N/-N。
    #[test]
    fn net_change_keeps_binary_edits_without_line_counts() {
        let registry = ChangeRegistry::default();
        apply(
            &registry,
            "c1",
            binary_snap("before"),
            Some(binary_snap("after")),
            "written",
        );
        let net = registry.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].additions, 0);
        assert_eq!(net.rows[0].deletions, 0);
        assert!(!net.rows[0].diff_ready);
        assert!(net.rows[0]
            .reason
            .clone()
            .unwrap_or_default()
            .contains("二进制"));
    }

    /// 脱敏后可见文本相同：指纹变了就还是变化，但差异不可见。
    #[test]
    fn net_change_keeps_redacted_edits_with_a_reason() {
        let registry = ChangeRegistry::default();
        let mut before = snap("password=***\n");
        before.redacted = true;
        before.sha = "old-secret".to_string();
        let mut after = snap("password=***\n");
        after.redacted = true;
        after.sha = "new-secret".to_string();
        apply(&registry, "c1", before, Some(after), "written");
        let net = registry.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].additions, 0);
        assert_eq!(net.rows[0].deletions, 0);
        assert!(net.rows[0]
            .reason
            .clone()
            .unwrap_or_default()
            .contains("敏感内容已变化"));
    }

    /// 最后一次回读失败：不能把更早那次成功回放当成最终状态。
    #[test]
    fn net_change_marks_the_final_state_unconfirmed() {
        let registry = ChangeRegistry::default();
        apply(&registry, "c1", snap("a\n"), Some(snap("b\n")), "written");
        apply(&registry, "c2", snap("b\n"), None, "readback_failed");
        let net = registry.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].status, "readback_failed");
        assert_eq!(net.rows[0].stage, "none", "未确认不能显示成实际变更");
        assert_eq!(net.rows[0].additions, 0);
        assert!(net.rows[0]
            .reason
            .clone()
            .unwrap_or_default()
            .contains("最终状态未确认"));
    }

    /// 没有本轮记录（重启后看历史）：`available=false`，不能报告"无净变化"。
    #[test]
    fn net_change_reports_unavailable_without_live_records() {
        let registry = ChangeRegistry::default();
        let net = registry.net_changes(Some("w1"), "t1");
        assert!(!net.available);
        assert!(net.rows.is_empty());
        assert_eq!(net.unchanged, 0);
    }

    /// 未采集的占位：照常列出，但不带可信快照，也不算已确认变更。
    #[test]
    fn net_change_keeps_uncollected_rows_separate() {
        let registry = ChangeRegistry::default();
        registry.create(
            ChangeDraft {
                id: "u1".to_string(),
                task_id: "t1".to_string(),
                call_id: "call-u1".to_string(),
                step_index: 0,
                workspace_id: Some("w1".to_string()),
                server_id: None,
                server: "prod".to_string(),
                tool: "run_shell".to_string(),
                path: String::new(),
            },
            "uncollected",
            "none",
        );
        registry.update("u1", |record| record.uncollected = true);
        let net = registry.net_changes(Some("w1"), "t1");
        assert_eq!(net.rows.len(), 1);
        assert_eq!(net.rows[0].status, "uncollected");
        assert!(!net.rows[0].diff_ready);
        assert!(net.rows[0]
            .reason
            .clone()
            .unwrap_or_default()
            .contains("未采集"));
    }
}
