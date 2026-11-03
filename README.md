# BLS-OPS

基于 Tauri + React + Rust 的桌面 SSH 运维工具，以 "SSH First" 为核心设计理念，主要面向 Windows。

## ✨ 核心功能

- **真实 SSH 终端**：xterm.js 交互式终端，支持密码 / 私钥 / 私钥+口令 / ProxyJump 双跳连接，断线检测与自动重连
- **服务器管理**：服务器 / 分组 / 标签 / 收藏、凭据管理（密钥只存系统 Keyring，永不回传前端）、Host Key 首连确认与指纹变更拦截
- **服务器监控**：CPU / 内存 / 磁盘 / 网络 / 进程实时指标，30 分钟趋势图，ProxyJump 下采集最终服务器，进程信息自动脱敏
- **服务管家**：systemd 服务列表与自启管理，启动 / 停止 / 重启 / 重载（带确认）
- **日志中心**：journald 按单元与优先级查询、结果内搜索、跟随最新
- **Docker 管家**：容器 / 镜像 / 资源占用，容器日志与常用操作
- **Nginx 管家**：站点配置编辑，**先 `nginx -t` 校验、通过才 reload**，失败给出备份路径
- **远程文件浏览器**：SFTP 双向操作，上传（文件选择器 + 拖拽）、重命名、删除、新建，跟随终端 `cd` 联动，文本文件在线编辑（语法高亮）
- **命令智能中心**：内置命令知识库 + 风险分级（只读直接执行，中风险二次确认），输出结构化渲染
- **增强终端**：原位命令补全、命令结果抽屉（快照 / 原始双视图）、参数选择器
- **项目与部署**：项目步骤编排、一键部署、实时日志流、部署历史回看
- **安全边界**：所有远程命令由 Rust 侧白名单模板生成，前端永不传命令字符串；CSP 已启用
- **多语言**：支持 10 种语言界面

## 📥 下载安装

前往 GitHub Releases 下载最新版本：

**https://github.com/npcxl/BLS-OPS/releases**

下载对应平台的安装包（如 `*.msi` / `*.exe`），双击安装即可。应用内置自动更新，无需手动升级。

## 🧪 开发与测试

```bash
# 前端：类型检查 + 构建 + 单测
pnpm build && pnpm test

# 后端：格式 + 编译 + 单元测试 + 本地集成测试（SQLite / monitor / SSH，无需实例）
cargo fmt --all -- --check
cargo check --all-targets
cargo test --lib
cargo test --test database_sqlite --test monitor_e2e --test p3_e2e --test ssh_e2e -- --test-threads=1

# 数据库集成测试：需要真实实例，一条命令复现 CI 的 database job
pnpm test:db                  # MySQL 8.0 @ 127.0.0.1:33306 + PostgreSQL @ 55432
pnpm test:db -- -Distribution mariadb --Port 33070
```

CI（`.github/workflows/ci.yml`）分三个 job：`backend`（格式/编译/单测/本地集成）、
`database`（矩阵：MySQL 8.0 与 MariaDB 11.4，各带一个 PostgreSQL 17）、`frontend`。
数据库用例在实例不可达时**失败**而不是跳过（`BLS_TEST_*_REQUIRED=1`）。
Redis 只在本地验证（Windows runner 没有稳定的 Redis 服务端），改 redis 相关代码请用
`docker run -p 6379:6379 redis:7` 后跑 `cargo test --test database_redis`。

新建连接列表只展示**已经接入驱动**的产品（MySQL、MariaDB、PostgreSQL、SQLite、Redis）。
TiDB / OceanBase / Doris / StarRocks / Aurora 保留产品身份与旧配置，但不作为一级入口；
SQL Server / MongoDB / Oracle / ClickHouse / CockroachDB 仍在开发计划中。

## 📄 许可证

MIT License
