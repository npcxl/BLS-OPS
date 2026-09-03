//! 第二层通用解析器：与具体产品无关的通用文本形态。
//!
//! 覆盖大部分普通 Linux 命令；认不出的命令由第三层专用解析器处理，
//! 再不行就回落 raw。

pub mod json;
pub mod key_value;
pub mod log;
pub mod metrics;
pub mod table;
pub mod tree;
