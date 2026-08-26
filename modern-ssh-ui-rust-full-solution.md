# 现代化 SSH 桌面运维工具 —— UI + 前端 + Rust 一体化技术方案

> 项目定位：现代化 SSH 桌面运维工具  
> 第一核心：SSH / Terminal / Server Workspace  
> 第二核心：文件、Docker、Nginx、服务、日志  
> 第三核心：项目、构建、Workflow、自动化部署、版本回滚、CI/CD  
> 智能层：AI 上下文助手  
> 客户端数据：仅本地 SQLite，不建设业务数据服务器  
> 目标平台：Windows 优先，同时为 macOS / Linux 保持架构兼容

---

# 1. 最终技术栈——直接定版

本项目统一采用以下技术栈，不再提供替代方案。

## 1.1 桌面框架

```text
Tauri 2
```

负责：

- 桌面窗口
- Rust 后端
- React WebView
- 系统权限
- IPC
- 应用打包
- 自动更新
- 文件系统访问边界
- Capability / Permission

---

## 1.2 Rust

```text
Rust Stable
Tokio
Serde
Serde JSON
SQLx
SQLite
Tracing
ThisError
Anyhow（仅基础设施边界使用）
Reqwest
Async Trait
UUID
Chrono
Keyring
```

Rust 是整个应用的：

```text
安全边界
SSH Engine
文件 Engine
Workflow Engine
Build Engine
Deploy Engine
Docker/Nginx Adapter
AI Gateway
数据层
```

---

# 2. 前端唯一方案

```text
React 19
TypeScript
Vite

Tailwind CSS 4
shadcn/ui
Base UI

Motion
Lucide React

TanStack Query
TanStack Table

Zustand

xterm.js

React Flow
```

---

# 3. 为什么采用这套 UI 方案

本产品不是：

```text
企业 ERP
管理后台
普通 SaaS Dashboard
```

所以不采用：

```text
Ant Design
Material UI
Element
```

这种完整视觉框架。

本产品需要：

```text
桌面应用感
IDE 工作台感
Terminal 工具感
极高信息密度
大量右键
大量快捷键
Split Pane
可调整 Panel
Dock / Tab
Command Palette
复杂浮层
Workflow Node
上下文 AI
```

因此 UI 基础使用：

```text
shadcn/ui + Base UI
```

组件源码进入项目，可以完全重塑视觉，不受现成 Design System 限制。

Tailwind CSS 4 统一负责 Design Token 与视觉实现。

---

# 4. 产品视觉方向

视觉概念正式定名：

# Ops Workbench

关键词：

```text
Dark
Dense
Precise
Spatial
Contextual
Technical
Calm
```

不是：

```text
赛博朋克
霓虹大屏
科技蓝渐变后台
大圆角 AI App
```

整体参考气质：

```text
IDE
Terminal
专业工程软件
现代生产力工具
```

但必须建立自己的视觉语言。

---

# 5. 界面最重要的设计原则

## 5.1 内容优先

Terminal、日志、代码、配置、文件才是主角。

装饰必须让位于内容。

---

## 5.2 高信息密度

SSH 工具不是消费级 App。

默认密度：

```text
Top Bar            40px
Navigation Rail    48px
Context Sidebar    244px
Toolbar             36px
Input               30px
Button              30px
Table Row           36px
Tree Row            30px
Tab                  34px
Status Bar           24px
```

---

## 5.3 少卡片化

禁止页面里：

```text
一个信息一个大卡片
```

采用：

```text
Panel
Section
Row
Tree
Inspector
Table
Timeline
```

为主。

---

## 5.4 状态才使用颜色

普通结构保持灰阶。

颜色只用于：

```text
Active
Connected
Running
Success
Warning
Error
Focus
Selection
AI
```

---

# 6. 主界面布局

整个应用统一采用：

```text
┌─────────────────────────────────────────────────────────────┐
│                        App Top Bar                          │
├──────┬───────────────────┬──────────────────────────────────┤
│      │                   │                                  │
│ Rail │ Context Sidebar   │ Workspace                        │
│      │                   │                                  │
│      │                   │                                  │
│      │                   │                                  │
├──────┴───────────────────┴──────────────────────────────────┤
│                         Status Bar                          │
└─────────────────────────────────────────────────────────────┘
```

---

# 7. 一级 Navigation Rail

宽度：

```text
48px
```

图标：

```text
SSH
Servers
Files
Projects
Deploy
Docker
Nginx
Tasks
AI

────────

Settings
```

只使用 Icon。

Hover 才显示名称。

Active：

```text
左侧 2px Indicator
+
低饱和背景
+
Icon 高亮
```

避免整个按钮铺满蓝色。

---

# 8. Context Sidebar

默认：

```text
244px
```

允许：

```text
Resize
Collapse
```

不同模块动态变化。

---

# 9. SSH Context Sidebar

结构：

```text
Quick Connect

Favorites

Production
├── API-01
├── API-02
└── WEB-01

Testing
├── TEST-01
└── TEST-02

Active Sessions
├── api-prod
└── web-prod
```

