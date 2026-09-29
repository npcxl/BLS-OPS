//! 制品读取与扫描的硬上限（**常量，编译期确定**）。
//!
//! 这一层是"绝不把不可信输入读爆"这条承诺的机械保障。三条纪律：
//!
//! 1. **超限即停**，不是"读完再报错"：所有清点循环都在每一条目开始时检查上限。
//! 2. **超限必须可见**：调用方把 `truncated` 标出去，UI 绝不说"已扫完"。
//! 3. **数字唯一来源**：`model::ArtifactLimits::current()` 从这里取值下发给前端，
//!    这样"为什么拒绝"能对着同一组数字解释。
//!
//! 数字刻意保守：制品是给人部署用的，不是给爬虫用的。真要部署几十 G 的东西，
//! 正确做法是走"服务器已有目录"或镜像仓库，而不是让本工具先吞进内存。

/// 单次清点最多接受多少个条目。
pub const MAX_ENTRIES: usize = 20_000;

/// 单个条目（解压后）的最大字节数。
pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// 展开后的总体积上限。
pub const MAX_TOTAL_UNCOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 压缩比上限（`展开体积 / 压缩体积`）。超过即视为压缩炸弹。
pub const MAX_COMPRESSION_RATIO: u64 = 200;

/// 目录深度上限。
pub const MAX_DEPTH: usize = 24;

/// 归档内路径长度上限（字符数）。
pub const MAX_PATH_LEN: usize = 1024;

/// 一次识别最多产出多少个服务候选。
pub const MAX_SERVICE_CANDIDATES: usize = 32;

/// 哈希的读缓冲大小。
pub const HASH_CHUNK_BYTES: usize = 64 * 1024;

/// 敏感内容扫描：最多扫多少个文件。
pub const MAX_SECRET_SCAN_FILES: usize = 400;

/// 敏感内容扫描：单文件最多读多少字节（密钥几乎都在文件头部）。
pub const MAX_SECRET_SCAN_BYTES_PER_FILE: usize = 256 * 1024;

/// 敏感内容扫描：累计读取字节上限。
pub const MAX_SECRET_SCAN_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

/// 识别阶段单文件读取上限（比密钥扫描更小：识别只关心小清单文件）。
pub const MAX_INSPECT_BYTES_PER_FILE: usize = 128 * 1024;

/// 识别阶段最多读多少个文件的内容。
pub const MAX_INSPECT_FILES: usize = 80;
