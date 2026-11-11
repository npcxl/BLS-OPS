<div align="center">

<h1>Ops Workbench</h1>

### BLS-OPS

**SSH 优雅的桌面运维工作台** —— 连上服务器之后，终端、监控、服务、文件、数据库都在同一个窗口里。

**An SSH-first desktop operations workbench** — terminal, monitoring, services, files and databases in one window.

[官网 Website](https://ops.xlcig.cn) ·
[下载 Download](https://github.com/npcxl/BLS-OPS/releases) ·
[MIT](LICENSE)

</div>

---

## 中文

基于 Tauri 2 + React + Rust，主要面向 Windows：安装包不到 15 MB，不需要额外装运行时。

**能做什么**

- **真实 SSH 终端**：xterm.js，支持密码 / 私钥 / 私钥加口令 / ProxyJump 双跳，断线重连；原位命令补全（300+ 常用命令，拼错一步也能纠）。
- **服务器监控**：CPU / 内存 / 磁盘 / 网络 / 负载 / 进程 / NVIDIA GPU，30 分钟趋势，明细可下钻。
- **服务与日志**：systemd 服务启停与自启管理；journald 按单元、级别查询并跟随。
- **远程文件**：SFTP 上传（含拖拽）、重命名、删除、在线编辑，跟随终端 `cd`。
- **数据库工作台**：MySQL / MariaDB / PostgreSQL / SQLite / Redis；查询分页、结果可直接改行、导出 CSV、结构编辑。
- **命令智能中心**：内置知识库 + 风险分级，只读命令直接跑，中风险二次确认。
- **部署**：项目步骤编排、一键执行、实时日志、历史回看。
- **安全**：远程命令由 Rust 侧白名单模板生成，前端不传命令字符串；凭据只存系统 Keyring；首次连接校验 Host Key；CSP 默认开启。

**安装**

到 [Releases](https://github.com/npcxl/BLS-OPS/releases) 下载 `*.exe` 或 `*.msi` 双击安装即可，应用内置自动更新。
也可以从官网 [ops.xlcig.cn](https://ops.xlcig.cn) 进入下载页。

**开发**

```bash
pnpm install
pnpm tauri dev          # 前端热更 + Rust 增量编译
pnpm build && pnpm test # 类型检查 / 构建 / 单测
cargo test --lib --manifest-path src-tauri/Cargo.toml
```

CI 见 `.github/workflows/ci.yml`（frontend / backend / database 三个 job），发布由 tag 触发 `.github/workflows/release.yml`。

---

## English

Built on Tauri 2 + React + Rust, Windows-first: the installer is under 15 MB and needs no separate runtime.

**What it does**

- **Real SSH terminal** — xterm.js, password / private key / key + passphrase / ProxyJump, auto-reconnect, inline completion for 300+ commands with one-edit typo correction.
- **Server monitoring** — CPU, memory, disk, network, load, processes and NVIDIA GPUs with 30-minute trends and drill-down tables.
- **Services & logs** — manage systemd units and autostart; query and follow journald by unit and level.
- **Remote files** — SFTP upload (including drag & drop), rename, delete and inline editing, tracking the terminal's `cd`.
- **Database workbench** — MySQL, MariaDB, PostgreSQL, SQLite and Redis: paged query results, in-place row editing, CSV export and schema editing.
- **Command center** — a built-in knowledge base with risk tiers: read-only commands run directly, medium-risk ones ask for confirmation.
- **Deployments** — compose project steps, run them with live logs and browse past runs.
- **Security** — remote commands are generated from Rust-side whitelisted templates, the frontend never sends command strings; credentials live in the OS keyring; host keys are verified on first connect; CSP is on by default.

**Install**

Grab the `*.exe` or `*.msi` from [Releases](https://github.com/npcxl/BLS-OPS/releases) and run it — the app updates itself.
You can also start from the website: [ops.xlcig.cn](https://ops.xlcig.cn).

**Development**

```bash
pnpm install
pnpm tauri dev          # frontend HMR + incremental Rust build
pnpm build && pnpm test # typecheck / build / unit tests
cargo test --lib --manifest-path src-tauri/Cargo.toml
```

CI lives in `.github/workflows/ci.yml` (frontend / backend / database jobs); releases are cut by pushing a tag, see `.github/workflows/release.yml`.

---

## License

MIT