服务器条目：

```text
● API-01
  10.0.0.11
```

Connected：

```text
绿色 6px 状态点
```

不要整行绿色。

---

# 10. Main Workspace

Workspace 是产品的核心。

它不是普通：

```text
router page
```

而是：

```text
Workspace
├── Workspace Tabs
├── Toolbar
├── Primary Pane
├── Optional Secondary Pane
├── Optional Inspector
└── Optional AI Panel
```

---

# 11. Workspace Tab

顶部：

```text
● API-01 ×
● WEB-01 ×
NE Web ×
Docker ×
+
```

Tab 可以混合：

```text
Terminal
Server
Project
File
Docker
Workflow
```

这是现代桌面工具的重要体验。

---

# 12. Tab 数据模型

```ts
type WorkspaceTabType =
  | "terminal"
  | "server"
  | "file"
  | "project"
  | "docker"
  | "nginx"
  | "workflow"
  | "deployment"
```

---

# 13. Split Workspace

支持：

```text
Horizontal
Vertical
```

例如：

```text
┌──────────────────────┬──────────────────────┐
│ API Terminal         │ WEB Terminal         │
│                      │                      │
└──────────────────────┴──────────────────────┘
```

或：

```text
┌─────────────────────────────────────────────┐
│ Terminal                                    │
├─────────────────────────────────────────────┤
│ Logs                                        │
└─────────────────────────────────────────────┘
```

---

# 14. Pane 系统

实现自己的：

```text
WorkbenchPane
```

数据：

```ts
interface WorkbenchPane {
  id: string
  direction?: "horizontal" | "vertical"
  tabs: WorkspaceTab[]
  activeTabId: string
  children?: WorkbenchPane[]
}
```

Workspace Layout 存 Zustand。

---

# 15. Status Bar

高度：

```text
24px
```

底部固定。

显示：

```text
SSH ● 3

Tasks 2

↓ 2.3 MB/s
↑ 820 KB/s

AI Ready

v0.3.2
```

不使用大块 Status Card。

---

# 16. Design Token

使用 Tailwind CSS 4 `@theme`。

基础建议：

```css
@import "tailwindcss";

@theme {
  --color-app: #0b0e13;
  --color-surface-1: #10141b;
  --color-surface-2: #151a23;
  --color-surface-3: #1a202b;
  --color-surface-hover: #202735;
  --color-surface-active: #252e3e;

  --color-line: #222935;
  --color-line-strong: #303949;

  --color-fg: #e9edf3;
  --color-fg-muted: #9099a8;
  --color-fg-subtle: #626c7c;

  --color-accent: #7297ff;
  --color-accent-soft: #18233f;

  --color-ai: #a58bff;
  --color-ai-soft: #211b39;

  --color-success: #4fc38a;
  --color-warning: #e9b85d;
  --color-danger: #ed6a73;

  --radius-control: 6px;
  --radius-panel: 8px;
  --radius-floating: 10px;

  --font-ui: Inter, "Noto Sans SC", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
}
```

---

# 17. 色彩使用规则

Accent：

```text
Selection
Focus
Active Tab
Primary Action
Link
```

AI Purple：

```text
AI Panel
AI Suggestion
AI Generated
```

Success：

```text
Connected
Healthy
Succeeded
```

Warning：

```text
Needs Attention
Waiting
Risk
```

Danger：

```text
Disconnected
Failed
Destructive
```

---

# 18. 阴影

本应用减少传统 Web Shadow。

普通 Panel：

```text
无阴影
Border 分层
```

仅：

```text
Popover
Dialog
Command Palette
Floating Inspector
```

使用阴影。

---

# 19. 圆角

统一：

```text
Button          6px
Input           6px
Select          6px

Panel           8px

Dialog         10px
Popover        10px

Badge           4px
Terminal Pane   6px
```

禁止大量：

```text
16 / 20 / 24px
```

---

# 20. 字体

UI：

```text
Inter
Noto Sans SC
```

Terminal / Code：

```text
JetBrains Mono
```

字号：

```text
11px   meta
12px   secondary
13px   default
14px   strong content
16px   section title
20px   page title
```

桌面工具默认：

```text
13px
```

---

# 21. Icon

统一：

```text
Lucide React
```

默认：

```text
16px
```

Rail：

```text
18px
```

禁止混用多个 Icon Set。

---

# 22. shadcn/ui 使用范围

直接使用并改造：

```text
Button
Input
Textarea
Dialog
Alert Dialog
Dropdown Menu
Context Menu
Tooltip
Popover
Select
Combobox
Tabs
Command
Sheet
Separator
Checkbox
Switch
Progress
Scroll Area
Collapsible
Accordion
Breadcrumb
Skeleton
Toast
```

---

# 23. 自己开发的核心组件

不能只靠 shadcn。

必须开发：

```text
Workbench
WorkbenchPane
WorkspaceTabs
NavigationRail
ContextSidebar
StatusBar

TerminalView
TerminalToolbar
TerminalSplit
SessionChip

ServerTree
ServerItem
ServerStatus

RemoteFileExplorer
TransferQueue

LogViewer
CodeViewer

InspectorPanel

PropertyGrid

TaskTimeline

DeploymentTimeline

WorkflowCanvas
WorkflowNode

AIContextPanel
```

