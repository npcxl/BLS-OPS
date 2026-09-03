//! 第三层专用解析器：只有复杂产品语义才放这里。
//!
//! Docker 的端口与状态、systemd 的服务状态、Nginx 的 server/location 关系、
//! Linux 里列不规范的 `ps`/`df`/`ss` —— 这些无法用通用解析稳定处理。
//! 输出仍然是统一协议，前端不感知。

pub mod docker;
pub mod linux;
pub mod nginx;
pub mod systemd;
