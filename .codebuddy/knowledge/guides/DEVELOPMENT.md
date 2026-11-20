# 开发与发布手册

> 状态：**现行**，对照代码日期 2026-11-20，应用版本 0.1.30。
> 目标平台：Windows（主）/ macOS（可用）。CI 全部跑在 `windows-latest`。

---

## 1. 环境

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node | >= 20 | `package.json` 的 `engines`；CI 用 20。本机 24 也能跑 Vite 7 / Vitest 4 |
| pnpm | >= 9 | `packageManager: pnpm@9.15.9`，不要手写别的版本 |
| Rust | stable | 与 CI 同一工具链；本机若有多份，格式化时显式指定 |
| WebView2 | 运行时 | Windows 10/11 自带；旧系统装 Evergreen Runtime |

```bash
pnpm install
```

新增/升级依赖后用 `pnpm install --lockfile-only` 同步 lockfile —— CI 用 `--frozen-lockfile`，锁文件不一致会直接失败。

---

## 2. 日常开发

```bash
pnpm tauri dev
```

- `beforeDevCommand` 已经包含 `pnpm dev`，**不要再手工起 Vite**（`strictPort: 4200` 会撞端口）。
- 前端改动走 HMR；Rust 改动触发增量重编译。
- 本机调试 WebView2：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--enable-logging`，日志在 `%LOCALAPPDATA%\com.bls.ops\EBWebView\chrome_debug.log`。
- 开发构建保留 WebView 右键菜单（方便 F12）；生产构建全局禁用。

### 前端改动"看起来没生效"

`tauri::generate_context!` 在编译期把 `dist/` 嵌进二进制。只跑 `pnpm build` 不重新 `cargo build`，exe 里仍是旧前端。判断方法：对比 `dist/` 与 `src-tauri/target/debug/ops-workbench.exe` 的修改时间。

---

## 3. 验证矩阵

改动提交前按影响面选择：

| 改了什么 | 必跑 |
|---|---|
| 任意前端 | `pnpm build`（含 tsc）+ `pnpm test` |
| 任意 Rust | `cd src-tauri && cargo fmt --all -- --check` + `cargo check --all-targets` + `cargo test --lib` |
| SSH / SFTP / 监控 / P3 | `cargo test --test ssh_e2e --test monitor_e2e --test p3_e2e -- --test-threads=1` |
| 数据库（SQL 引擎） | `pnpm test:db`（需要本地容器，见下） |
| 数据库（Redis） | `cargo test --test database_redis`（CI 不跑：Windows runner 没有稳定 Redis） |
| 发布相关 | `pnpm check:versions` + `node scripts/verify-release.mjs <tag>`（发布后） |

完整回归：

```bash
cd src-tauri
cargo test --all-targets -j 1 -- --test-threads=1
```

`-j 1 -- --test-threads=1` 不是保守：数据库集成测试共用 `ops_test`，并行会互相 DROP TABLE；并行编译在内存紧张时还会触发 E0786/1455。

### 测试布局

- Rust 单元测试就近放在 `#[cfg(test)] mod tests`；纯解析函数必须覆盖空输入、超长、缺字段、非 Linux。
- Rust 集成测试在 `src-tauri/tests/`：`ssh_e2e` 用进程内 russh 服务器，`monitor_e2e` / `p3_e2e` 同构，数据库测试连真实实例。
- 前端测试就近放 `test/` 子目录；环境 happy-dom，剪贴板由 `src/test/setup-clipboard.ts` 统一替身。
- 数据库集成测试要求实例可达：环境变量 `BLS_TEST_*_REQUIRED=1`，实例没起来必须红，不许静默 skip。

### 本地数据库容器

`scripts/test-db.ps1` 默认对齐这组容器：

| 容器 | 端口 | 账号 |
|---|---|---|
| `bls-mysql-test`（mysql:8.0） | 33306 | root / `bls_test_pw` |
| `mariadb-test`（11.4） | 33070 | root / `xl010520` |
| `bls-pg-test`（postgres:17） | 55432 | postgres / `bls_test_pw`，库 `ops_test` |

```bash
pnpm test:db                        # MySQL 8.0 + PostgreSQL
pnpm test:db -- -Distribution mariadb   # MariaDB（脚本默认端口 33070）
```

容器没起时 PowerShell 脚本会先报"不可达"。跑失败后若报 1062 / `reliable_key` 变 `None`，先 `DROP DATABASE ops_test` 再跑（夹具不会自动校正已存在的表）。

---

## 4. 格式化与风格

- **没有 Prettier**。不要跑、不要引入；前端只做最小 replace 编辑，避免整文件重排。
- Rust 用 `cargo fmt --all`。本地默认工具链与 CI 不一致时（曾出现本地 1.97 / CI 1.99.1）用 `cargo +<ci-version> fmt --all`，否则 `--check` 会因格式化差异红。
- 注释写中文；代码标识符英文。
- 用户可见文案走 `t()`，见 `i18n.md`；不要在 JSX 里写死中文（数据库工作台的中文 key 是特例）。
- 提交前不要留 `.log` / 临时脚本；`*.log`、`*.err`、根目录 `*.txt` 都不入库。

