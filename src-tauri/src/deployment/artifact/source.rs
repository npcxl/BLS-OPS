//! 制品内容的**安全入口**：清点结构 + 按需读取。
//!
//! # 为什么这一层是安全边界
//!
//! 上传来的压缩包是不可信输入。所有已知的"解压即中招"都在这里被拦：
//!
//! | 攻击 | 拦法 |
//! | --- | --- |
//! | ZIP Slip（`../../etc/cron.d/x`） | 逐段校验路径，出现 `..` 直接 Critical |
//! | 绝对路径（`/etc/passwd`、`C:\x`、UNC） | 一律拒绝，并记 [FindingKind::AbsolutePath] |
//! | 符号链接 / 硬链接逃逸 | 归档里出现链接就是 Critical —— **我们不落地、不解引用** |
//! | 设备 / FIFO / socket 条目 | [FindingKind::DeviceEntry] |
//! | 压缩炸弹 | 条目数 + 单文件 + 展开总量 + 压缩比 四道上限 |
//! | 路径爆炸（超深 / 超长） | 深度与长度上限 |
//! | 加密条目（我们要读内容，读不了就不能信任） | [FindingKind::EncryptedEntry] |
//!
//! # 永不落地的保证
//!
//! 本模块**从不把归档展开到磁盘**：zip 用中央目录读元数据、按需读单个条目；
//! tar 流式扫头部、匹配到的条目用 `take(limit)` 读进来。目录来源也一样 ——
//! 只读、只按上限读前 N 字节，碰不到别的路径。
//!
//! 绝不执行、绝不加载：读进来的字节只会被当作**文本线索**做字符串匹配
//! （见 `secrets.rs` / `inspect.rs`），没有任何 `dlopen` / `Command` / 反序列化路径。

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use super::limits;
use super::model::{FindingKind, FindingSeverity, SecurityFinding};
use crate::deployment::validate::reject_shell_text;

/// 清点后的一个条目（不含内容）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceEntry {
    /// 规范化后的**相对**路径（`/` 分隔，无 `..`、无前导 `/`）。
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

impl SourceEntry {
    /// 目录深度（`a/b/c` → 3）。
    pub fn depth(&self) -> usize {
        self.path.split('/').filter(|part| !part.is_empty()).count()
    }

    /// 文件名（最后一段）。
    pub fn file_name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }

    /// 小写文件名 —— 匹配标记文件时统一用小写。
    pub fn lower_name(&self) -> String {
        self.file_name().to_ascii_lowercase()
    }

    /// 小写全路径。
    pub fn lower_path(&self) -> String {
        self.path.to_ascii_lowercase()
    }
}

/// 可读内容的来源（本地目录 / ZIP / TAR / 服务器清单）。识别代码只依赖这个 trait，
/// 因此同一套识别逻辑对三种来源完全一致（也便于用内存实现做单测）。
///
/// 要求 `Send + Sync`：整份来源会被搬进阻塞线程池里跑（哈希与解压是同步 I/O），
/// 不是 `Send` 就没法搬。
pub trait ContentSource: Send + Sync {
    fn entries(&self) -> &[SourceEntry];

    /// 批量读取若干个条目，单文件最多 `limit` 字节。
    ///
    /// 读不到（不存在 / 是目录 / 解压失败）就跳过 —— 识别是**尽力而为**，
    /// 缺一个文件不该让整次导入失败，缺什么由检查项如实标记为 `Unknown`。
    fn read_many(&self, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)>;

    fn total_bytes(&self) -> u64 {
        self.entries().iter().map(|entry| entry.size).sum()
    }
}

// -- 路径规范化与校验 -------------------------------------------------------

