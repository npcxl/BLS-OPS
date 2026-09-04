//! 会话输出解码 —— 流式 UTF-8 + 老服务器编码（GB18030 / Big5）。
//!
//! # 为什么每条流一个解码器
//!
//! stdout 与 stderr 的**字节边界互不相干**：一个中文字符在 stdout 上跨块，
//! 与 stderr 此刻正在收什么毫无关系。共用一个解码器会把两条流的残片拼在
//! 一起 —— 要么产出乱码，要么丢字符。所以 `ssh_connect` 的 reader 循环里
//! 两条流各持一个 [`OutputDecoder`]。
//!
//! # 自动模式怎么判定
//!
//! 按 UTF-8 解；只有**真的**出现非法字节（`str::from_utf8` 报 `error_len`
//! 非空）才永久降级到 GB18030 —— GB18030 是中文 Linux 服务器最常见的老编码，
//! 且能解任意字节序列（降级后不会更差）。尾部**不完整**的多字节序列不算
//! 非法：它会留到下一块（这正是 [`Utf8StreamDecoder`] 的职责）。

use encoding_rs::Encoding;

use super::utf8_stream::Utf8StreamDecoder;

/// 会话输出编码设置（`auto` / `utf8` / `gb18030` / `big5`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionEncoding {
    /// 自动：先按 UTF-8，遇真非法字节降级 GB18030。
    Auto,
    Utf8,
    Gb18030,
    Big5,
}

impl SessionEncoding {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionEncoding::Auto => "auto",
            SessionEncoding::Utf8 => "utf8",
            SessionEncoding::Gb18030 => "gb18030",
            SessionEncoding::Big5 => "big5",
        }
    }

    /// 前端传来的字符串 → 枚举；认不出返回 `None`（**绝不猜**）。
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "auto" | "" => Some(SessionEncoding::Auto),
            "utf8" | "utf-8" | "utf_8" => Some(SessionEncoding::Utf8),
            "gb18030" | "gbk" => Some(SessionEncoding::Gb18030),
            "big5" => Some(SessionEncoding::Big5),
            _ => None,
        }
    }

    pub const ALL: [SessionEncoding; 4] = [
        SessionEncoding::Auto,
        SessionEncoding::Utf8,
        SessionEncoding::Gb18030,
        SessionEncoding::Big5,
    ];

    fn legacy(self) -> Option<&'static Encoding> {
        match self {
            SessionEncoding::Gb18030 => Some(encoding_rs::GB18030),
            SessionEncoding::Big5 => Some(encoding_rs::BIG5),
            SessionEncoding::Auto | SessionEncoding::Utf8 => None,
        }
    }
}

/// 非 UTF-8 编码的流式解码器（`encoding_rs` 自己保留不完整的尾字节）。
struct LegacyDecoder {
    decoder: Box<encoding_rs::Decoder>,
}

impl LegacyDecoder {
    fn new(encoding: &'static Encoding) -> Self {
        Self {
            decoder: Box::new(encoding.new_decoder_without_bom_handling()),
        }
    }

    fn feed(&mut self, chunk: &[u8], last: bool) -> String {
        let mut out = String::with_capacity(chunk.len() + 8);
        let (_, _, _) = self.decoder.decode_to_string(chunk, &mut out, last);
        out
    }
}

enum Mode {
    Utf8(Utf8StreamDecoder),
    Legacy(LegacyDecoder),
    /// 自动模式：pending = 尚未确定编码时累积的字节；legacy = 降级后的解码器。
    Auto {
        pending: Vec<u8>,
        legacy: Option<LegacyDecoder>,
    },
}

/// 一条输出流（stdout 或 stderr）的解码器。
pub struct OutputDecoder {
    encoding: SessionEncoding,
    mode: Mode,
}

impl OutputDecoder {
    pub fn new(encoding: SessionEncoding) -> Self {
        let mode = match encoding {
            SessionEncoding::Utf8 => Mode::Utf8(Utf8StreamDecoder::new()),
            SessionEncoding::Auto => Mode::Auto {
                pending: Vec::new(),
                legacy: None,
            },
            other => Mode::Legacy(LegacyDecoder::new(
                other.legacy().unwrap_or(encoding_rs::GB18030),
            )),
        };
        Self { encoding, mode }
    }

    pub fn encoding(&self) -> SessionEncoding {
        self.encoding
    }

    /// 喂入一个数据块，返回**可以安全显示 / 解析**的完整文本。
    pub fn feed(&mut self, chunk: &[u8]) -> String {
        match &mut self.mode {
            Mode::Utf8(decoder) => decoder.feed(chunk),
            Mode::Legacy(decoder) => decoder.feed(chunk, false),
            Mode::Auto { pending, legacy } => {
                if let Some(legacy) = legacy {
                    return legacy.feed(chunk, false);
                }
                pending.extend_from_slice(chunk);
                match std::str::from_utf8(pending) {
                    // 全部合法（含"尾部本就完整"）→ 直接吐出。
                    Ok(text) => {
                        let text = text.to_string();
                        pending.clear();
                        text
                    }
                    // 尾部是不完整的多字节序列 → 吐出合法前缀，尾巴留下。
                    Err(error) if error.error_len().is_none() => {
                        let valid = error.valid_up_to();
                        let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                        pending.drain(..valid);
                        text
                    }
                    // 真非法字节 → 永久降级（此后恒用 GB18030 解）。
                    Err(_) => {
                        let mut decoder = LegacyDecoder::new(encoding_rs::GB18030);
                        let taken = std::mem::take(pending);
                        let text = decoder.feed(&taken, false);
                        *legacy = Some(decoder);
                        text
                    }
                }
            }
        }
    }