---

## 5. 版本与发布

### 版本号

`package.json` 是**唯一输入**：

```bash
pnpm version:bump patch      # 0.1.30 → 0.1.31
pnpm version:bump minor
pnpm version:bump major
pnpm version:bump 0.2.3      # 显式版本
pnpm check:versions          # 四份必须一致（package.json / Cargo.toml / tauri.conf.json / Cargo.lock）
```

`bump-version.mjs` 只改版本字段，不动 git；`check-versions.mjs` 还校验 updater / process / dialog 三对插件在 JS 与 Rust 两侧版本一致。

### 发布流程

发布只走 `.github/workflows/release.yml`：

1. **Actions → Release → Run workflow**，选 `patch` / `minor` / `major`。
   workflow 会 bump → 提交 → 打 tag → 构建 → 产出 **draft** release。
2. 也可以推送 `vX.Y.Z` tag（只构建，不再 bump）。
3. 构建完成后**人工**在 GitHub 上发布 draft —— 发布前 `latest` 不会指向它，用户收不到更新。
4. 发布后用 `node scripts/verify-release.mjs vX.Y.Z` 校验：`latest.json` 合法、有 `windows-x86_64-nsis` 条目、URL 返回 PE 头、SHA-256 与资产摘要一致、`.sig` 与 `tauri.conf.json` 公钥匹配。

关键约束（勿回退）：

- 签名密钥只在 GitHub Secrets，私钥与口令绝不入库（`.tauri/`、`*.key*` 已忽略）。
- `tauri-action` 生成的 `latest.json` 里 URL 指向 `api.github.com/.../assets/<id>`（匿名 401），必须由 `scripts/rewrite-updater-urls.mjs` 改写成 `releases/download/<tag>/<name>` 直链。
- 自动更新只用官方 `tauri-plugin-updater`；前端状态唯一入口是 `stores/updater-store.ts`，更新失败必须显示 stage + code（详见 `p5.1-updater.md`）。
- 发布动作只在用户明确要求时执行；修 bug 就只改代码和验证。

详见 `p5.1-updater.md`。

---

## 6. 构建与产物

```bash
pnpm build            # 前端：tsc + vite build
pnpm tauri build      # 安装包（NSIS/MSI）；release profile 开 LTO、strip
```

- `src-tauri/target/` 会膨胀到 GB 级。cargo 跑完顺手删掉（`cargo clean` 或删目录），不要让构建产物堆在磁盘上。
- 运行中的 app 会锁 `target/debug/ops-workbench.exe`（os error 5）。要跑 `--all-targets` 先关应用，或改用 `cargo test --lib --test <目标>`。
- Windows `0xc0000139`（STATUS_ENTRYPOINT_NOT_FOUND）：先查 PATH 里是否有第三方 OpenSSL / Git DLL 抢先加载；CI 有"启动并保持 20 秒 + 必须有窗口标题"的冒烟测试守着这个问题。

---

## 7. 常见问题

| 现象 | 先查 |
|---|---|
| 连接被连了两次 / 断开又重连 | 是否有人加了 `React.StrictMode`（`src/main.tsx` 明确禁用） |
| 界面"接口正常但不渲染" | IPC 载荷字段名：Rust→前端 camelCase，DB/IPC 部分 snake_case；先 diff 字段名 |
| 深色下菜单发白 / 材质错乱 | 浮窗是否误跑了 `initTheme()`；主题令牌是否成对定义亮暗两套 |
| 命令候选面板乱弹 / 回车跑错东西 | 是否绕过 `terminal-suggest.ts` 的统一状态机 |
| i18n 出现裸 key 或英文回退 | key 是否与 `t("...")` 逐字一致；zh-CN 是否补齐；动态 key 是否进 `indirect-keys` 断言 |
| Rust 测试编译失败但代码没问题 | 另一个会话在并行改同一工作区；先看 `git status` 与 HEAD，别代改对方中间态 |
| 数据库测试莫名 1062 | 上次失败残留 `ops_test` 数据，先 DROP DATABASE |
| 文档里的路径/命令不存在 | `docs/` 被 `.gitignore` 排除，可能是旧机器拷来的；以代码为准 |

---

## 8. CI 结构

`.github/workflows/ci.yml` 三个 job：

| job | 内容 |
|---|---|
| `backend` | fmt --check、`cargo check --all-targets`、`cargo test --lib`、`database_sqlite` + `monitor_e2e` + `p3_e2e` + `ssh_e2e`（串行）、`cargo build`、桌面启动冒烟 |
| `database` | 矩阵 `mysql-8.0` / `mariadb-11.4`，每个 job 都额外起 PostgreSQL 17 @55432；跑 `database_mysql` + `database_postgres`（串行） |
| `frontend` | `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test` |

CI 的 MySQL 是临时实例，旧缓存里的测试 CA 会不匹配；workflow 会先删 `src-tauri/target/test-mysql-ca.pem`。
