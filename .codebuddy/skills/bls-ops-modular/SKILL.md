---
name: bls-ops-modular
description: BLS-OPS 新功能必须按模块写。新增 SSH/监控/项目发现/服务或网关等后端能力，或新增 Tauri 命令、大视图、命令表时，用此 skill 决定代码该落在哪个模块、如何拆文件、如何保持安全边界与可测试性。触发词：新增功能、加个命令、新模块、监控项、收集器、适配器、重构大文件。
---

# BLS-OPS 模块化写法

## 何时用

新增或修改以下内容时**必须**先读本 skill：

- 新的 Tauri 命令（`#[tauri::command]`）或 `opsApi` 方法
- 新的后端能力模块（监控项、部署收集器、部署适配器、探测命令）
- 新的前端视图/面板，或让某个 `.tsx` 超过约 400 行
- 任何在远程服务器上执行的命令

## 分层铁律（不可绕过）

```
前端 (WebView)                 只传结构化标识，永不传命令字符串
   ↓ opsApi (src/api/ops-api.ts)
Tauri 命令 (src-tauri/src/commands/<域>.rs)
   ↓ 只做参数校验 + 调用
领域模块 (monitor/ deployment_collector/ capability_probe/ …)
   ↓ 命令构造唯一入口
safe.rs Capability 枚举          唯一把「动作」翻译成命令字符串的地方
```

1. **命令字符串只能在 `src-tauri/src/safe.rs` 的 `Capability` 枚举里拼**。新动作 = 加变体 + 写死模板 + 加 `validate_*`。其他地方一律禁止 `format!("…{}…", 用户输入)`。
2. **校验必须在网络 I/O 之前**（`remote::run_on_linux` / `run_capability` 内部先 `capability.command()?`）。
3. **前端只传结构化标识**（session_id、unit 名、容器名、路径、项目 id），永不传 shell 字符串。
4. **禁止假状态与占位数字**：读不到就报错或标 `unsupported` / `null`，绝不返回 0、空数组或猜测值。

## 后端：新能力放哪里

| 需求 | 落点 |
|---|---|
| 新的 Tauri 命令 | `src-tauri/src/commands/<域>.rs`（已分：servers / credentials / known_hosts / sessions / ssh / sftp / monitor / app / services / containers / gateway / project / deployment） |
| 新的远程命令字符串 | `safe.rs` → `Capability` 新变体 + `command()` 模板 + `timeout()`（必要时） |
| 新的监控指标 | `src-tauri/src/monitor/model.rs`（命令常量 + 数据结构）→ `parse.rs`（纯函数解析）→ `collect.rs`（采集函数） |
| 新的部署方式收集器 | `src-tauri/src/deployment_collector.rs`（Docker/systemd/Nginx 等按能力启用） |
| 新的部署适配器 | `src-tauri/src/deployment_adapter.rs`（注册表 + 准备度评估） |
| 服务器能力探测 | `src-tauri/src/capability_probe.rs` |

已目录化的大模块（参照实现）：`commands/`（原 2604 行）、`monitor/`（原 1351 行）、`ssh/`（原 1662 行）、`safe/`（原 1267 行）、`db/`（原 1465 行）、`deployment_collector/`（原 831 行）。**当前已无超过 700 行的 Rust 文件。**

### 模块内怎么拆（超过约 600 行就拆）

**按职责切，而不是按行数平均切。** 已有三种套路，按模块性质选：

1. **数据/采集型**（`monitor/`）：`model`（命令表常量 + 数据结构）→ `parse`（纯函数，零 I/O，可单测）→ `exec`（执行、退出码、并发）→ `collect`（对外函数）→ `registry`（状态缓存）→ `tests`
2. **协议/传输型**（`ssh/`）：`model`（数据结构 + 常量）→ `paths`（纯字符串/路径工具）→ `host_key`（纯判定逻辑）→ `session`（单连接状态 + 超时原语）→ `handshake`（握手/认证/隧道）→ `sftp`（子系统的全部操作，`impl` 块可与类型定义分离，同 crate 内允许）→ `manager`（注册表/门面）→ `tests`
3. **枚举/规则表型**（`safe/`）：`capability`（枚举 + 唯一的命令模板 `match`）→ `validate`（校验器 + 引用器）→ `deploy`（部署步骤白名单校验）→ `tests`
4. **按实体/策略切**（`db/` 按表：schema/model/servers/credentials/known_hosts/sessions/history/audit/projects；`deployment_collector/` 按收集器：model/docker/systemd/nginx）

