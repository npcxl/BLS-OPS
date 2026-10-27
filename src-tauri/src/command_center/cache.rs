//! 命令检索的**上下文快照**（收藏 + 使用统计）。
//!
//! # 为什么需要它
//!
//! `command_search` 以前每次按键都 `open_db` + 查两张表（收藏、全部使用统计）。
//! 这两份数据变化很少（用户点星标 / 执行命令时），却出现在**输入热路径**上。
//! 现在只在第一次检索时加载，变化时显式失效。
//!
//! # 失效规则
//!
//! 收藏切换、记录一次使用、清空历史 —— 这三个命令写完库后调用
//! [`CommandSearchCache::invalidate`]。除此之外不需要失效：检索只读这两份数据。
//!
//! 缓存的是 `Arc`，所以并发检索不会各自持有一份拷贝。

use std::sync::{Arc, Mutex};

use super::search::SearchContext;

/// `Clone` 是必须的：`AppState` 本身可克隆，缓存要跟着共享同一份快照。
#[derive(Default, Clone)]
pub struct CommandSearchCache {
    inner: Arc<Mutex<Option<Arc<SearchContext>>>>,
}

impl CommandSearchCache {
    /// 取快照；**只有缓存未命中时才调用 `load`**。
    ///
    /// 这一点很关键：旧签名要求调用方先拿到 `Connection`，于是即使缓存命中，
    /// 输入热路径上仍然会 `open_db()` —— 省了查表，没省建连接。
    pub fn get_or_try_load<F>(&self, load: F) -> Result<Arc<SearchContext>, String>
    where
        F: FnOnce() -> Result<SearchContext, String>,
    {
        let mut guard = self.inner.lock().unwrap();
        if let Some(context) = guard.as_ref() {
            return Ok(Arc::clone(context));
        }
        let context = Arc::new(load()?);
        *guard = Some(Arc::clone(&context));
        Ok(context)
    }

    /// 收藏 / 使用记录变化后调用；下一次检索会重新加载。
    pub fn invalidate(&self) {
        *self.inner.lock().unwrap() = None;
    }
}
