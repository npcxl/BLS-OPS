//! SSH 输出的**流式 UTF-8 解码**。
//!
//! # 为什么必须流式
//!
//! SSH 按数据块投递字节，块边界与字符边界**没有任何关系**。一个中文字符
//! （UTF-8 三字节）完全可能被劈成两半：前 1 字节在第 N 块、后 2 字节在第
//! N+1 块。若对每块单独 `String::from_utf8_lossy`，两半各自变成 U+FFFD
//! （`�`），而且**不可恢复** —— 这就是终端里中文乱码的根因。
//!
//! 正确做法：保留未完成的多字节序列，与下一块合并后再解码。
//!
//! # 范围
//!
//! 这里只处理 UTF-8。GB18030 / Big5 老服务器需要 `encoding_rs` 之类的编解码
//! 库 —— 当前**没有引入该依赖，也不假装支持**：非 UTF-8 字节按 lossy 处理，
//! 与旧行为一致（不会更差）。

/// 一个会话的输出解码器：**跨块保留未完成的多字节序列**。
///
/// 每个 SSH 会话一个实例，因为块边界是会话级的；由 reader 循环独占持有。
#[derive(Debug, Clone, Default)]
pub struct Utf8StreamDecoder {
    /// 上一块末尾未完成的字节（最长 3 字节：UTF-8 最多 4 字节）。
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// 喂入一个数据块，返回**可以安全显示/解析**的完整文本。
    ///
    /// 尾部不完整的序列留在内部等下一块。
    pub fn feed(&mut self, chunk: &[u8]) -> String {
        let mut buffer: Vec<u8> = Vec::with_capacity(self.pending.len() + chunk.len());
        buffer.extend_from_slice(&self.pending);
        buffer.extend_from_slice(chunk);
        self.pending.clear();

        // 尾部若是不完整的多字节序列，切下来留到下一块。
        let complete = complete_prefix_len(&buffer);
        if complete < buffer.len() {
            self.pending.extend_from_slice(&buffer[complete..]);
            buffer.truncate(complete);
        }
        if buffer.is_empty() {
            return String::new();
        }
        String::from_utf8_lossy(&buffer).into_owned()
    }

    /// 连接结束：强制吐出残留字节（可能被截断，按 lossy 处理）。
    pub fn flush(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let text = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        text
    }
}

/// `buffer` 里"UTF-8 完整部分"的长度：末尾不完整的序列不计入。
///
/// 依据首字节前导位判断还需要几个续字节：
/// - `0xxxxxxx` → 单字节（ASCII）
/// - `110xxxxx` → 还需 1 个续字节
/// - `1110xxxx` → 还需 2 个
/// - `11110xxx` → 还需 3 个
fn complete_prefix_len(buffer: &[u8]) -> usize {
    let len = buffer.len();
    if len == 0 {
        return 0;
    }
    // 只需检查最后 4 个字节：UTF-8 序列最长 4 字节。
    let start = len.saturating_sub(4);
    for index in (start..len).rev() {
        let byte = buffer[index];
        let needed = if byte < 0x80 {
            0
        } else if byte >> 5 == 0b110 {
            1
        } else if byte >> 4 == 0b1110 {
            2
        } else if byte >> 3 == 0b11110 {
            3
        } else {
            // 续字节（10xxxxxx）或非法首字节：继续往前找真正的首字节。
            continue;
        };
        if len - index - 1 >= needed {
            // 从该字节起的序列已收齐 → 整个 buffer 都可用。
            return len;
        }
        // 还没收齐 → 从这里切开，等下一块。
        return index;
    }
    // 最后 4 字节全是续字节且没找到首字节（异常输入）：保守地全部保留。
    start
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 核心回归：一个中文字符被劈成两个 SSH 数据块。
    ///
    /// 逐块 `from_utf8_lossy` 会产生两个 `�` 且不可恢复 —— 流式解码必须
    /// 把它们合并回完整的"中"。
    #[test]
    fn chinese_char_split_across_chunks() {
        let bytes = "中文".as_bytes().to_vec(); // 每字 3 字节，共 6 字节
        let (first, rest) = bytes.split_at(1); // 第一块只有"中"的第 1 字节

        let mut decoder = Utf8StreamDecoder::new();
        let out1 = decoder.feed(first);
        let out2 = decoder.feed(rest);

        assert_eq!(out1, "", "不完整的序列先不吐出");
        assert_eq!(out2, "中文", "跨块字符必须还原");
        assert_eq!(decoder.flush(), "");
    }

    #[test]
    fn every_split_position_preserves_text() {
        let text = "磁盘使用率 85% 中文测试";
        let bytes = text.as_bytes();
        for cut in 1..bytes.len() {
            let mut decoder = Utf8StreamDecoder::new();
            let mut out = String::new();
            out.push_str(&decoder.feed(&bytes[..cut]));
            out.push_str(&decoder.feed(&bytes[cut..]));
            out.push_str(&decoder.flush());
            assert_eq!(out, text, "在 {cut} 字节处切开后文本必须完整");
        }
    }

    #[test]
    fn byte_at_a_time_still_decodes() {
        let text = "中文abc";
        let mut decoder = Utf8StreamDecoder::new();
        let mut out = String::new();
        for byte in text.as_bytes() {
            out.push_str(&decoder.feed(&[*byte]));
        }
        out.push_str(&decoder.flush());
        assert_eq!(out, text, "逐字节喂入是最坏情况，也必须正确");
    }

    #[test]
    fn three_way_split_of_one_char() {
        // 一个 4 字节 emoji 被切成三段。
        let text = "a\u{1f600}b";
        let bytes = text.as_bytes();
        let mut decoder = Utf8StreamDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.feed(&bytes[..1]));
        out.push_str(&decoder.feed(&bytes[1..3]));
        out.push_str(&decoder.feed(&bytes[3..]));
        out.push_str(&decoder.flush());
        assert_eq!(out, text);
    }

    #[test]
    fn ascii_chunks_are_passed_through() {
        let mut decoder = Utf8StreamDecoder::new();
        assert_eq!(decoder.feed(b"hello\n"), "hello\n");
        assert_eq!(decoder.feed(b"world\n"), "world\n");
    }

    #[test]
    fn flush_emits_truncated_tail() {
        let bytes = "中文".as_bytes().to_vec();
        let mut decoder = Utf8StreamDecoder::new();
        // 只喂前 4 字节（"中"完整 + "文"的 1 字节），再也没有后续。
        assert_eq!(decoder.feed(&bytes[..1]), "");
        assert_eq!(decoder.feed(&bytes[1..4]), "中");
        // 残留 1 字节，flush 时吐出（不丢字符）。
        assert!(!decoder.flush().is_empty());
    }
}