**关键（适用于以上所有）**：父模块只放模块文档、`mod` 声明和 `pub use` re-export，把内部项 re-export 到模块根，这样 `crate::ssh::xxx`、`crate::db::xxx` 等既有路径一个都不用改，调用方与 e2e 测试零修改。

**拆目录的硬性注意**：
- **`foo.rs` 与 `foo/mod.rs` 不能并存（E0761）**。项目统一用 `foo.rs` 作父模块 + `foo/` 存子模块（即 `commands.rs` + `commands/`，`db.rs` + `db/`，`ssh.rs` + `ssh/`…），这样拆分只需覆盖父文件、无需删文件。
- 仅测试用的内部项用 `#[cfg(test)] pub(crate) use` 导出，否则非测试构建报 unused。
- 子模块互相引用的类型/函数需显式 `use super::xxx::Yyy`。

## 前端：新功能放哪里

| 需求 | 落点 |
|---|---|
| 领域类型 | `src/api/types/<域>.ts`（servers/sessions/ssh/sftp/monitor/services/containers/gateway/project），经 `ops-api.ts` re-export |
| 格式化工具 | `src/lib/format.ts`（已有 formatBytes/formatSpeed/formatUptime/formatSize/formatTime/formatCount） |
| Tauri 事件名 | `src/lib/events.ts`（唯一来源，与 Rust 侧 emit 一致） |
| 新视图/面板 | `src/workbench/views/<域>/` 目录：容器 + 子组件 + `utils.ts` + 必要的 hook |
| 可复用逻辑 | `src/hooks/use-<用途>.ts` 或视图目录内 `use-*.ts` |

视图超过约 400 行就目录化：容器组件 + 子组件 + 纯逻辑/hook。**列表行必须 `memo` 化**，回调引用用 ref 保持稳定。

## 安全自检（写完必查）

- [ ] 任何新命令字符串都在 `safe.rs` 里？
- [ ] 用户/服务器提供的路径过了 `validate_abs_path` / `validate_remote_paths`？
- [ ] 敏感信息是否被序列化出去？例：`ps` 必须用 `comm`（可执行名），**绝不能用 `args`**（命令行含密码/token/数据库 URL）；解析时只取第一个 token
- [ ] 非 Linux / 不支持的场景返回了 `supported:false` + 原因，而不是零值？
- [ ] 会改服务端状态的操作，前端有 `ConfirmDialog`？Nginx 是先 `nginx -t` 再 reload？
- [ ] 速率类指标（CPU%、网速）是两次采样差值，首次采集额外隔 ~200ms 再读一次？

## 验证（每步必跑，不可跳过）

```bash
cd src-tauri && cargo fmt --all -- --check
cd src-tauri && cargo test --all-targets      # 期望 168 单元 + 17 + 25 + 27 e2e 全绿
pnpm build                                     # tsc + vite
pnpm test                                      # vitest
```

新增纯解析函数 → 在 `tests.rs` 里用**固定样本**断言（含边界：空输入、超长设备名、缺失字段、非 Linux）。

## 反模式（禁止）

- 在 `commands/*.rs` 里直接拼命令字符串或写业务逻辑
- 让某个文件继续膨胀而不拆（`commands.rs` 曾到 2604 行，`monitor.rs` 曾到 1351 行）
- 复制粘贴格式化函数、事件名字符串
- 为“全支持”而猜测能力：未安装 = 不执行其命令，未确认 = `unconfirmed`
- 用 `window.confirm` 替代 `ConfirmDialog`