/// 把归档里的原始名字规范化为**安全的相对路径**，不合法就返回原因。
///
/// 归一化的同时校验：这里返回 `Ok` 就意味着这个路径**不可能**逃出目标目录。
pub fn normalize_entry_path(raw: &str) -> Result<String, (FindingKind, String)> {
    let unified = raw.replace('\\', "/");
    let trimmed = unified.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err((FindingKind::PathLengthLimit, "空路径".to_string()));
    }
    if trimmed.chars().count() > limits::MAX_PATH_LEN {
        return Err((
            FindingKind::PathLengthLimit,
            format!("路径超过 {} 字符", limits::MAX_PATH_LEN),
        ));
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return Err((FindingKind::PathLengthLimit, "路径含控制字符".to_string()));
    }
    // 绝对路径：POSIX 前导 `/`、Windows 盘符、UNC。
    let looks_absolute = trimmed.starts_with('/')
        || trimmed.starts_with("//")
        || trimmed.char_indices().nth(1).is_some_and(|(_, ch)| {
            ch == ':'
                && trimmed
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic())
        });
    if looks_absolute {
        return Err((FindingKind::AbsolutePath, format!("绝对路径：{raw}")));
    }

    let mut parts: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err((FindingKind::ParentTraversal, format!("包含 .. 段：{raw}")));
        }
        parts.push(segment);
    }
    if parts.is_empty() {
        return Err((FindingKind::PathLengthLimit, format!("无有效路径段：{raw}")));
    }
    if parts.len() > limits::MAX_DEPTH {
        return Err((
            FindingKind::DepthLimit,
            format!("目录层级超过 {} 层", limits::MAX_DEPTH),
        ));
    }
    Ok(parts.join("/"))
}

/// 判断规范化后的路径是不是"逃出根目录"（第二道防线，独立于逐段校验）。
pub fn escapes_root(path: &str) -> bool {
    let mut depth: i64 = 0;
    for segment in path.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => depth += 1,
        }
    }
    false
}

fn finding(
    kind: FindingKind,
    location: impl Into<String>,
    detail: impl Into<String>,
) -> SecurityFinding {
    SecurityFinding {
        kind,
        severity: kind.default_severity(),
        location: location.into(),
        detail: detail.into(),
        evidence: None,
        blocking: kind.blocks_import(),
    }
}

// -- 清点结果 ---------------------------------------------------------------

/// 一次清点的结果：条目 + 结构性发现 + 是否被上限截断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inventory {
    pub entries: Vec<SourceEntry>,
    pub findings: Vec<SecurityFinding>,
    /// 到达上限提前停止 —— 如实标注，绝不假装扫完了。
    pub truncated: bool,
    /// 展开后总字节（截断时是**已看到**的部分）。
    pub total_uncompressed: u64,
    /// 归档文件本身的字节数（目录来源 = 0）。
    pub archive_bytes: u64,
}

impl Inventory {
    fn new(archive_bytes: u64) -> Self {
        Self {
            entries: Vec::new(),
            findings: Vec::new(),
            truncated: false,
            total_uncompressed: 0,
            archive_bytes,
        }
    }

    /// 是否已经出现阻断项（出现即可停止继续读，省时间也省风险）。
    pub fn blocked(&self) -> bool {
        self.findings.iter().any(|finding| finding.blocking)
    }

    /// 追加条目并执行体积类上限检查。返回 `false` = 到达上限，必须停止清点。
    fn push(&mut self, path: String, size: u64, is_dir: bool) -> bool {
        if self.entries.len() >= limits::MAX_ENTRIES {
            self.record(
                FindingKind::EntryCountLimit,
                &path,
                format!("条目数超过上限 {}", limits::MAX_ENTRIES),
            );
            self.truncated = true;
            return false;
        }
        if !is_dir && size > limits::MAX_FILE_BYTES {
            self.record(
                FindingKind::FileSizeLimit,
                &path,
                format!("单文件 {} 字节，超过上限 {}", size, limits::MAX_FILE_BYTES),
            );
            self.truncated = true;
            return false;
        }
        let next_total = self.total_uncompressed.saturating_add(size);
        if next_total > limits::MAX_TOTAL_UNCOMPRESSED_BYTES {
            self.record(
                FindingKind::TotalSizeLimit,
                &path,
                format!(
                    "展开后总体积超过上限 {} 字节",
                    limits::MAX_TOTAL_UNCOMPRESSED_BYTES
                ),
            );
            self.truncated = true;
            return false;
        }
        self.total_uncompressed = next_total;
        self.entries.push(SourceEntry { path, size, is_dir });
        true
    }

