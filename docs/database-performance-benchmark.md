# 数据库性能与稳定性基准（2026-10-29）

## 已可重复运行

```powershell
# 1) 20 万行批次合并（纯前端，不需要数据库）
node scripts/bench-row-merge.mjs

# 2) 真实 MySQL：100 万行 keyset 分页、查询取消、DDL
powershell -File scripts/bench-db-mysql.ps1
```

浏览器内查看查询批次采样：

```js
window.__blsDbPerf.summary()
```

只保留最近 500 个批次，不触发 React 渲染。设置
`localStorage["ops.db.debugBatchPerf"]="1"` 可额外打印超过 100ms 的 IPC。

## 已记录数据

运行环境：Windows，MySQL 8.0.46，Docker 本地回环。

| 场景 | 数据 |
|---|---:|
| 批次合并，20 万行 / 1000 行一批（旧 concat） | 49.92 ms |
| 批次合并，20 万行 / 1000 行一批（新 push） | 1.58 ms |
| 100 万行 COUNT(*) | 24 ms |
| 100 万行 keyset 第 1 页 200 行 | 2 ms |
| 100 万行 keyset 第 2 页 200 行 | 2 ms |
| 插入 80 万行 | 3596 ms |

## 尚未自动化

- 1 / 10 / 100 个工作项的内存与重渲染；
- 100 列宽表滚动；
- 100 MB / 1 GB CSV 导出；
- 高延迟 SSH 隧道；
- 连续运行后的连接数/内存曲线。

这些场景需要浏览器 Profiler、可控网络延迟和长期运行环境；在补齐前不宣称已达标。
