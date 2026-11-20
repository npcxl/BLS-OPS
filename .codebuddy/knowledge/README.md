# BLS-OPS 项目知识库

> 位置：`.codebuddy/knowledge/`（随仓库提交）。
> 最后核对：2026-11-20，对应代码 v0.1.30。
> 事实优先级：**代码 > `architecture/`、`guides/`、`features/` > `design/` > `history/`**。
> 文档与代码冲突时以代码为准，并回头修文档。

---

## 1. 目录作用

| 目录 | 作用 | 什么时候读 | 可信度 |
|---|---|---|---|
| `architecture/` | 系统**现在**怎么跑：多窗口、启动链、分层、数据归属、模块地图 | 接手项目、评审改动、判断代码该放哪 | 现行（as-built） |
| `guides/` | 跨功能的操作规范：开发/验证/发布、安全边界、UI 约定、i18n | 日常开发、提交前自查 | 现行 |
| `features/` | 单个功能域的现状与不变式（终端、数据库） | 改该功能之前 | 现行 |
| `design/` | 分阶段设计与验收标准（P5.0–P5.6、更新链路） | 理解"为什么这样设计"、验收 | 设计：区分已实现/未实现 |
| `history/` | 审计、实施计划、性能基准、验收记录的快照 | 只用于追溯 | 历史：不要当现状 |

**为什么不混在一起**：设计文档写的是目标，历史文档写的是当时的结论，两者都不等于现在的代码。混放会让后来者把"计划"当成"已实现"、把"审计时的缺口"当成"现在的缺口"。

---

## 2. 全量索引

### architecture/ — 系统现状

| 文档 | 作用 |
|---|---|
| `architecture/ARCHITECTURE.md` | 运行形态、多窗口、启动链、分层与三条唯一入口、数据归属、核心链路、架构债 |
| `architecture/MODULE_MAP.md` | 前后端目录地图、36 个命令域、新功能落点、拆分规则、测试位置、反模式 |
| `architecture/PRODUCT_ARCHITECTURE.md` | 产品定位与分层摘要（详细内容在 ARCHITECTURE） |

### guides/ — 操作规范

| 文档 | 作用 |
|---|---|
| `guides/DEVELOPMENT.md` | 环境、开发、验证矩阵、数据库容器、格式化、版本与发布、排障、CI |
| `guides/SECURITY.md` | 威胁模型、命令边界、凭据、Host Key、CSP、路径、制品导入、部署/AI、Agent、自查清单 |
| `guides/UI_TECHNICAL_SPEC.md` | 组件边界、设计令牌、浮层/弹窗、右键菜单、i18n、桌面级窗口 |
| `guides/i18n.md` | 两语言策略、natural keys、目录结构、动态 key 断言、红线 |
| `guides/p5.1-updater.md` | 自动更新链路、签名、发布步骤、真机验收、排障 |

### features/ — 单功能现状

| 文档 | 作用 |
|---|---|
| `features/TERMINAL.md` | 终端组成、连接生命周期、输出链路、OSC 133 命令边界、cwd、补全状态机、命令块、提示符 |
| `features/database-workbench.md` | 5 个引擎、能力矩阵、分层、安全、缺口、新增引擎步骤、测试 |

### design/ — 设计与验收标准

| 文档 | 作用 |
|---|---|
| `design/P5_DEPLOYMENT_CENTER_DESIGN.md` | P5 总设计与安全模型（P5.0 底座 / P5.1 制品导入） |
| `design/p5.1-artifact-import.md` | 制品导入：输入、流程、IPC、上限、测试 |
| `design/p5.2-proposal-engine.md` | 方案生成：规则引擎、知识库、AI 边界、可复现 |
| `design/p5.3-p5.4-workflow-engine.md` | 类型化 Workflow 执行与 Docker/Nginx/DNS/SSL |
| `design/p5.5-ai-knowledge.md` | AI 提供方、Keyring 策略、知识库、AI 复核 |
| `design/p5.6-ai-deployment-session.md` | 统一部署会话、用户 Memory、状态机 |

### history/ — 历史快照（不要当现状）

| 文档 | 日期 | 作用 |
|---|---|---|
| `history/p4-acceptance.md` | 2026-09-07 | P4 命令中心验收记录 |
| `history/database-navicat-gap.md` | 2026-10-28 | Navicat 能力差距审计；多引擎改造前的结论 |
| `history/database-implementation-plan.md` | 2026-10-28 | 当时的实施计划与 P0 缺陷清单 |
| `history/database-performance-benchmark.md` | 2026-10-29 | 性能基准数字 |

---

## 3. 推荐阅读路径

| 目标 | 顺序 |
|---|---|
| 第一次接手 | `architecture/ARCHITECTURE.md` → `architecture/MODULE_MAP.md` → `guides/DEVELOPMENT.md` |
| 加一个远程操作 | `guides/SECURITY.md` → `architecture/MODULE_MAP.md` §4 → `.codebuddy/skills/bls-ops-modular/SKILL.md` |
| 改终端 | `features/TERMINAL.md` → `architecture/ARCHITECTURE.md` §5 |
| 改数据库 | `features/database-workbench.md`（历史审计只作追溯） |
| 改部署 / AI | `design/p5.2` → `p5.3-p5.4` → `p5.5` → `p5.6`，再读 `guides/SECURITY.md` §8 |
| 发版 | `guides/DEVELOPMENT.md` §5 → `guides/p5.1-updater.md` |

---

## 4. 文档作用与状态标记

| 标记 | 含义 | 维护要求 |
|---|---|---|
| **现行** | 与当前代码一致 | 改行为必须同步改 |
| **设计** | 目标、约束、分阶段实现 | 必须保留"已实现 / 未实现 / 已知缺口"边界 |
| **历史** | 某次审计/计划/验收的快照 | 开头标日期与结论，正文不改写 |

---

## 5. 维护规则

1. **改行为就改文档**：至少检查 `architecture/ARCHITECTURE.md`（链路/数据）、`architecture/MODULE_MAP.md`（落点）与对应功能文档。
2. **不写会漂移的数字**，或标注"截至某日"。命令数、行数、测试数、表数量都会变。
3. **设计文档必须留边界**：明确写"已实现 / 未实现 / 已知缺口"，不许用将来时冒充完成。
4. **历史文档只加不改**：在开头补"历史快照（日期）+ 现状看哪篇"。
5. **不把 `.codebuddy/memory/` 的内容复制成文档**：那里是跨会话的决策与事故记录；文档写"系统怎么工作"，记忆写"为什么这么做、踩过什么坑"。
6. 新增文档要回本索引登记，并标注所属目录与状态。

---

## 6. 未纳入本目录的内容

- 仓库根目录 `README.md`：对外产品介绍，面向 GitHub 访客。
- 根目录早期设计文档：产品愿景，不是当前实现。
- `提示词-*.md`、`fix-*.mjs`、`*-test.json` 等：某次任务的需求草稿与临时文件，不属于项目知识库。