    /// 记一条发现（同样的 kind + 位置只记一次，避免一个包里 5000 个符号链接刷屏）。
    ///
    /// **不**设置 `truncated` —— "发现了一个危险条目"与"因为上限没扫完"是两件事，
    /// 混在一起用户就不知道报告到底覆盖了多少。危险条目不影响继续清点：我们要把
    /// 问题一次列全（后面的条目仍然只读头部，代价可控）。
    fn record(&mut self, kind: FindingKind, location: &str, detail: String) {
        if !self
            .findings
            .iter()
            .any(|existing| existing.kind == kind && existing.location == location)
        {
            self.findings.push(finding(kind, location, detail));
        }
    }
}

// -- 本地目录 ---------------------------------------------------------------

/// 本地目录来源。
#[derive(Debug, Clone)]
pub struct DirectorySource {
    root: PathBuf,
    inventory: Inventory,
}

impl DirectorySource {
    /// 只读遍历目录：**不跟随符号链接**，超过上限即停。
    pub fn scan(root: &Path) -> Result<Self> {
        let meta = std::fs::symlink_metadata(root)
            .with_context(|| format!("无法读取目录：{}", root.display()))?;
        if meta.file_type().is_symlink() {
            // 根目录本身是符号链接：允许（用户明确选的），但记一条提示。
            let mut inventory = Inventory::new(0);
            inventory.findings.push(SecurityFinding {
                kind: FindingKind::Symlink,
                severity: FindingSeverity::Info,
                location: root.display().to_string(),
                detail: "所选路径是符号链接，已按它指向的目录读取".to_string(),
                evidence: None,
                blocking: false,
            });
            return Self::scan_inner(root, inventory);
        }
        if !meta.is_dir() {
            return Err(anyhow!("不是目录：{}", root.display()));
        }
        Self::scan_inner(root, Inventory::new(0))
    }

    fn scan_inner(root: &Path, inventory: Inventory) -> Result<Self> {
        let mut source = Self {
            root: root.to_path_buf(),
            inventory,
        };
        source.walk(root, 0)?;
        Ok(source)
    }

    fn walk(&mut self, dir: &Path, depth: usize) -> Result<()> {
        if depth > limits::MAX_DEPTH {
            let location = dir.display().to_string();
            self.inventory.record(
                FindingKind::DepthLimit,
                &location,
                format!("目录层级超过 {} 层", limits::MAX_DEPTH),
            );
            return Ok(());
        }
        let mut children: Vec<PathBuf> = std::fs::read_dir(dir)
            .with_context(|| format!("无法列目录：{}", dir.display()))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        children.sort();

        for child in children {
            // 只按"条目数上限"停 —— 危险条目（设备文件等）**不中断遍历**，
            // 报告要一次列全，别让用户以为只有一条问题。
            if self.inventory.entries.len() >= limits::MAX_ENTRIES {
                self.inventory.truncated = true;
                return Ok(());
            }
            let relative = self.relative(&child);
            let meta = match std::fs::symlink_metadata(&child) {
                Ok(meta) => meta,
                Err(error) => {
                    // 读不到就跳过（权限等），但如实记一条 —— 不假装它不存在。
                    self.inventory.findings.push(SecurityFinding {
                        kind: FindingKind::CredentialFile,
                        severity: FindingSeverity::Info,
                        location: relative.clone(),
                        detail: format!("无法读取（已跳过）：{error}"),
                        evidence: None,
                        blocking: false,
                    });
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                // 目录来源里的符号链接**不跟随**：跟着走就可能把 /etc 甚至整个
                // 文件系统卷进来。记一条 Medium（不是 Critical：目录来源是用户
                // 自己机器上的路径，风险与"外部压缩包"不同档）。
                self.inventory.findings.push(SecurityFinding {
                    kind: FindingKind::Symlink,
                    severity: FindingSeverity::Medium,
                    location: relative,
                    detail: "符号链接已被跳过（不跟随，避免把链接指向的目录一起打包）".to_string(),
                    evidence: None,
                    blocking: false,
                });
                continue;
            }
            if meta.is_dir() {
                let path = self.relative(&child);
                if !self.inventory.push(path, 0, true) {
                    return Ok(());
                }
                self.walk(&child, depth + 1)?;
                continue;
            }
            if !meta.is_file() {
                // 设备 / FIFO / socket：不读，直接记 Critical（不能进制品）。
                let path = self.relative(&child);
                self.inventory.record(
                    FindingKind::DeviceEntry,
                    &path,
                    "不是普通文件（设备 / FIFO / socket），不允许作为制品内容".to_string(),
                );
                continue;
            }
            let path = self.relative(&child);
            if !self.inventory.push(path, meta.len(), false) {
                return Ok(());
            }
        }
        Ok(())
    }

    fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn inventory(&self) -> &Inventory {
        &self.inventory
    }

    /// 拼出真实路径 —— **只在清点阶段用过**：读取时按条目里的相对路径拼，
    /// 且再校验一次不许逃出根目录（双保险，防止 entries 被别的代码塞进脏值）。
    fn resolve(&self, relative: &str) -> Option<PathBuf> {
        if escapes_root(relative) || relative.starts_with('/') {
            return None;
        }
        Some(self.root.join(relative))
    }
}

impl ContentSource for DirectorySource {
    fn entries(&self) -> &[SourceEntry] {
        &self.inventory.entries
    }

