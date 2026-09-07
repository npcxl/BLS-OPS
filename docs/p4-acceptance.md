# P4 验收与收口

> P4 = **命令智能中心 + 增强终端**。本文记录 P4 的范围、已完成项、本轮收口的六项改动、
> 明确移出的子项，以及真实服务器验收清单。

## 一、P4 范围与完成项

| 子项 | 内容 | 状态 |
|------|------|------|
| P4.0 | 安全基座：前端只传 `knowledgeId` + 结构化 params，`ExecKind → build_exec → capability()` 唯一翻译点 | ✅ |
| P4.1 | 内置命令知识库（编译期常量，110 条；高风险/删除类不收录） | ✅ |
| P4.2 | 终端输入实时提示（与命令中心同一条检索链路） + 二级参数选择器（占位符绝不进 shell） | ✅ |
| P4.3 | 统一输出适配引擎（`output_adapter/`）+ 前端按 view 分发的渲染器（`views/command-result/`） | ✅ |
| P4.3.1 | 容器行详情 | ✅ |
| P4.3.2 | 服务器上下文加权（工具探测置灰）+ systemd/journal/nginx/ps/df/ss 适配器 | ✅ |
| P4.4 | **软删除（危险命令治理）：软删执行 / 删除记录 / 可恢复列表 / 永久删除 / 删除回滚** | ⛔ **明确移出 P4**（见第三节） |
| P4.5 | 部署工作流 | ⏭ 并入 P5 系统基础部署流程 |
| P4.6 | AI 能力 | ⏸ 继续占位 |

## 二、本轮收口六项

1. **增强终端首次默认开启** —— `bls-ops.terminal.enhanced` 由「默认关」改为「默认开」：
   只有用户**主动关过**（`localStorage === "0"`）才保持关闭，读不到 localStorage 也按开启处理。
   原因：默认关会让新用户看不到结果 Tab / JSON Tab，表现为"功能写了但界面没反应"。
2. **docker info 普通文本说明 + JSON 版本建议** —— 知识库 `docker.info` 条目说明改为
   "普通文本、按 `[Section]` 分块、适合人读"；新增 `docker.info.json`
   （`docker info --format '{{json .}}'`，走 `json-viewer` 适配器），说明里明确
   "字段完整、可复制进脚本；人读请用普通文本版"，并给 `docker info json` 等别名便于检索。
3. **P4.4 软删除明确移出 P4** —— 见第三节。
4. **Windows 真实验收** —— 见第四节（含需要人工在真机上执行的清单）。
5. **清理临时文件 + 更新 README** —— 删除 `build_out.txt` / `vitest-out.txt` /
   `scripts/tmp-check-i18n-keys.cjs` / `scripts/tmp-i18n-index.mjs` / `.codebuddy/teams/`
   历史团队记录，`.gitignore` 增加 `*_out.txt`、`scripts/tmp-*`、`*.tmp-*` 防复发；
   README 进度表与实际代码对齐（P2/P3/P4 真实状态）。
6. **拆分巨型文件** ——
   - `TerminalView.tsx` **1785 → 1084 行**，拆出 `views/terminal/` 下 8 个模块：
     `terminal-preferences.ts`、`terminal-phase.ts`、`use-terminal-session.ts`
     （xterm 生命周期大 effect）、`use-ssh-keepalive.ts`、`use-terminal-search.ts`、
     `use-terminal-results.ts`（结果面板状态 + 唯一提交入口）、
     `terminal-toolbar.tsx`、`terminal-error-banner.tsx`、`use-terminal-menu.ts`。
   - `src-tauri/src/env_probe.rs` **1392 行** → 父模块（docs + `mod` + re-export，
     **对外路径 `crate::env_probe::X` 不变**）+ `env_probe/{model,commands,parse,
     collect,tests}.rs`（396 / 257 / 192 / 125 / 415 行）。

## 三、P4.4 软删除：明确移出 P4

**结论：软删除不属于 P4，移出到独立的「删除治理」阶段（排在 P5 系统基础部署流程之后）。**

### 现状（安全侧没有缺口）

- 知识库第一批**不收录任何 `Mutability::Delete` 条目**（`docker rm` / `rmi` /
  `system prune` / `volume rm` 全部不入库），因此不存在"从知识库一键删除"的后门。
