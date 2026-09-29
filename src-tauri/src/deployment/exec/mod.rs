//! P5.4 —— **执行器**：把类型化动作真正落到服务器上。
//!
//! # 只有一个出口
//!
//! 所有远程命令都由 [`crate::safe::Capability`] 构造（`remote::run_capability`），
//! 所有文件都由 SFTP 写（`SftpSession`）。本模块**不拼命令字符串**：动作的输入
//! 经过 [`crate::deployment::action::validate`] 与 `safe` 两道校验之后，才由能力
//! 层翻译成一条固定模板的命令。
//!
//! # 四类执行器的共同纪律
//!
//! 1. **顺序即安全**：`nginx -t` 通过才 reload；Nginx 配置先备份再写；
//!    域名没解析不发 HTTP-01 证书。这些顺序写在校验层与执行器两处，不是提示。
//! 2. **Secret 不进日志**：[`SecretScrubber`] 记下本次用到的密钥值，任何要写进
//!    日志的字符串都要先过它。快照里只存配置项的**名字与来源**。
//! 3. **失败留现场**：动作失败就返回错误，不擅自回滚。回滚是引擎的事，由人决定。
//! 4. **可取消**：长动作在每个阶段边界检查取消位（`ctx.cancelled()`）。

pub mod guidance;
pub mod render;
pub mod steps;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use crate::deployment::model::{EnvironmentKind, SecretRef, SecretStoreKind};
use crate::ssh::SshSessionManager;

use crate::deployment::action::model::DeploymentAction;

/// 执行环境（一次运行一个）。
pub struct ExecContext<'a> {
    pub ssh: &'a SshSessionManager,
    pub session_id: &'a str,
    pub environment_kind: EnvironmentKind,
    /// 密钥解析（生产走操作系统钥匙串；测试可换成假实现）。
    pub secrets: &'a dyn SecretResolver,
    /// 应用的密钥引用表（P5.0 `secret_refs`）——动作里只带 id，值在这里查。
    pub secret_refs: &'a [SecretRef],
    /// 本次运行里出现过的密钥值，用于日志脱敏。
    pub scrubber: &'a SecretScrubber,
    /// 协作式取消位（由运行注册表持有）。
    pub cancel: &'a AtomicBool,
    /// 已经脱敏的一行日志。
    pub log: &'a (dyn Fn(&str) + Send + Sync),
}

impl ExecContext<'_> {
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 取消检查：可取消的动作在每个阶段边界调用它。
    pub fn check_cancel(&self) -> Result<(), String> {
        if self.cancelled() {
            Err("操作已取消".to_string())
        } else {
            Ok(())
        }
    }

    /// 记一行日志（自动脱敏）。
    pub fn note(&self, message: impl AsRef<str>) {
        let line = self.scrubber.scrub(message.as_ref());
        (self.log)(&line);
    }

    /// 按 id 找密钥引用。找不到就是错误 —— 绝不"跳过这一项继续"。
    pub fn lookup_secret(&self, id: &str) -> Option<SecretRef> {
        self.secret_refs
            .iter()
            .find(|reference| reference.id == id)
            .cloned()
    }
}

/// 一次动作执行的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutcome {
    /// 人话摘要（写进运行节点，已脱敏）。
    pub summary: String,
    /// 是否需要人工确认（`RequireManualStep` 用）。
    pub needs_acknowledgement: bool,
}

impl ExecOutcome {
    pub fn done(summary: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            needs_acknowledgement: false,
        }
    }
}

/// 密钥解析。**只返回单个密钥的值，不做任何缓存**。
pub trait SecretResolver: Send + Sync {
    fn resolve(&self, reference: &SecretRef) -> Result<String, String>;
}

/// 生产实现：操作系统钥匙串（`keyring_account` 就是密钥 id）。
pub struct KeyringSecrets;

impl SecretResolver for KeyringSecrets {
    fn resolve(&self, reference: &SecretRef) -> Result<String, String> {
        match reference.store_kind {
            SecretStoreKind::Keyring => {
                let account = reference
                    .keyring_account
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| format!("密钥引用“{}”没有钥匙串账户名", reference.name))?;
                crate::keyring::read_secret(account)
                    .map_err(|error| format!("无法从钥匙串读取密钥“{}”：{error}", reference.name))
            }
            SecretStoreKind::RuntimeTempFile => Err(format!(
                "密钥“{}”是运行时临时文件类型：请在服务器上按约定路径放置，本工具不上传密钥文件",
                reference.name
            )),
        }
    }
}

/// 什么都不解析（测试与"没有配置密钥"的场景）。
pub struct NoSecrets;

impl SecretResolver for NoSecrets {
    fn resolve(&self, reference: &SecretRef) -> Result<String, String> {
        Err(format!(
            "未配置密钥解析器，无法解析密钥“{}”",
            reference.name
        ))
    }
}

/// 本次运行出现过的密钥值。
///
/// 存在的唯一目的是**日志脱敏**：密钥值一旦进入日志或快照就是事故，
/// 而执行器无法保证第三方工具不回显它（`certbot` 就会回显邮箱以外的信息）。
/// 这里把值记下来，任何出站文本都先过一遍。
#[derive(Default)]
pub struct SecretScrubber {
    values: Mutex<Vec<String>>,
}

impl SecretScrubber {
    /// 记下一个需要在日志里抹掉的值。太短的值不记 —— 那会把正常文本打成马赛克。
    pub fn remember(&self, value: &str) {
        if value.trim().len() < 6 {
            return;
        }
        if let Ok(mut values) = self.values.lock() {
            if !values.iter().any(|existing| existing == value) {
                values.push(value.to_string());
            }
        }
    }

    /// 把记录过的密钥值替换成 `***`。
    pub fn scrub(&self, text: &str) -> String {
        let values = match self.values.lock() {
            Ok(values) => values.clone(),
            Err(_) => return text.to_string(),
        };
        let mut out = text.to_string();
        for value in values {
            if !value.is_empty() && out.contains(&value) {
                out = out.replace(&value, "***");
            }
        }
        out
    }

    pub fn count(&self) -> usize {
        self.values.lock().map(|values| values.len()).unwrap_or(0)
    }
}

/// 执行一个动作。
pub async fn execute(
    action: &DeploymentAction,
    ctx: &ExecContext<'_>,
) -> Result<ExecOutcome, String> {
    ctx.check_cancel()?;
    steps::run(action, ctx).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scrubber_masks_recorded_values_only() {
        let scrubber = SecretScrubber::default();
        scrubber.remember("super-secret-token");
        // 太短的值不记：否则正常文本会被打成马赛克。
        scrubber.remember("abc");
        let scrubbed = scrubber.scrub("env: DATABASE_URL=super-secret-token abc");
        assert!(scrubbed.contains("***"), "{scrubbed}");
        assert!(!scrubbed.contains("super-secret-token"), "{scrubbed}");
        assert!(scrubbed.contains("abc"), "短值不该被抹掉：{scrubbed}");
        assert_eq!(scrubber.count(), 1);
    }

    #[test]
    fn the_scrubber_is_idempotent() {
        let scrubber = SecretScrubber::default();
        scrubber.remember("token-value-1234");
        scrubber.remember("token-value-1234");
        assert_eq!(scrubber.count(), 1);
        assert_eq!(scrubber.scrub("token-value-1234"), "***");
    }
}