    fn read_many(&self, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)> {
        let wanted: BTreeSet<&str> = wanted.iter().map(String::as_str).collect();
        let mut out = Vec::new();
        for entry in &self.inventory.entries {
            if entry.is_dir || !wanted.contains(entry.path.as_str()) {
                continue;
            }
            let Some(path) = self.resolve(&entry.path) else {
                continue;
            };
            // 单文件再卡一次大小：清点与读取之间文件可能被写大。
            if entry.size > limit as u64 * 8 {
                continue;
            }
            if let Ok(file) = File::open(&path) {
                let mut buffer = Vec::new();
                if file.take(limit as u64).read_to_end(&mut buffer).is_ok() {
                    out.push((entry.path.clone(), buffer));
                }
            }
        }
        out
    }
}

/// 便捷入口：扫描一个本地目录（只读、不跟随符号链接、有上限）。
pub fn scan_directory(root: &Path) -> Result<DirectorySource> {
    DirectorySource::scan(root)
}

// -- 归档 -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    Zip,
    Tar,
    TarGz,
    TarBz2,
    TarXz,
}

impl ArchiveFormat {
    /// 由扩展名判定（内容判定在 `detect_format` 里用魔术字节兜底）。
    pub fn from_path(path: &Path) -> Option<Self> {
        let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
        if name.ends_with(".zip") || name.ends_with(".jar") || name.ends_with(".war") {
            return Some(ArchiveFormat::Zip);
        }
        if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
            return Some(ArchiveFormat::TarGz);
        }
        if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") {
            return Some(ArchiveFormat::TarBz2);
        }
        if name.ends_with(".tar.xz") || name.ends_with(".txz") {
            return Some(ArchiveFormat::TarXz);
        }
        if name.ends_with(".tar") {
            return Some(ArchiveFormat::Tar);
        }
        None
    }

    /// 是否有可用的解码器（bz2 / xz 没编进来 —— 明确说"不支持"，而不是悄悄失败）。
    pub fn is_supported(self) -> bool {
        matches!(
            self,
            ArchiveFormat::Zip | ArchiveFormat::Tar | ArchiveFormat::TarGz
        )
    }

    pub fn label(self) -> &'static str {
        match self {
            ArchiveFormat::Zip => "zip",
            ArchiveFormat::Tar => "tar",
            ArchiveFormat::TarGz => "tar.gz",
            ArchiveFormat::TarBz2 => "tar.bz2",
            ArchiveFormat::TarXz => "tar.xz",
        }
    }
}