---

# 24. Button 规范

尺寸：

```text
XS  24px
SM  28px
MD  30px
LG  34px
```

默认：

```text
30px
```

Variants：

```text
Primary
Secondary
Ghost
Outline
Danger
```

桌面工具应大量使用：

```text
Ghost
```

而不是每个操作都是实心按钮。

---

# 25. Command Palette

快捷键：

```text
Ctrl + K
```

或 macOS：

```text
Cmd + K
```

Command Palette：

```text
> Connect API-01
> Open NE Web
> Open Docker
> Deploy NE API Production
> Search server
> Run command
> Create port forward
> Ask AI
```

这是产品一级功能，不是附加组件。

---

# 26. Global Quick Actions

快捷键：

```text
Ctrl + K       Command Palette

Ctrl + Shift + P
               Action Palette

Ctrl + T       New SSH Tab

Ctrl + Shift + T
               Reopen Session

Ctrl + W       Close Tab

Ctrl + \       Split

Ctrl + J       AI Panel

Ctrl + B       Sidebar

Ctrl + `       Terminal
```

---

# 27. Right Click Context Menu

服务器：

```text
Connect
Open New Tab
Open Split

Files
Projects
Docker

Port Forward

Copy Host
Edit

────────
Disconnect
Delete
```

Terminal：

```text
Copy
Paste
Search

Run Again
Save Command

Ask AI
Explain
```

项目：

```text
Open
Build
Deploy

Open Server
Open Terminal

Duplicate Workflow
```

---

# 28. SSH 首页

默认首页不是 Dashboard 大屏。

采用：

```text
Workbench Home
```

结构：

```text
Quick Connect
Recent Sessions
Favorites
Server Groups
Recent Commands
Active Tasks
```

---

# 29. Quick Connect

顶部重要入口。

Input：

```text
user@hostname:22
```

支持自动解析。

右边：

```text
Connect
```

高级展开：

```text
Credential
ProxyJump
Encoding
Save Host
```

---

# 30. Terminal 页面

布局：

```text
┌──────────────────────────────────────────────────────┐
│ API-01 ●   Ubuntu 24.04   4 CPU   RAM 42%           │
├──────────────────────────────────────────────────────┤
│ Terminal Toolbar                                     │
├──────────────────────────────────────────────────────┤
│                                                      │
│ root@api-prod:/opt/app#                              │
│                                                      │
│                                                      │
├──────────────────────────────────────────────────────┤
│ Connected · 18ms                          UTF-8      │
└──────────────────────────────────────────────────────┘
```

---

# 31. Terminal Toolbar

左：

```text
Server Name
Connection Status
```

中：

```text
Search
Split
Broadcast
Clear
```

右：

```text
Files
Monitor
AI
More
```

---

# 32. xterm.js 设计

React 仅负责：

```text
mount
resize
theme
keyboard
```

实时内容：

```text
Rust SSH PTY
↓
Tauri Event
↓
xterm.write
```

Terminal output 不进入 React State。

---

# 33. Terminal Theme

Terminal 背景：

```text
#090c10
```

和 App 背景略有差异。

Terminal 不加明显 Border Card。

使用 Pane Edge 区分。

---

# 34. Terminal AI

用户选中文字：

```text
systemctl: command not found
```

浮动 Action：

```text
Copy
Explain
Ask AI
```

Explain 后右侧 AI Panel 展开。

---

# 35. AI Panel

默认右侧：

```text
360px
```

允许：

```text
Resize
Collapse
Detach（后续）
```

AI 永远知道当前上下文：

```text
Current Server
Current Terminal
Selected Text
Current Project
Current File
Current Container
Current Deployment
```

---

# 36. AI Panel UI

顶部：

```text
AI Assistant

Context:
API-01
Terminal
Production
```

消息区域不做普通 ChatGPT 大气泡。

使用：

```text
连续文档式回答
+
Action Block
+
Command Block
+
Risk Badge
```

---

# 37. AI Command Proposal

例如：

```text
检查 8080 端口
```

AI 输出：

```text
ss -lntp | grep :8080
```

下面：

```text
Read-only

[Run]
[Copy]
```

Run 后：

```text
AI Proposal
↓
Rust Risk Engine
↓
SSH Command
```

---

# 38. Server Workspace

服务器点击后：

```text
Overview
Terminal
Files
Processes
Services
Docker
Nginx
Projects
Deployments
Logs
```

Tabs 是二级内容导航。

---

# 39. Server Overview

不要做八张统计卡。

使用：

```text
Server Header
+
Health Strip
+
2 Column Inspector
```

例如：

```text
API-01
10.0.0.11

Ubuntu 24.04
amd64
Kernel 6.x

CPU       18%
Memory    42%
Disk      61%

Docker    Ready
Nginx     Ready
systemd   Ready

Projects  3
Containers 8
```

---

# 40. Server Capability

采用 Property Grid：

```text
Runtime

