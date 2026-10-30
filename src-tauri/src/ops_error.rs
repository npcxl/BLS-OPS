//! 统一的命令错误类型。
//!
//! # 为什么需要它
//!
//! 数据库命令早就有结构化的 `DbErrorInfo`（stage / code / detail），前端据此
//! 显示「阶段标签 + 恢复建议 + 详情 + 复制」。但 SSH / SFTP / systemd / Docker /
//! Nginx / 日志这些命令一直返回 `Result<_, String>`：一条被压平的字符串，前端
//! 只能整段甩到界面上一行 11px 的红字里 —— 长 stderr 直接溢出面板，用户也看不出
//! 到底卡在哪一步。
//!
//! 这里把同样的形状推广到所有命令：
//!
//! ```json
//! { "stage": "sftp", "message": "读取失败", "detail": "…", "code": null, "retryable": false }
//! ```
//!
//! 前端 `toAppError()` 已经能直接吃这个形状，不需要再改一行前端代码。
//!
//! # 阶段与"恢复建议"的对应关系
//!
//! `stage` 是前端 `STAGE_HINTS` 的键，决定"我该怎么办"那一行：
//! `auth` / `permission` / `timeout` / `ssh` / `sftp` / `systemd` / `docker` /
//! `nginx` / `journal` / `project` / `deploy` / `cancelled`。
//! 传不认识的阶段不会报错，只是没有恢复建议。

use std::fmt;

use serde::Serialize;

/// 面向用户的命令错误。序列化后直接就是前端 `toAppError` 的输入。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OpsError {
    /// 失败阶段（决定前端展示的标签与恢复建议）。`None` = 没有更细的信息。
    pub stage: Option<String>,
    /// 一行摘要：必须能在 11px 的一行里读完。
    pub message: String,
    /// 详情：后端原文、stderr、多行堆栈。前端默认折叠。
    pub detail: Option<String>,
    /// 引擎错误码（如果有）。
    pub code: Option<String>,
    /// 原样重试是否可能成功。写操作一律 false —— 别鼓励用户盲目重放。
    pub retryable: bool,
}

/// 摘要上限：超过就不是"一行"了，多出来的部分放详情。
const MAX_SUMMARY: usize = 240;

impl OpsError {
    /// 带阶段的错误。
    pub fn new(stage: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            stage: Some(stage.into()),
            message: clip_one_line(&message.into()),
            detail: None,
            code: None,
            retryable: false,
        }
    }

    /// 没有阶段归属的错误（纯本地校验、参数不合法等）。
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            stage: None,
            message: clip_one_line(&message.into()),
            detail: None,
            code: None,
            retryable: false,
        }
    }

    /// 把底层错误（通常是 `Result<_, String>` 的领域层错误）提升成带阶段的错误。
    ///
    /// 多行原文会**拆开**：首行进 `message`，其余进 `detail`。这样 `systemctl`
    /// 的整段 stderr 不会再被压成一行挤爆界面，也一个字都不丢（复制仍然拿全）。
    pub fn from_stage(stage: impl Into<String>, error: impl ToString) -> Self {
        let raw = error.to_string();
        let stage = stage.into();
        let mut lines = raw.lines();
        let first = lines.next().unwrap_or_default().trim().to_string();
        let rest = lines.map(str::trim_end).collect::<Vec<_>>().join("\n");
        let rest = rest.trim().to_string();
        Self {
            stage: Some(stage),
            message: clip_one_line(if first.is_empty() { &raw } else { &first }),
            detail: if rest.is_empty() { None } else { Some(rest) },
            code: None,
            retryable: false,
        }
    }

    /// 补上阶段，但**不覆盖**已有的阶段（内层已经知道更细的归属时听内层的）。
    pub fn ensure_stage(mut self, stage: impl Into<String>) -> Self {
        if self.stage.is_none() {
            self.stage = Some(stage.into());
        }
        self
    }

    /// 标记这次失败重试有意义（只读操作才该标 true）。
    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    /// 补充详情（详情已存在时追加）。
    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        let detail = detail.into();
        let trimmed = detail.trim();
        if trimmed.is_empty() {
            return self;
        }
        self.detail = Some(match self.detail {
            Some(existing) => format!("{existing}\n{trimmed}"),
            None => trimmed.to_string(),
        });
        self
    }

    /// 补充错误码。
    pub fn with_code(mut self, code: impl Into<String>) -> Self {
        self.code = Some(code.into());
        self
    }
}

impl fmt::Display for OpsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OpsError {}

/// 把一段原始文本压成"一行摘要"：折叠换行与连续空白，过长则截断。
fn clip_one_line(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_SUMMARY {
        return collapsed;
    }
    let clipped: String = collapsed.chars().take(MAX_SUMMARY).collect();
    format!("{clipped}…")
}

impl From<String> for OpsError {
    fn from(value: String) -> Self {
        Self::plain(value)
    }
}

impl From<&str> for OpsError {
    fn from(value: &str) -> Self {
        Self::plain(value)
    }
}

impl From<std::io::Error> for OpsError {
    fn from(value: std::io::Error) -> Self {
        Self::new("io", value.to_string())
    }
}

/// 命令层统一返回类型。
pub type OpsResult<T> = Result<T, OpsError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiline_splits_into_summary_and_detail() {
        let error = OpsError::from_stage(
            "systemd",
            "Job for nginx.service failed\n● nginx.service - A high performance web server\n   Active: failed",
        );
        assert_eq!(error.stage.as_deref(), Some("systemd"));
        assert_eq!(error.message, "Job for nginx.service failed");
        let detail = error.detail.expect("详情应保留");
        assert!(detail.contains("Active: failed"));
    }

    #[test]
    fn long_single_line_is_clipped_but_keeps_prefix() {
        let raw = "x".repeat(MAX_SUMMARY + 50);
        let error = OpsError::plain(raw);
        assert!(error.message.ends_with('…'));
        assert_eq!(error.message.chars().count(), MAX_SUMMARY + 1);
    }

    #[test]
    fn whitespace_collapses_to_one_line() {
        let error = OpsError::plain("connect   failed\n\nretry later");
        assert_eq!(error.message, "connect failed retry later");
    }

    #[test]
    fn string_error_has_no_stage() {
        let error = OpsError::from("boom".to_string());
        assert!(error.stage.is_none());
        assert_eq!(error.message, "boom");
        assert!(!error.retryable);
    }

    #[test]
    fn serializes_to_frontend_shape() {
        let json = serde_json::to_value(OpsError::new("sftp", "读取失败").retryable()).unwrap();
        assert_eq!(json["stage"], "sftp");
        assert_eq!(json["message"], "读取失败");
        assert_eq!(json["retryable"], true);
        assert!(json["detail"].is_null());
    }
}