/// 用魔术字节确认格式（扩展名可以被随便改）。
pub fn detect_format(path: &Path) -> Result<ArchiveFormat> {
    let by_name = ArchiveFormat::from_path(path);
    let mut header = [0u8; 6];
    let mut file = File::open(path).with_context(|| format!("无法打开：{}", path.display()))?;
    let read = file.read(&mut header).unwrap_or(0);
    let magic = &header[..read];
    if magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06") {
        return Ok(ArchiveFormat::Zip);
    }
    if magic.starts_with(&[0x1f, 0x8b]) {
        return Ok(ArchiveFormat::TarGz);
    }
    if magic.starts_with(b"BZh") {
        return Ok(ArchiveFormat::TarBz2);
    }
    if magic.starts_with(&[0xfd, b'7', b'z', b'X', b'Z']) {
        return Ok(ArchiveFormat::TarXz);
    }
    // 无魔术字节：tar 头部没有固定签名（ustar 在第 257 字节），先按扩展名认；
    // 认不出就报"不是认识的归档格式"。
    by_name.ok_or_else(|| {
        anyhow!(
            "无法识别的压缩格式（既不是 zip 也不是 tar）：{}",
            path.display()
        )
    })
}

#[derive(Debug, Clone)]
pub struct ArchiveSource {
    path: PathBuf,
    format: ArchiveFormat,
    inventory: Inventory,
}

impl ArchiveSource {
    /// 打开归档并**只清点结构**：不解压、不落地。
    pub fn open(path: &Path) -> Result<Self> {
        let format = detect_format(path)?;
        if !format.is_supported() {
            return Err(anyhow!(
                "暂不支持 {} 格式（请用 .zip / .tar / .tar.gz）",
                format.label()
            ));
        }
        let archive_bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let mut inventory = Inventory::new(archive_bytes);
        match format {
            ArchiveFormat::Zip => inventory_zip(path, &mut inventory)?,
            ArchiveFormat::Tar | ArchiveFormat::TarGz => {
                inventory_tar(path, format, &mut inventory)?
            }
            _ => unreachable!("不支持的格式已在上方拦掉"),
        }

        // 压缩比：只在"看起来像炸弹"时开火（小包压缩比天然高，见下）。
        if archive_bytes > 64 * 1024 {
            let ratio = inventory.total_uncompressed / archive_bytes.max(1);
            if ratio > limits::MAX_COMPRESSION_RATIO {
                inventory.findings.push(finding(
                    FindingKind::CompressionRatioLimit,
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                    format!(
                        "压缩比 {ratio}:1 超过上限 {}:1（展开后 {} 字节，压缩包 {} 字节）",
                        limits::MAX_COMPRESSION_RATIO,
                        inventory.total_uncompressed,
                        archive_bytes
                    ),
                ));
                inventory.truncated = true;
            }
        }

        Ok(Self {
            path: path.to_path_buf(),
            format,
            inventory,
        })
    }

    pub fn format(&self) -> ArchiveFormat {
        self.format
    }

