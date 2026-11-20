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

/// 回读脚本的标记行（与 [`snapshot_command`] 一一对应）。
pub const SNAP_MISSING: &str = "__BLS_SNAP_MISSING__";
pub const SNAP_DIR: &str = "__BLS_SNAP_DIR__";
pub const SNAP_SIZE: &str = "__BLS_SNAP_SIZE__";
pub const SNAP_PATH: &str = "__BLS_SNAP_PATH__";
pub const SNAP_TOO_LARGE: &str = "__BLS_SNAP_TOO_LARGE__";
pub const SNAP_B64: &str = "__BLS_SNAP_B64__";
pub const SNAP_ERROR: &str = "__BLS_SNAP_ERROR__";

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
         if [ -d \"$__bls_snap\" ]; then printf '\\n{DIR}\\n'; exit 0; fi\n\
         if [ ! -e \"$__bls_snap\" ]; then printf '\\n{MISSING}\\n'; exit 0; fi\n\
         __bls_size=$(wc -c < \"$__bls_snap\" 2>/dev/null || printf 0)\n\
         printf '\\n{SIZE}%s\\n' \"$__bls_size\"\n\
         __bls_real=$(readlink -f \"$__bls_snap\" 2>/dev/null || printf %s \"$__bls_snap\")\n\
         printf '\\n{PATH}%s\\n' \"$__bls_real\"\n\
         if [ \"$__bls_size\" -gt {limit} ] 2>/dev/null; then printf '\\n{LARGE}%s\\n' \"$__bls_size\"; exit 0; fi\n\
         if ! base64 \"$__bls_snap\" 2>/dev/null; then printf '\\n{ERROR}\\n'; exit 1; fi\n\
         printf '\\n{B64}\\n'",
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
    let mut failed: Option<String> = None;

    for line in stdout.split('\n') {
        let line = line.trim_end_matches('\r');
        if in_payload {
            if line.trim().is_empty() {
                continue;
            }
            payload.push(line.trim().to_string());
            continue;
        }
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix(SNAP_SIZE) {
            size = value.trim().parse::<u64>().ok();
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
        // 标记齐全但没有正文：空文件（`base64` 对空文件没有输出）也是合法情况。
        if stdout.contains(SNAP_SIZE) {
            snapshot.exists = true;
            snapshot.sha = sha_of(b"");
            snapshot.content = String::new();
            return Ok(snapshot);
        }
        return Err("无法解析服务器回读结果".to_string());
    }

    use base64::Engine as _;
    let joined = payload.join("");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(joined.as_bytes())
        .map_err(|error| format!("回读内容不是合法 base64：{error}"))?;
    snapshot.exists = true;
    snapshot.size = if snapshot.size == 0 {
        bytes.len() as u64
    } else {
        snapshot.size
    };
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
    Ok(snapshot)
}

// ---------------------------------------------------------------------------
// 行级 Diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffKind {
    Context,
    Add,
    Del,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
    /// 旧文件行号（新增行为 `None`）。
    pub old_no: Option<u32>,
    /// 新文件行号（删除行为 `None`）。
    pub new_no: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Default, Serialize)]
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
#[derive(Debug, Clone, Serialize)]
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
    pub note: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
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
#[derive(Debug, Clone, Serialize)]
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

/// 变更记录注册表：**会话级内存**，按 taskId / workspaceId 查询。
///
/// 历史 Diff 保留当时的快照；服务器上的文件之后再改，这里也不会跟着变。
#[derive(Debug, Clone, Default)]
pub struct ChangeRegistry {
    records: Arc<Mutex<Vec<ChangeRecord>>>,
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
        self.records.lock().ok().and_then(|records| {
            records
                .iter()
                .find(|record| record.id == id)
                .map(|record| record.summary())
        })
    }

    /// 取一条完整记录（执行器核对版本时要用 `before` 的指纹与内容）。
    pub fn record(&self, id: &str) -> Option<ChangeRecord> {
        self.records
            .lock()
            .ok()
            .and_then(|records| records.iter().find(|record| record.id == id).cloned())
    }

    pub fn detail(&self, id: &str) -> Option<FileChangeDetail> {
        self.records.lock().ok().and_then(|records| {
            records
                .iter()
                .find(|record| record.id == id)
                .map(|record| record.detail())
        })
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
}
