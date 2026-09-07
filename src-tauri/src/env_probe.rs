//! 服务器运行环境探测 —— **按真实环境生成命令建议**，而不是猜。
//!
//! 原来是一个 1392 行的文件，现在按职责拆成四个子模块（本文件只做组装与
//! re-export，**旧路径 `crate::env_probe::X` 全部保持不变**）：
//!
//! * [`model`] —— 数据结构 + 纯判定：镜像引用拆分、Nginx 家族识别、证据
//!   加权、环境分类（零 I/O、可单测）；
//! * [`commands`] —— 按环境生成命令建议（纯逻辑，零 I/O）；
//! * [`parse`] —— `docker ps --format '{{json .}}'` 解析；
//! * [`collect`] —— 走 `safe::Capability` 白名单 + `remote` 固定命令的只读
//!   采集（唯一有 I/O 的一层）。
//!
//! # 为什么不能 `contains("nginx")`
//!
//! 镜像名有仓库前缀与标签：`registry.internal:5000/team/nginx:1.25-alpine`、
//! `library/nginx`、`bitnami/nginx-ingress-controller`。直接对整个字符串
//! 做子串匹配会把 `my-nginx-logger`（一个日志采集器）也当成 Nginx。
//! 所以这里拆成 registry / repository / tag 三段，**只对 repository 的最后
//! 一段**做等值比较，再与容器名 token、Compose service label、容器内
//! 可执行文件三项证据加权合并。
//!
//! 全部判定都是"证据 → 结论"，没有任何针对固定服务器或固定容器名的规则。

mod collect;
mod commands;
mod model;
mod parse;
#[cfg(test)]
mod tests;

pub use collect::{classify_docker_error, probe_nginx_environment};
pub use commands::{container_commands, host_commands, nginx_commands};
pub use model::*;
pub use parse::{apply_binary_probe, parse_ps_json, select_nginx_candidates};
