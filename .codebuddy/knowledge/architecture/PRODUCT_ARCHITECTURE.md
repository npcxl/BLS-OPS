# 产品与后端架构（摘要）

> 状态：**现行摘要**，对照代码日期 2026-11-20。
> 完整现状见 `ARCHITECTURE.md`；代码落点见 `MODULE_MAP.md`；安全边界见 `../guides/SECURITY.md`。

---

## 定位

BLS-OPS（产品名 Ops Workbench）是 Windows 优先的本地 SSH 运维工作台：连上服务器之后，终端、监控、服务、文件、数据库在同一个窗口里完成，不需要在目标机安装 Agent。

技术栈：Tauri 2 + Rust（原生能力）+ React 19 + TypeScript（界面）+ SQLite（配置与历史）+ 系统钥匙串（密钥）。

---

## 分层

| 层 | 职责 | 入口 |
|---|---|---|
| React UI | 导航、标签/分屏、终端呈现、交互状态 | `src/workbench/` |
| 前端 API | 唯一 IPC 封装，组件不直接 `invoke` | `src/api/ops-api.ts` |
| Tauri Commands | 参数校验 + 编排，不拼命令、不写业务 | `src-tauri/src/commands/` |
| 领域服务 | SSH、监控、数据库、部署、Agent、Docker/Nginx/systemd… | `src-tauri/src/<域>/` |
| 安全边界 | 所有远程命令模板与参数校验 | `src-tauri/src/safe/` |
| 持久化 | SQLite（元数据/历史/模型）+ 钥匙串（密码/私钥/API Key） | `src-tauri/src/db/`、`keyring.rs` |

---

## 实施原则（仍然是硬约束）

1. 先有真实连接与真实数据，再做上层功能；UI 的占位状态不得伪装成"已连接/已实现"。
2. SSH 连接、Host Key 校验、终端流式输出优先于 Docker、Nginx、部署与 AI。
3. 前端只传结构化标识；远程命令字符串只能在 `safe::Capability` 生成；校验在网络 I/O 之前。
4. 未实现就返回 `unsupported` + 原因，读不到就返回 `null`，绝不返回 0 / 空数组冒充成功。
5. 破坏性操作必须确认（`ConfirmDialog`），能先校验的先校验（`nginx -t` 再 reload）。
6. AI 不进入执行路径：只能推荐/批注，执行必须经 Rust 引擎、能力校验、风险校验、工作流引擎与审计。
7. 凭据只进钥匙串；Host Key 首连与变更必须人工确认。

---

## 相关文档

- 现状架构：`ARCHITECTURE.md`
- 代码地图：`MODULE_MAP.md`
- 开发与发布：`../guides/DEVELOPMENT.md`
- 安全模型：`../guides/SECURITY.md`
- 产品愿景（早期 v2 设计，不是现状）：根目录 `rust-react-devops-architecture-v2.md`