Docker           Ready      29.x
Docker Compose   Ready      2.x
Nginx            Ready      1.x
Node             Ready      22
Java             Missing
Python           Ready      3.12
```

右侧 Action：

```text
Install
Repair
View
```

仅 capability 支持时显示 Install。

---

# 41. Server Tree

服务器左侧树：

```text
Favorites

Production
  ● API-01
  ● API-02
  ○ WEB-01

Testing
  ○ TEST-01
```

状态点：

```text
Green   connected
Gray    idle
Yellow  reconnect
Red     error
```

---

# 42. File Manager

不做传统 FileZilla 双栏作为默认形态。

采用：

```text
Server Context
+
Remote Explorer
+
Transfer Queue
```

需要上传时支持：

```text
Drag local file directly
```

---

# 43. File Explorer Layout

```text
Toolbar

Breadcrumb
/ opt / apps / api

Name
Size
Permission
Owner
Modified
```

右键提供文件操作。

---

# 44. Remote Editor

文本文件：

```text
Editor
+
Diff Before Save
```

保存：

```text
Backup old
↓
Upload temp
↓
Atomic replace
```

配置文件可在右侧打开：

```text
AI Explain
```

---

# 45. Project 页面

项目是高级能力。

左侧 Context：

```text
Recent

Frontend
Backend
Infrastructure

Production
Testing
```

---

# 46. Project Detail

## 前端

```text
Overview
Config
Relations
Git
Build
Workflow
Deploy
Versions
```

## 后端

```text
Overview
Config
Dependencies
Relations
Git
Build
Workflow
Deploy
Migration
Versions
Logs
```

---

# 47. Project Header

```text
NE API

Backend · Node · Production

main
commit 82a9c1

Running
v3.4.2

API-01 / API-02
```

右：

```text
Open Terminal
Build
Deploy
```

---

# 48. Config 页面

使用：

```text
Property Grid
```

而不是大量 Form Card。

结构：

```text
Build Config

Package Manager       pnpm
Node                  22
Build Command         pnpm build


Runtime Config

PORT                  8080
DATABASE_URL          PostgreSQL / Production
REDIS_URL             Redis / Production
JWT_SECRET            Secret
```

---

# 49. Config Value UI

每个配置显示：

```text
Key
Value / Reference
Source
Apply Mode
Relation
```

例如：

```text
DATABASE_URL

PostgreSQL · Production
Dependency Reference

Runtime
Restart Required
```

---

# 50. Project Relation UI

默认先使用：

```text
Relation List
```

而不是强迫用户看关系图。

```text
Depends On

PostgreSQL
Redis
User API

Used By

WEB
Admin
Worker
```

按钮：

```text
Graph View
```

---

# 51. Relations Graph

使用：

```text
React Flow
```

视觉：

```text
WEB ── API ── PostgreSQL
        │
        └── Redis
```

Node 风格和 Workflow Node 同语言。

---

# 52. Workflow

React Flow 负责可视化。

底层：

```text
Node + Edge DAG
```

允许：

```text
2 → 5
3 → 6
```

绝不固定 1-9。

---

# 53. Workflow 视觉

Node：

```text
┌──────────────────────────┐
│ Docker Build             │
│                          │
│ Image: ne-api            │
│ linux/amd64              │
│                          │
│ ✓ 32s                    │
└──────────────────────────┘
```

Node 不使用五颜六色。

状态才使用颜色。

---

# 54. Node 类别

Icon + 小分类：

```text
Source
Build
Artifact
Transfer
Deploy
Service
Health
Approval
Migration
Custom
```

---

# 55. Workflow Inspector

选择 Node 后：

右侧：

```text
Node Inspector
```

例如 Docker Build：

```text
Name

Dockerfile
Context
Platform
Tags
Build Args

Outputs
image
digest
```

---

# 56. Workflow 操作

顶部：

```text
Run
Run From
Run To
Stop

Validate

History
```

Node 右键：

```text
Run Node
Run From Here
Run Until Here

Disable
Duplicate
Delete
```

---

# 57. Deployment Center

部署不是大表格页面。

顶部：

```text
Running
Waiting
Failed
Recent
```

下面 Timeline。

---

# 58. Deployment Timeline

```text
14:20:01  Preflight           ✓
14:20:03  Resolve Config      ✓
14:20:04  Dependency Check    ✓
14:20:08  Docker Pull         ✓
14:20:22  Start Green         ✓
14:20:24  Health Check        ✓
14:20:26  Switch Traffic      ✓
14:20:28  Register Version    ✓
```

点击 Step 展开：

```text
Input
Output
Logs
Duration
```

---

# 59. Build / Deploy Status

状态统一：

```text
Queued
Running
Waiting
Success
Failed
Cancelled
Rolled Back
```

统一 Status Component。

---

# 60. Docker UI

Docker 是 Server Workspace 与全局模块都有入口。

左 Context：

```text
Servers

API-01
WEB-01
```

Workspace：

```text
Containers
Images
Compose
Volumes
Networks
```

---

# 61. Container Row

```text
● ne-api