    pub fn inventory(&self) -> &Inventory {
        &self.inventory
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl ContentSource for ArchiveSource {
    fn entries(&self) -> &[SourceEntry] {
        &self.inventory.entries
    }

    fn read_many(&self, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)> {
        match self.format {
            ArchiveFormat::Zip => read_zip_entries(&self.path, wanted, limit),
            ArchiveFormat::Tar | ArchiveFormat::TarGz => {
                read_tar_entries(&self.path, self.format, wanted, limit)
            }
            _ => Vec::new(),
        }
    }
}

fn inventory_zip(path: &Path, inventory: &mut Inventory) -> Result<()> {
    let file = File::open(path).with_context(|| format!("无法打开压缩包：{}", path.display()))?;
    let mut archive = zip::ZipArchive::new(BufReader::new(file))
        .map_err(|error| anyhow!("不是有效的 ZIP：{error}"))?;

    for index in 0..archive.len() {
        if inventory.entries.len() >= limits::MAX_ENTRIES {
            inventory.truncated = true;
            break;
        }
        let entry = match archive.by_index_raw(index) {
            Ok(entry) => entry,
            Err(error) => {
                inventory.findings.push(finding(
                    FindingKind::EncryptedEntry,
                    format!("#{index}"),
                    format!("条目无法读取（可能加密）：{error}"),
                ));
                continue;
            }
        };
        let raw_name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let size = entry.size();
        let compressed = entry.compressed_size();
        let unix_mode = entry.unix_mode();

        // 链接 / 设备条目：ZIP 用 unix mode 的高位表示。
        if let Some(mode) = unix_mode {
            let file_type = mode & 0o170000;
            if file_type == 0o120000 {
                inventory.findings.push(finding(
                    FindingKind::Symlink,
                    &raw_name,
                    "归档内包含符号链接：不解引用、不导入（链接可能指向制品之外的路径）"
                        .to_string(),
                ));
                continue;
            }
            if matches!(file_type, 0o020000 | 0o060000 | 0o010000 | 0o140000) {
                inventory.findings.push(finding(
                    FindingKind::DeviceEntry,
                    &raw_name,
                    "归档内包含设备 / FIFO / socket 条目，不允许导入".to_string(),
                ));
                continue;
            }
        }
        if entry.encrypted() {
            inventory.findings.push(finding(
                FindingKind::EncryptedEntry,
                &raw_name,
                "条目已加密：无法读取内容校验，也不接受加密制品".to_string(),
            ));
            continue;
        }

        let normalized = match normalize_entry_path(&raw_name) {
            Ok(path) => path,
            Err((kind, detail)) => {
                inventory.findings.push(finding(kind, &raw_name, detail));
                continue;
            }
        };
        if compressed > 0 && size / compressed > limits::MAX_COMPRESSION_RATIO && size > 1024 * 1024
        {
            inventory.findings.push(finding(
                FindingKind::CompressionRatioLimit,
                &normalized,
                format!(
                    "单条目压缩比 {}:1 超过上限 {}:1",
                    size / compressed,
                    limits::MAX_COMPRESSION_RATIO
                ),
            ));
            continue;
        }
        inventory.push(normalized, size, is_dir);
    }
    Ok(())
}

fn inventory_tar(path: &Path, format: ArchiveFormat, inventory: &mut Inventory) -> Result<()> {
    let reader = tar_reader(path, format)?;
    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .with_context(|| format!("无法读取 tar：{}", path.display()))?;

    for entry in entries {
        if inventory.entries.len() >= limits::MAX_ENTRIES {
            inventory.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                inventory.truncated = true;
                inventory.findings.push(finding(
                    FindingKind::EncryptedEntry,
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                    format!("tar 条目无法解析（已停止）：{error}"),
                ));
                break;
            }
        };
        let header = entry.header();
        let entry_type = header.entry_type();
        let size = header.size().unwrap_or(0);
        let raw_name = entry
            .path()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let is_dir = entry_type.is_dir();

        if entry_type.is_symlink() || entry_type.is_hard_link() {
            inventory.findings.push(finding(
                if entry_type.is_symlink() {
                    FindingKind::Symlink
                } else {
                    FindingKind::Hardlink
                },
                &raw_name,
                "归档内包含链接条目：不解引用、不导入".to_string(),
            ));
            continue;
        }
        if !(entry_type.is_file() || is_dir) {
            inventory.findings.push(finding(
                FindingKind::DeviceEntry,
                &raw_name,
                format!("不支持的条目类型：{entry_type:?}"),
            ));
            continue;
        }

        let normalized = match normalize_entry_path(&raw_name) {
            Ok(path) => path,
            Err((kind, detail)) => {
                inventory.findings.push(finding(kind, &raw_name, detail));
                continue;
            }
        };
        inventory.push(normalized, size, is_dir);
    }
    Ok(())
}

fn tar_reader(path: &Path, format: ArchiveFormat) -> Result<Box<dyn Read>> {
    let file = File::open(path).with_context(|| format!("无法打开压缩包：{}", path.display()))?;
    Ok(match format {
        ArchiveFormat::TarGz => Box::new(flate2::read::GzDecoder::new(BufReader::new(file))),
        _ => Box::new(BufReader::new(file)),
    })
}

fn read_zip_entries(path: &Path, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)> {
    let Ok(file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(mut archive) = zip::ZipArchive::new(BufReader::new(file)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in wanted {
        let Ok(mut entry) = archive.by_name(name) else {
            continue;
        };
        if entry.is_dir() || entry.size() > limit as u64 * 8 {
            continue;
        }
        let mut buffer = Vec::new();
        if entry.take(limit as u64).read_to_end(&mut buffer).is_ok() {
            out.push((name.clone(), buffer));
        }
    }
    out
}

fn read_tar_entries(
    path: &Path,
    format: ArchiveFormat,
    wanted: &[String],
    limit: usize,
) -> Vec<(String, Vec<u8>)> {
    let Ok(reader) = tar_reader(path, format) else {
        return Vec::new();
    };
    let wanted: BTreeSet<&str> = wanted.iter().map(String::as_str).collect();
    let mut archive = tar::Archive::new(reader);
    let Ok(entries) = archive.entries() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry
            .path()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
        else {
            continue;
        };
        let Ok(normalized) = normalize_entry_path(&name) else {
            continue;
        };
        if !wanted.contains(normalized.as_str()) {
            continue;
        }
        let mut entry = entry;
        if entry.header().size().unwrap_or(0) > limit as u64 * 8 {
            continue;
        }
        let mut buffer = Vec::new();
        if entry.take(limit as u64).read_to_end(&mut buffer).is_ok() {
            out.push((normalized, buffer));
        }
    }
    out
}

/// 单文件来源：把"一个文件"当成只有一个条目的来源（JAR / 二进制 / Dockerfile）。
#[derive(Debug, Clone)]
pub struct FileSource {
    path: PathBuf,
    entries: Vec<SourceEntry>,
}

impl FileSource {
    pub fn open(path: &Path) -> Result<Self> {
        let meta =
            std::fs::metadata(path).with_context(|| format!("无法读取文件：{}", path.display()))?;
        if !meta.is_file() {
            return Err(anyhow!("不是文件：{}", path.display()));
        }
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "artifact".to_string());
        Ok(Self {
            path: path.to_path_buf(),
            entries: vec![SourceEntry {
                path: name,
                size: meta.len(),
                is_dir: false,
            }],
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl ContentSource for FileSource {
    fn entries(&self) -> &[SourceEntry] {
        &self.entries
    }

    fn read_many(&self, wanted: &[String], limit: usize) -> Vec<(String, Vec<u8>)> {
        if !wanted.iter().any(|name| name == &self.entries[0].path) {
            return Vec::new();
        }
        let Ok(file) = File::open(&self.path) else {
            return Vec::new();
        };
        let mut buffer = Vec::new();
        if file.take(limit as u64).read_to_end(&mut buffer).is_ok() {
            vec![(self.entries[0].path.clone(), buffer)]
        } else {
            Vec::new()
        }
    }
}

/// 文本解码：制品里的清单文件基本都是 UTF-8；解不出来就**返回 None**，
/// 绝不猜编码（猜错会把二进制当文本匹配，制造假发现）。
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if bytes.iter().take(4096).any(|byte| *byte == 0) {
        return None; // 含 NUL → 二进制
    }
    match String::from_utf8(bytes.to_vec()) {
        Ok(text) => Some(text),
        Err(_) => None,
    }
}

/// 校验一个"相对路径"可以作为制品内的子路径（确认阶段用）。
pub fn validate_relative_path(value: &str) -> Result<String> {
    let normalized = normalize_entry_path(value).map_err(|(_, detail)| anyhow!("{detail}"))?;
    reject_shell_text(&normalized, "制品相对路径")?;
    if escapes_root(&normalized) {
        return Err(anyhow!("路径逃出了制品根目录：{value}"));
    }
    Ok(normalized)
}

/// 定长头部读取（供 `inspect` 判断压缩包内是否嵌套压缩包）。
pub fn read_head(path: &Path, bytes: usize) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let mut buffer = vec![0u8; bytes];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);
    Some(buffer)
}