- `TerminalView` 的重运行门控对 `mutability === "delete"` 直接 return，不提供重运行。
- 补全与建议面板不生成删除类命令。
- 也就是说：**删除能力现在没有任何入口**，移出不会留下半成品或绕过风险。

### 为什么不在 P4 内做

软删除是一套**独立的持久化与审计子系统**，至少包含 5 块：

1. 软删除执行（把"真删除"替换为"标记 + 保留原始数据"的安全动作）；
2. 删除记录（谁、什么时候、删了什么、原始数据快照）；
3. 可恢复列表（按服务器/时间/类型检索）；
4. 最终永久删除（二次确认 + 记录不可恢复）；
5. 删除回滚（把原始数据恢复回去，并留审计）。

它需要的不是"再写几个命令"，而是新的表结构 + 迁移 + 审计 + UI + 端到端测试，
且必须与"禁伪造状态""破坏性操作一律 ConfirmDialog""raw 永久保留"等既有铁律对齐。
把它塞进 P4 收口，只会让 P4 与 P5 都做不干净。

### 移出后的要求

- 在它完成之前，代码里**不允许**出现"假删除"（假装删除成功、只改前端状态）；
- `safe.rs` 继续保持"删除类命令不入第一批"；
- 该阶段开工时以本文第三节的需求清单为验收基线。

## 四、真实验收

### 4.1 本机（Windows）命令

```bash
cargo fmt --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
pnpm tauri build          # 发布构建
```

> 结果记录在本文件末尾的「验收记录」。

### 4.2 真实 SSH 服务器（必须人工执行）

以下场景自动化测试覆盖不到（涉及真实发行版、真实 Docker、真实中文环境），
需要在真机上逐条验证并在下方签字：

| # | 场景 | 期望 |
|---|------|------|
| 1 | `cd o` + Tab/Enter | 补成 `cd opt/`，再按 Enter 才执行；第二次 Enter 不被建议面板吞掉 |
| 2 | `cd /var/` | 目录补全过程不读本地 FS，只走 `sftpListDir` |
| 3 | `nginx` | 建议面板给出 nginx 相关命令；多容器时先选容器 |
| 4 | 多个 Nginx 容器 | 必须弹出容器选择，选中后才生成命令（不猜） |
| 5 | `docker info` | 结果抽屉出现 key_value 分块；说明里能看到"普通文本"与 JSON 版建议 |
| 6 | `docker info --format '{{json .}}'` | 结果抽屉出现 JSON Tab（整段合法才出 Tab） |
| 7 | `docker inspect bls-nginx` | JSON Tab 正常，容器不存在时报错可见 |
| 8 | 中文路径与中文输出 | 不出现 `�`（跨块 UTF-8 解码）；文件名/目录补全正常 |
| 9 | 断线重连后的缓存失效 | 重连后目录 / Docker / 服务 / 进程 / 环境缓存全部重探，不复用旧数据 |
| 10 | 增强终端 | 首次启动默认开启（除非之前手动关过），结果抽屉随命令结果自动出现 |

## 五、验收记录

| 项目 | 命令 | 结果 |
|------|------|------|
| Rust 格式 | `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check` | ✅ 通过（顺带修掉了 `editor_sync/` 与 `ssh/mod.rs` 的历史格式漂移） |
| Rust 编译 | `cargo check --all-targets` | ✅ 0 error |
| Rust 测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | ✅ 349 单元 + 19 监控 e2e + 25 P3 e2e + 27 SSH e2e 全绿 |
| 前端测试 | `pnpm test` | ✅ 626 / 627（唯一失败来自并行开发中的 `updater` 分支，与 P4 无关） |
| 前端类型 + 打包 | `pnpm build`（`tsc && vite build`） | ✅ 通过 |
| 桌面构建 | `pnpm tauri build` | ✅ 产物已出：`ops-workbench.exe` + `msi/...msi` 9.3MB + `nsis/...setup.exe` 6.4MB。最后一步报 `TAURI_SIGNING_PRIVATE_KEY` 缺失 —— 是并行分支新增的 updater 签名配置，与 P4 无关（设好签名密钥即消失） |

### 真实 SSH 人工验收

⚠️ **必须人工执行**：第 4.2 节那张表涉及真实发行版、真实 Docker、真实
中文环境，进程内 e2e 覆盖不到，需要在真机逐条走一遍。