    /// 流结束：吐出残留字节。
    pub fn flush(&mut self) -> String {
        match &mut self.mode {
            Mode::Utf8(decoder) => decoder.flush(),
            Mode::Legacy(decoder) => decoder.feed(&[], true),
            Mode::Auto { pending, legacy } => {
                if let Some(legacy) = legacy {
                    return legacy.feed(&[], true);
                }
                if pending.is_empty() {
                    return String::new();
                }
                let taken = std::mem::take(pending);
                String::from_utf8_lossy(&taken).into_owned()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTF-8 跨块中文：与 `Utf8StreamDecoder` 行为一致（保留现有能力）。
    #[test]
    fn utf8_mode_keeps_split_chinese_intact() {
        let bytes = "中文".as_bytes().to_vec();
        let mut decoder = OutputDecoder::new(SessionEncoding::Utf8);
        assert_eq!(decoder.feed(&bytes[..1]), "");
        assert_eq!(decoder.feed(&bytes[1..]), "中文");
    }

    /// UTF-8 模式下即使遇到非法字节也**不**降级（用户显式选了 UTF-8）。
    #[test]
    fn explicit_utf8_never_downgrades() {
        let mut decoder = OutputDecoder::new(SessionEncoding::Utf8);
        let out = decoder.feed(&[0xC4, 0xE3, 0xBA, 0xC3]); // GB18030 的"你好"
        assert!(
            !out.contains("你"),
            "显式 UTF-8：非法字节按 lossy 处理，绝不偷偷按 GB18030 解"
        );
        assert!(out.contains('\u{FFFD}'), "lossy 替换符可见：{out:?}");
    }

    /// 自动模式：合法 UTF-8 走 UTF-8；出现真非法字节后降级到 GB18030。
    #[test]
    fn auto_downgrades_to_gb18030_on_invalid_utf8() {
        let mut decoder = OutputDecoder::new(SessionEncoding::Auto);
        assert_eq!(decoder.feed("hello\n".as_bytes()), "hello\n");

        // GB18030 的"你好" = C4 E3 BA C3，在 UTF-8 里是非法序列。
        assert_eq!(decoder.feed(&[0xC4]), "", "单个字节不足以下结论，先攒着");
        assert_eq!(
            decoder.feed(&[0xE3, 0xBA, 0xC3]),
            "你好",
            "确认为非法 UTF-8 → 降级并按 GB18030 解出"
        );
        // 降级是永久的：之后同样的字节继续按 GB18030 解。
        assert_eq!(decoder.feed(&[0xC4, 0xE3, 0xBA, 0xC3]), "你好");
    }

    /// 自动模式下"尾部不完整"的 UTF-8 序列**不能**触发降级（否则中文全乱）。
    #[test]
    fn auto_does_not_downgrade_on_incomplete_tail() {
        let bytes = "中文".as_bytes().to_vec();
        let mut decoder = OutputDecoder::new(SessionEncoding::Auto);
        assert_eq!(decoder.feed(&bytes[..1]), "");
        assert_eq!(decoder.feed(&bytes[1..4]), "中");
        assert_eq!(decoder.feed(&bytes[4..]), "文");
        assert_eq!(decoder.flush(), "");
    }

    /// 显式 GB18030：跨块也必须解出完整中文。
    #[test]
    fn gb18030_mode_decodes_across_chunks() {
        let bytes: Vec<u8> = vec![0xC4, 0xE3, 0xBA, 0xC3]; // 你好
        let mut decoder = OutputDecoder::new(SessionEncoding::Gb18030);
        assert_eq!(decoder.feed(&bytes[..1]), "");
        assert_eq!(decoder.feed(&bytes[1..3]), "你");
        assert_eq!(decoder.feed(&bytes[3..]), "好");
    }

    /// 显式 Big5：跨块解码。
    #[test]
    fn big5_mode_decodes_across_chunks() {
        // Big5 的"中文" = A4 A4 A4 E5
        let bytes: Vec<u8> = vec![0xA4, 0xA4, 0xA4, 0xE5];
        let mut decoder = OutputDecoder::new(SessionEncoding::Big5);
        assert_eq!(decoder.feed(&bytes[..1]), "", "半个双字节字符先不吐出");
        assert_eq!(decoder.feed(&bytes[1..2]), "中");
        assert_eq!(decoder.feed(&bytes[2..]), "文");
    }

    /// stdout 与 stderr 的解码器必须**互不影响**。
    #[test]
    fn stdout_and_stderr_decoders_are_independent() {
        let bytes = "中文".as_bytes().to_vec();
        let mut stdout = OutputDecoder::new(SessionEncoding::Utf8);
        let mut stderr = OutputDecoder::new(SessionEncoding::Utf8);
        // 两条流在不同位置被切开。
        assert_eq!(stdout.feed(&bytes[..1]), "");
        assert_eq!(stderr.feed(&bytes[..4]), "中");
        assert_eq!(stdout.feed(&bytes[1..]), "中文");
        assert_eq!(stderr.feed(&bytes[4..]), "文");
    }

    #[test]
    fn encoding_parsing_round_trips() {
        for encoding in SessionEncoding::ALL {
            assert_eq!(SessionEncoding::parse(encoding.as_str()), Some(encoding));
        }
        assert_eq!(SessionEncoding::parse("UTF-8"), Some(SessionEncoding::Utf8));
        assert_eq!(
            SessionEncoding::parse("gbk"),
            Some(SessionEncoding::Gb18030)
        );
        assert_eq!(SessionEncoding::parse("latin1"), None, "认不出就返回 None");
    }
}