running
api:v3.4.2

8080 → 8080

CPU 4%
RAM 183 MB

12h
```

Hover Action：

```text
Logs
Terminal
Restart
More
```

---

# 62. Container Detail

Tabs：

```text
Overview
Logs
Inspect
Environment
Volumes
Networks
Stats
```

---

# 63. Container Logs

使用统一：

```text
LogViewer
```

支持：

```text
Follow
Search
Filter
Pause
Timestamp
Wrap
AI Analyze
```

---

# 64. Nginx UI

Context：

```text
Instances

API-01
WEB-01
```

Workspace：

```text
Sites
Upstreams
Certificates
Configs
Logs
Snapshots
```

---

# 65. Nginx Config Editor

结构：

```text
Code Editor
+
Config Inspector
```

顶部：

```text
Validate
Save
Reload
History
```

Save 流程：

```text
Draft
↓
nginx -t
↓
Save
↓
Reload
```

---

# 66. Tasks

全局 Task Drawer。

右下 Status Bar：

```text
Tasks 3
```

点击打开：

```text
Build
Upload
Docker Pull
Deploy
```

---

# 67. Toast

只用于：

```text
成功
轻错误
后台完成
```

复杂错误必须：

```text
Error Panel
Dialog
Task Detail
```

不能所有问题都 Toast。

---

# 68. Error UX

例如：

```text
Docker Permission Denied
```

UI：

```text
Docker daemon exists but the current SSH user
cannot access /var/run/docker.sock.

Reason
Permission denied

Actions
[Use sudo]
[View Fix]
[Cancel]
```

错误必须可操作。

---

# 69. Motion

使用：

```text
Motion
```

只做：

```text
Panel enter
Inspector slide
Context switch
Command Palette
Collapse
Status change
```

时间：

```text
120–180ms
```

禁止花哨页面转场。

---

# 70. React 状态架构

## TanStack Query

保存：

```text
Servers
Projects
Deployments
Docker Data
Nginx Data
Task Data
```

即：

```text
Rust-backed server state
```

---

## Zustand

保存：

```text
Active Tab
Workspace Layout
Split Pane
Sidebar State
Active Server
Active Project
AI Panel
Terminal UI
User Preferences
```

---

# 71. 不进入 Zustand 的数据

```text
Terminal output
Huge logs
File bytes
Transfer chunks
```

这些使用：

```text
Event Stream
```

---

# 72. React 目录

```text
src/

app/
  App.tsx
  router.tsx
  providers.tsx

workbench/
  Workbench.tsx
  NavigationRail.tsx
  ContextSidebar.tsx
  Workspace.tsx
  WorkspaceTabs.tsx
  WorkbenchPane.tsx
  StatusBar.tsx

features/

  ssh/
    components/
    hooks/
    api/
    store/
    types/

  server/
  files/
  project/
  workflow/
  build/
  deploy/
  docker/
  nginx/
  tasks/
  ai/

components/

  ui/
  data/
  feedback/
  editor/
  log/
  status/

services/
  tauri/

stores/

styles/
  globals.css
  tokens.css
```

---

# 73. Rust 总体架构

```text
React
↓
Tauri Commands
↓
Application Services
↓
Engines
↓
Domain
↓
Adapters / Infrastructure
```

禁止：

```text
React → Shell
```

禁止：

```text
Tauri Command 内直接写 300 行 SSH 逻辑
```

---

# 74. Rust 目录

```text
src-tauri/src/

commands/
  ssh.rs
  server.rs
  file.rs
  docker.rs
  nginx.rs
  project.rs
  build.rs
  workflow.rs
  deploy.rs
  task.rs
  ai.rs

domain/
  ssh/
  server/
  credential/
  file/
  project/
  config/
  dependency/
  relation/
  workflow/
  build/
  artifact/
  deployment/
  task/
  audit/

services/
  ssh_service.rs
  server_service.rs
  file_service.rs
  docker_service.rs
  nginx_service.rs
  project_service.rs
  build_service.rs
  workflow_service.rs
  deploy_service.rs
  ai_service.rs

engines/
  ssh_session_manager/
  environment_inspector/
  capability_engine/
  workflow_engine/
  build_engine/
  deployment_engine/
  health_engine/
  rollback_engine/
  risk_engine/
  task_engine/

adapters/
  package_manager/
  init_system/
  docker/
  nginx/
  dependency/
  deployment/

infrastructure/
  ssh/
  sftp/
  sqlite/
  keyring/
  git/
  filesystem/
  process/
  http/

security/
  known_hosts/
  secret_masker/
  risk/
  approval/
  audit/

ai/
  gateway/
  providers/
  terminal/
  project/
  deployment/

state/
errors/
utils/
```

---

# 75. Tauri IPC 设计

React 所有 Rust 调用统一通过：

```text
src/services/tauri
```

例如：

```ts
export const ServerApi = {
  list() {},
  create() {},
  connect() {},
  inspect() {},
}
```

组件禁止直接随处：

```ts
invoke(...)
```

---

# 76. Command 命名

统一：

```text
server_list
server_create
server_update
server_delete

ssh_connect
ssh_disconnect

terminal_open
terminal_write
terminal_resize
terminal_close

file_list
file_upload
file_download

docker_list_containers

project_list

workflow_run

deployment_run
```

---

# 77. Event 命名

统一：

```text
terminal:{session_id}:output

transfer:{task_id}:progress

task:{task_id}:state

workflow:{run_id}:node

deployment:{id}:log

ai:{conversation_id}:chunk
```

---

# 78. SSH Session Manager

Rust：

```rust
pub struct SshSessionManager {
    sessions: RwLock<HashMap<SessionId, Arc<SshSession>>>,
}
```

负责：

```text
connect
disconnect
reconnect
pty
exec
sftp
forward
keepalive
```

---

# 79. Terminal Session

React 只保存：

```text
sessionId
serverId
title
layout
```

真正 SSH Session 永远在 Rust。

---

# 80. Environment Inspector

系统自动识别服务器事实：

```text
OS
Version
Arch
Kernel
Package Manager
Init
Docker
Compose
Nginx
Node
Java
Go
Python
Memory
Disk
Ports
Firewall
SELinux
AppArmor
```

UI 只显示结果。

---

# 81. 项目识别规则

项目类型正式值：

```text
用户选择
```

扫描代码仅作为：

```text
Recommendation
```

例如：

```text
Detected:
package.json
vite.config.ts
pnpm-lock.yaml

Recommended:
Frontend / Vite / pnpm

[Apply]
```

---

# 82. 前端项目

用户可配置：

```text
Source
Environment
Package Manager
Build Command
Artifact
Build-time Config
Deploy Strategy
Target
Health
```

---

# 83. 后端项目

额外：

```text
Runtime
Port
Dependencies
Runtime Config
Secrets
Migration
Process
Health
Restart / Rolling / Blue Green
```

---

# 84. Dependency

后端支持：

```text
PostgreSQL
MySQL
Redis
Elasticsearch
RabbitMQ
Kafka
NATS
MinIO
S3
External API
Other Project
Custom
```

---

# 85. Dependency UI

```text
PostgreSQL
Ready
Production DB

Used by:
DATABASE_URL

Health:
12ms
```

---

# 86. Config Apply Mode

```text
BuildTime
Runtime
Reload
Restart
```

UI 显示：

```text
VITE_API_URL
Build Time
Rebuild Required
```

以及：

```text
DATABASE_URL
Runtime
Restart Required
```

---

# 87. Workflow Engine

底层必须：

```text
Node + Edge DAG
```

UI 使用：

```text
React Flow
```

---

# 88. 用户可以

```text
Run All
Run Node
Run From Here
Run To Here
Skip Node
Disable Node
Retry Node
```

---

# 89. Deployment

Deployment 必须包含：

```text
Preflight
Capability Validation
Config Resolve
Dependency Check
Execution
Health
Snapshot
Rollback
```

但这些不是 UI 固定 1-9。

它们可以根据 Workflow 组合。

---

# 90. AI Provider

统一：

```rust
trait AiProvider
```

第一阶段实现：

```text
OpenAI-compatible
Ollama
```

再预留：

```text
Custom HTTP
Local
```

---

# 91. AI UI 与 Rust

AI 输入必须带：

```text
ContextDescriptor
```

例如：

```json
{
  "server_id": "...",
  "session_id": "...",
  "project_id": "...",
  "selected_text": "..."
}
```

Rust 负责决定哪些上下文允许发送给 AI。

---

# 92. AI 执行链

必须：

```text
AI
↓
Proposal
↓
Schema Validation
↓
Risk Engine
↓
User Run
↓
SSH / Workflow Engine
```

AI 永远不拥有 SSH Connection。

---

# 93. SQLite

本地保存：

```text
Users
Servers
Credentials Ref
Known Hosts
Sessions
History
Projects
Configs
Relations
Dependencies
Workflows
Builds
Deployments
Docker Metadata
Nginx Metadata
AI Settings
Audit
Preferences
```

---

# 94. Local Login UI

启动：

```text
App Logo

Local Workspace

Password

[Unlock]
```

不要设计成互联网登录页。

不要：

```text
手机号
验证码
注册
忘记密码 API
```

---

# 95. 本地密码

Rust：

```text
Argon2id
```

SQLite 只保存：

```text
password_hash
```

---

# 96. Security UX

任何 Credential：

```text
Password
SSH Key Passphrase
Git Token
Registry Password
AI Key
```

UI：

```text
••••••••
```

只能：

```text
Replace
Test
Delete
```

尽量不提供“查看明文”。

---

# 97. Desktop Window

默认最小尺寸：

```text
1100 × 700
```

推荐初始：

```text
1440 × 900
```

支持最大化。

布局必须在：

```text
1280
1440
1920
2560
```

正常工作。

---

# 98. Responsive 原则

这是 Desktop App。

不要做 Mobile-first。

优先：

```text
Desktop Dense Layout
```

当宽度不足：

```text
隐藏 Context Sidebar
收起 AI
单 Pane
```

而不是把所有内容堆成手机卡片。

---

# 99. UI 状态

所有页面必须设计：

```text
Loading
Empty
Normal
Partial
Disconnected
Error
Permission Denied
Unsupported
```

---

# 100. Empty State

例如无服务器：

```text
No servers yet

Add your first SSH server
or use Quick Connect.

[Add Server]
```

保持极简。

---

# 101. Unsupported State

例如：

```text
Docker unavailable

Docker is not installed on this server.

Ubuntu 24.04 is supported.

[Install Docker]
[Learn Why]
```

比 Disabled Button 更好。

---

# 102. Keyboard First

几乎所有核心操作都应支持：

```text
Keyboard
```

目标：

高级用户可以很少使用鼠标。

---

# 103. Accessibility

Base UI 作为底层 Primitive。

必须保持：

```text
Focus Ring
Keyboard Navigation
ARIA
Focus Trap
Screen Reader Label
```

不能为了视觉删除 focus 状态。

---

# 104. UI 性能

Terminal：

```text
直接 xterm.write
```

Log：

```text
Virtual List
```

Table：

```text
TanStack Table
+
virtualization（数据量大时）
```

File Tree：

```text
Lazy Load
```

---

# 105. 数据更新策略

例如 Docker：

```text
打开页面
↓
Query
```

需要实时：

```text
poll 2–5s
```

Terminal：

```text
Event
```

Task：

```text
Event
```

Server Facts：

```text
手动刷新
+
TTL
```

---

# 106. UI 设计禁止项

Cursor 实现时禁止：

```text
大面积蓝紫渐变
玻璃拟态满屏
20px+ 大圆角
每个字段一个 Card
所有按钮都有图标 + 实心色
超大 Dashboard KPI
移动端式间距
全页面 Fade 动画
默认 shadcn 样式原样使用
```

---

# 107. “新奇”的真正来源

本项目的新奇感来自：

```text
Workspace 多标签
Server Context 穿透
Split Pane
Command Palette
Context Menu
Keyboard First
Terminal 与服务器状态融合
AI 上下文侧栏
项目/服务器可互相跳转
Workflow DAG
Inspector
可执行错误提示
```

而不是视觉特效。

---

# 108. 首页用户体验

启动解锁后：

```text
Recent Sessions

API-01
Connected 18 min ago

WEB-01
Yesterday


Quick Connect
user@host


Favorites


Running Tasks
Docker Pull 68%
```

用户两次点击以内进入 SSH。

---

# 109. Server → Project 穿透

例如当前：

```text
API-01
```

Server Workspace 的 Projects：

```text
NE API
Worker
Scheduler
```

点 NE API：

打开：

```text
Project Tab
```

但 Context 仍保存：

```text
Server API-01
```

---

# 110. Project → Server 穿透

Project：

```text
NE API
```

Targets：

```text
API-01
API-02
```

点击 API-01：

```text
Open Terminal
Open Server Workspace
Open Files
```

不需要重新找服务器。

---

# 111. 全局对象链接

Server、Project、Container、File、Deployment 都使用：

```text
Entity Link
```

类似 IDE Symbol。

例如：

```text
API-01
```

Hover：

```text
Server
10.0.0.11
Connected
```

点击：

```text
Open
```

---

# 112. 最终前端依赖定位

```text
React
        Application UI

Tailwind CSS
        Visual Tokens / Layout

shadcn/ui
        Application Components

Base UI
        Headless Interaction Primitives

Motion
        Micro Interaction

Lucide
        Icons

xterm.js
        Terminal

React Flow
        Workflow / Relation Graph

TanStack Query
        Rust-backed Async State

TanStack Table
        Dense Tables

Zustand
        Workbench UI State
```

---

# 113. 最终 Rust 定位

```text
Tauri
        Desktop Shell / IPC

Tokio
        Async Runtime

SSH Layer
        Session / PTY / SFTP / Forward

SQLx + SQLite
        Local Persistence

Keyring
        Secret Storage

Environment Inspector
        Server Facts

Capability Engine
        What server can do

Workflow Engine
        Node + Edge execution

Build Engine
        Build

Deployment Engine
        Deploy

Health Engine
        Verify

Rollback Engine
        Restore

Risk Engine
        Safety

AI Gateway
        Model abstraction
```

---

# 114. 最终完整系统关系

```text
                       ┌──────────────┐
                       │ React UI     │
                       │ Workbench    │
                       └──────┬───────┘
                              │
                           Tauri IPC
                              │
               ┌──────────────▼──────────────┐
               │ Application Services       │
               └──────────────┬──────────────┘
                              │
      ┌───────────────────────┼──────────────────────┐
      │                       │                      │
      ▼                       ▼                      ▼
 SSH Core               Server Engine          Project Engine
      │                       │                      │
      │                       ▼                      ▼
      │                 Capability              Workflow
      │                       │                      │
      │                       └──────────┬───────────┘
      │                                  ▼
      │                             Deployment
      │                                  │
      │                                  ▼
      │                              Health
      │                                  │
      │                                  ▼
      │                              Snapshot
      │                                  │
      │                                  ▼
      └────────────────────────────── Rollback

                         AI Gateway
                             │
                  recommendation / analysis
                             │
                             ▼
                         Risk Engine
                             │
                             ▼
                         User Action
```

---

# 115. MVP UI 实现顺序

## Phase 1

```text
App Shell
Navigation Rail
Context Sidebar
Workspace
Workspace Tabs
Status Bar
Theme
Command Palette
```

## Phase 2

```text
Server List
Quick Connect
Terminal
Multi Tab
Session
Context Menu
```

## Phase 3

```text
Split Terminal
SFTP
Transfer Queue
Remote Editor
Port Forward
```

## Phase 4

```text
Server Workspace
System Facts
Processes
Services
Docker
Nginx
Logs
```

## Phase 5

```text
Projects
Config
Dependencies
Relations
Git
```

## Phase 6

```text
Workflow
Build
Deploy
Task Timeline
Version
Rollback
```

## Phase 7

```text
AI Context Panel
Terminal AI
Log AI
Deployment AI
```

---

# 116. Cursor 第一阶段必须先做什么

不要第一天先写 Docker、部署或 AI。

先建立：

```text
1. Tauri + React 工程
2. Tailwind v4 Token
3. shadcn/Base UI
4. Workbench Shell
5. Rail
6. Context Sidebar
7. Workspace Tab
8. Split Pane 数据模型
9. Status Bar
10. Rust App State
11. SQLite
12. Tauri API wrapper
13. SSH Domain
14. Server CRUD
15. Quick Connect
16. Terminal
```

完成以后：

```text
这个程序已经是一款可用 SSH 客户端
```

再叠加 DevOps 能力。

---

# 117. Cursor UI 实现硬规则

1. 默认 Dark Theme。
2. App 采用 Rail + Context Sidebar + Workspace + Status Bar。
3. Terminal 是一级工作区，不是普通页面里的 Card。
4. UI 默认字号 13px。
5. Input/Button 默认高度约 30px。
6. 默认圆角 6–10px。
7. 不允许默认 shadcn 视觉原样上线。
8. 不允许大量 Card Dashboard。
9. 不允许大面积 Gradient。
10. 不允许把 AI 做成独立 ChatGPT Clone。
11. AI 默认右侧 Context Panel。
12. 全局实现 Command Palette。
13. 核心对象必须支持 Context Menu。
14. Workspace 必须支持 Tab。
15. Workspace 数据结构必须预留 Split。
16. Terminal output 不进入 Zustand。
17. 长日志需要虚拟列表。
18. 状态颜色只能表达状态。
19. 所有 Error 必须尽量给可执行 Action。
20. 所有 Server/Project/Container 对象都可以互相穿透打开。

---

# 118. Cursor Rust 实现硬规则

1. React 不得执行 shell。
2. Command 不写核心业务。
3. SSH Session 只存在 Rust。
4. Secret 不明文 SQLite。
5. Known Host 不自动忽略。
6. Terminal 使用 Event Stream。
7. 长任务统一 Task Engine。
8. ServerFacts 自动探测。
9. Capability 与 User Selection 分离。
10. Project Type 以用户选择为正式值。
11. Workflow 使用 Node + Edge。
12. Build 和 Deploy 分离。
13. Frontend / Backend Deploy Model 分离。
14. 后端支持 DB / Redis / ES Dependency。
15. Migration 是独立 Workflow Node。
16. Docker / Nginx / Runtime 安装经过 Capability。
17. Package Manager 使用 Adapter。
18. Init System 使用 Adapter。
19. AI 不持有 SSH Session。
20. AI 所有执行建议经过 Risk Engine。
21. Production Deployment 必须有 Snapshot。
22. Health Check 通过才能标记部署成功。
23. 回滚不能只做 Git Checkout。
24. 所有关键操作写 Audit Log。
25. 错误使用结构化 AppError，不使用字符串错误协议。

---

# 119. 最终产品气质

用户第一次打开应该感觉：

```text
这是一个新的专业 SSH 工具
```

而不是：

```text
这是一个后台管理系统
```

用一段时间以后发现：

```text
它不只是 SSH

它知道服务器
它知道 Docker
它知道 Nginx
它知道项目
它知道部署
它知道版本
它还能用 AI 帮我分析
```

这才是整个产品应该建立的体验层级。

---

# 120. 最终技术结论

唯一技术方案：

```text
Desktop
Tauri 2

Backend
Rust
Tokio
SQLx
SQLite
Keyring

Frontend
React 19
TypeScript
Vite

UI
Tailwind CSS 4
shadcn/ui
Base UI

Interaction
Motion
Lucide

Terminal
xterm.js

Workflow
React Flow

Data
TanStack Query
TanStack Table

UI State
Zustand
```

最终架构顺序：

```text
SSH Core
↓
Server Workspace
↓
DevOps Capabilities
↓
Project / Build / Workflow / Deployment
↓
AI
```

**SSH 是产品本体。**

**项目部署是高级能力。**

**AI 是智能辅助层。**
