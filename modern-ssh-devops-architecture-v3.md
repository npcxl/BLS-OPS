# 现代化 SSH 桌面运维工具总体架构设计文档 v3

> 技术栈：Rust + Tauri 2 + React + TypeScript + SQLite  
> 产品定位：**现代化 SSH 桌面工具优先，项目构建、自动化部署、Docker、Nginx、CI/CD、AI 运维作为 SSH 上层能力。**  
> 核心原则：**SSH 是内核，服务器工作台是中心，项目与部署是扩展能力。**

---

# 1. 产品定位

本产品首先是一款现代化 SSH 桌面工具。

不是：

```text
DevOps 平台 + SSH 功能
```

而是：

```text
SSH Core
    ↓
Server Workspace
    ↓
Files / Process / Services / Docker / Nginx
    ↓
Project / Build / Deploy / CI/CD
    ↓
AI Assistant
```

产品的第一价值是：

```text
更现代
更高效
更安全
更易管理
```

地连接、操作和管理远程服务器。

项目构建和自动化部署是建立在 SSH 能力之上的高级能力。

---

# 2. 产品目标

最终用户应该可以完成：

```text
添加服务器
↓
SSH 连接
↓
进入服务器工作台
↓
Terminal / 文件 / 服务 / Docker / Nginx
↓
关联项目
↓
项目构建
↓
自动部署
↓
版本管理
↓
回滚
↓
AI 辅助诊断
```

---

# 3. 产品优先级

## P0：SSH Core

必须优先完成。

```text
Server Management
SSH Connection
Credential
Host Key
Terminal
Multi Tab
Split Terminal
Session
SFTP
File Transfer
Port Forward
Command History
Quick Command
Reconnect
KeepAlive
ProxyJump
Known Hosts
Audit
```

---

## P1：Server Workspace

```text
Overview
System Facts
Capabilities
Processes
Services
Files
Docker
Nginx
Ports
Logs
Projects
Deployments
```

---

## P2：Project Management

```text
Project
Environment
Config
Dependencies
Relations
Git
Workflow
Build
Artifact
```

---

## P3：Deployment

```text
Nginx Static
Docker
Docker Compose
Native Service
Health Check
Version
Rollback
CI/CD
```

---

## P4：AI

```text
Terminal Assistant
Command Explain
Log Analysis
Failure Diagnosis
Project Advisor
Workflow Advisor
Deployment Advisor
```

---

# 4. 顶级导航

推荐：

```text
SSH
服务器
文件
项目
部署
Docker
Nginx
任务
AI
设置
```

SSH 是默认首页或第一入口。

---

# 5. 核心产品结构

```text
Application
│
├── SSH
│   ├── Sessions
│   ├── Terminal
│   ├── Split Terminal
│   ├── History
│   ├── Port Forward
│   └── Quick Commands
│
├── Servers
│   ├── Server List
│   ├── Groups
│   ├── Tags
│   ├── Credentials
│   └── Server Workspace
│
├── Files
│   ├── SFTP
│   ├── Upload
│   ├── Download
│   └── Remote Edit
│
├── Projects
│   ├── Overview
│   ├── Environment
│   ├── Config
│   ├── Dependencies
│   ├── Relations
│   ├── Git
│   ├── Workflow
│   ├── Build
│   └── Versions
│
├── Deployments
│   ├── Runs
│   ├── Plans
│   ├── Health
│   └── Rollback
│
├── Docker
├── Nginx
├── Tasks
├── AI
└── Settings
```

---

# 6. 总体技术架构

```text
┌─────────────────────────────────────────────┐
│            React + TypeScript UI            │
│                                             │
│ SSH / Server / Files / Project / Deploy     │
└────────────────────┬────────────────────────┘
                     │
                  Tauri IPC
                     │
┌────────────────────▼────────────────────────┐
│                Rust Commands                │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│               Application Layer             │
│                                             │
│ SshService        ServerService             │
│ FileService       ProjectService            │
│ BuildService      DeploymentService         │
│ DockerService     NginxService              │
│ WorkflowService   AiService                 │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│                     Engines                 │
│                                             │
│ SshSessionManager                           │
│ EnvironmentInspector                        │
│ CapabilityEngine                            │
│ WorkflowEngine                              │
│ BuildEngine                                 │
│ DeploymentEngine                            │
│ HealthEngine                                │
│ RollbackEngine                              │
│ RiskEngine                                  │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│                Infrastructure               │
│                                             │
│ SSH / SFTP / Git / SQLite / Keyring         │
│ Docker / Nginx / Process / HTTP / Files     │
└─────────────────────────────────────────────┘
```

---

# 7. SSH Core

SSH Core 是整个产品最重要的底层模块。

定义：

```text
SshSessionManager
```

负责：

```text
连接
重连
KeepAlive
认证
Session 生命周期
Terminal Channel
Exec Channel
SFTP Channel
Port Forward
ProxyJump
Host Key
Connection Pool
```

---

# 8. Server 模型

```rust
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,

    pub credential_id: Option<String>,

    pub group_id: Option<String>,
    pub tags: Vec<String>,

    pub proxy_jump_id: Option<String>,

    pub created_at: i64,
    pub updated_at: i64,
}
```

---

# 9. SSH Credential

支持：

```text
Password
Private Key
SSH Agent
Keyboard Interactive
```

后续：

```text
Certificate
Hardware Key
```

Secret 不明文放 SQLite。

真实 Secret：

```text
Windows Credential Manager
macOS Keychain
Linux Secret Service
```

---

# 10. Host Key Security

必须支持：

```text
known_hosts
```

首次连接：

```text
Host Key Unknown

Fingerprint:
SHA256:xxx

[Trust Once]
[Trust And Save]
[Cancel]
```

Host Key 变化：

```text
BLOCK
```

并明确警告：

```text
可能是服务器重装，也可能存在 MITM 风险。
```

绝不能自动接受变化。

---

# 11. SSH ProxyJump

支持：

```text
Client
↓
Bastion
↓
Target
```

服务器配置：

```text
ProxyJump:
Bastion-01
```

后续支持多跳。

---

# 12. KeepAlive

Session 设置：

```text
keep_alive_interval
connection_timeout
reconnect_policy
```

例如：

```text
30s KeepAlive
3 次失败后断开
```

---

# 13. 自动重连

重连策略：

```text
Disabled
Manual
Auto
```

Auto：

```text
网络中断
↓
指数退避
↓
Reconnect
```

Terminal 需显示：

```text
Reconnecting...
```

---

# 14. Terminal

前端建议：

```text
xterm.js
```

Rust：

```text
SSH PTY
```

数据：

```text
xterm input
↓
Rust terminal_write
↓
SSH PTY

SSH PTY output
↓
Tauri Event
↓
xterm.write
```

---

# 15. Terminal 功能

必须支持：

```text
多标签
分屏
全屏
搜索
复制
粘贴
清屏
字体
字号
主题
光标
编码
ANSI
Resize
快捷键
```

---

# 16. Split Terminal

允许：

```text
Vertical
Horizontal
Grid
```

例如：

```text
┌────────────┬────────────┐
│ server-01  │ server-02  │
├────────────┼────────────┤
│ server-03  │ server-04  │
└────────────┴────────────┘
```

---

# 17. Broadcast Input

用户可选择多个 Terminal：

```text
Broadcast
```

输入：

```text
uptime
```

发送到所有选中 Session。

危险命令需要提示。

---

# 18. Command History

记录：

```text
server
session
command
timestamp
exit code
source
```

source：

```text
USER
QUICK_COMMAND
AI
SCRIPT
```

SecretMasker 负责脱敏。

---

# 19. Quick Commands

用户可以保存：

```text
查看磁盘
查看内存
查看 Docker
查看 Nginx
查看端口
```

例如：

```bash
df -h
```

支持按 Server Group 分类。

---

# 20. Port Forward

支持：

```text
Local Forward
Remote Forward
Dynamic SOCKS
```

示例：

```text
Local:
127.0.0.1:5433
→
db.internal:5432
```

---

# 21. SFTP

SFTP 是 SSH Core 的第二核心能力。

支持：

```text
目录浏览
上传
下载
拖拽
删除
重命名
新建目录
权限
查看
文本编辑
```

---

# 22. 文件传输

长任务统一：

```text
TransferTask
```

状态：

```text
Pending
Running
Paused
Succeeded
Failed
Cancelled
```

支持：

```text
进度
速度
剩余时间
重试
```

---

# 23. Remote Edit

编辑远程配置文件：

```text
download temp
↓
edit
↓
compare
↓
upload
```

保存前：

```text
显示 Diff
```

可选：

```text
backup_before_save = true
```

---

# 24. Server Workspace

连接服务器后进入：

```text
Server Workspace
```

页面：

```text
Overview
Terminal
Files
Processes
Services
Docker
Nginx
Ports
Projects
Deployments
Logs
```

---

# 25. Environment Inspector

Server Workspace 自动获取客观事实。

这些必须自动探测：

```text
OS
Version
CPU Arch
Kernel
Package Manager
Init System
Shell
Privilege
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

---

# 26. 系统事实和用户选择必须分离

系统事实：

```text
ServerFacts
```

用户选择：

```text
DeploymentProfile
ProjectConfiguration
Workflow
```

系统不能替用户决定：

```text
“这个项目一定应该用 Docker”
```

系统可以提示：

```text
Docker Ready
Nginx Ready
systemd Ready
```

然后让用户选择。

---

# 27. Capability Engine

根据 ServerFacts 判断：

```text
DockerRun
DockerInstall
DockerCompose
NginxInstall
NginxReload
Systemd
NativeNode
NativeJava
NativeGo
NativePython
```

Capability 结果：

```text
Supported
Unsupported
RequiresInstall
RequiresPrivilege
Unverified
```

---

# 28. 不支持必须明确说明

例如：

```text
OS:
Alpine

Init:
OpenRC

User selected:
Java Native Service
```

如果 Native Java Strategy 当前依赖 systemd：

```text
Unsupported

原因：
当前策略依赖 systemd，
此服务器使用 OpenRC。

建议：
Docker
Docker Compose
自定义 OpenRC Workflow
```

---

# 29. 软件安装

用户选择：

```text
Nginx
```

如果未安装：

```text
Capability Engine
↓
判断是否支持自动安装
```

显示：

```text
Nginx 未安装

○ 自动安装
○ 手动处理
○ 使用 Docker Nginx
```

---

# 30. Package Manager Adapter

不允许硬编码：

```text
apt install
```

实现：

```text
AptAdapter
DnfAdapter
YumAdapter
ApkAdapter
PacmanAdapter
ZypperAdapter
```

---

# 31. Init Adapter

```text
SystemdAdapter
OpenRcAdapter
WindowsServiceAdapter
```

---

# 32. Docker

Server Workspace Docker 页面：

```text
Containers
Images
Compose
Networks
Volumes
Registry
Logs
```

---

# 33. Docker 状态判断

不能只：

```text
command -v docker
```

还需：

```text
docker version
docker info
docker compose version
```

区分：

```text
CLI Missing
Daemon Down
Permission Denied
Ready
```

---

# 34. Nginx

Nginx 页面：

```text
Sites
Upstreams
Configs
Certificates
Logs
Snapshots
```

修改 Nginx：

```text
Backup
↓
Generate
↓
nginx -t
↓
Reload
```

验证失败：

```text
禁止 Reload
```

---

# 35. Project Management

Project 是 SSH 上层业务对象。

项目可以关联：

```text
一个服务器
多个服务器
服务器组
```

---

# 36. 项目类型由用户选择

项目创建：

```text
前端
后端
全栈
Worker
定时任务
Docker
Docker Compose
静态项目
基础设施
自定义
```

系统可扫描源码并推荐。

但：

```text
selected_project_type
```

必须由用户确认。

---

# 37. Source Provider

用户选择：

```text
Git
LocalDirectory
RemoteDirectory
ExistingArtifact
DockerRegistry
None
```

Git 不是强制。

---

# 38. Git

支持：

```text
GitHub
GitLab
Gitea
Generic Git
Local Git
```

能力：

```text
clone
fetch
pull
branch
tag
commit
status
diff
checkout
```

---

# 39. Environment

项目支持：

```text
Development
Test
Staging
Production
Custom
```

不同环境可以：

```text
不同服务器
不同 Config
不同 Dependencies
不同 Workflow
不同 Domain
不同 Deployment Profile
```

---

# 40. Config

配置必须区分：

```text
BuildTime
Runtime
Reload
Restart
```

例如：

前端：

```text
VITE_API_URL
= BuildTime
```

后端：

```text
DATABASE_URL
= Runtime
```

---

# 41. Config Source

```text
Literal
Secret
ProjectReference
DependencyReference
EnvironmentReference
File
Generated
AIProposed
```

---

# 42. Project Relations

例如：

```text
WEB.production
    ↓ API
API.production
```

关系类型：

```text
API
Database
Redis
MQ
Search
Storage
WebSocket
Custom
```

---

# 43. 前端项目模型

典型：

```text
React
Vue
Vite
Angular
Static
```

主要关注：

```text
Build Runtime
Package Manager
Build Command
Artifact
API Config
Nginx
Domain
SSL
```

---

# 44. 前端默认部署方式

用户可以选择：

```text
Nginx Static
Docker
Docker Compose
Existing Artifact
Custom
```

系统给可用性判断。

---

# 45. 前端 Static Deploy

推荐：

```text
/opt/apps/web/
releases/
current
```

流程可以是：

```text
Build
↓
Artifact
↓
Upload
↓
Create Release
↓
Switch Current
↓
HTTP Health
```

但 Workflow 不是固定步骤。

---

# 46. 后端项目模型

后端：

```text
Node
Java
Go
Python
Rust
.NET
Other
```

后端还需要：

```text
Runtime
Port
Process
Dependencies
Secrets
Migration
Health
Restart Strategy
```

---

# 47. 后端 Dependencies

支持：

```text
PostgreSQL
MySQL
MariaDB
MongoDB
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

# 48. Dependency 不自动安装

数据库 / Redis / ES 等重型服务必须：

```text
用户明确选择
```

例如：

```text
PostgreSQL

○ 使用现有
○ Docker 部署
○ Native 安装
○ 外部托管
```

系统只判断：

```text
哪些选项可用
```

---

# 49. Dependency Health

部署后端前检查：

```text
Database
Redis
ES
MQ
External API
```

Production 默认：

```text
Required dependency fail
→ Block
```

---

# 50. 配置和依赖关联

例如：

```text
DATABASE_URL
→ PostgreSQL.primary

REDIS_URL
→ Redis.primary

ELASTICSEARCH_URL
→ Elasticsearch.search
```

---

# 51. Secret

例如：

```text
DB_PASSWORD
JWT_SECRET
REDIS_PASSWORD
API_KEY
```

SQLite：

```text
secret_reference
```

真实值放 OS Keyring。

---

# 52. Migration

后端支持独立：

```text
DatabaseMigration Node
```

例如：

```text
Prisma
Flyway
Liquibase
Django
Alembic
Custom
```

Migration 和应用部署不是同一个动作。

---

# 53. Workflow Engine

项目部署流程绝不能固定：

```text
1 → 2 → 3 → 4
```

必须：

```text
nodes
+
edges
```

允许：

```text
2 → 5
3 → 6
```

---

# 54. Workflow

```rust
pub struct Workflow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub version: u32,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
}
```

---

# 55. Workflow Node

第一阶段支持：

```text
GitClone
GitFetch
GitPull
GitCheckout

InstallDependencies
Build
Test

UseExistingArtifact
CreateArtifact

Upload
Download

ResolveConfig
CheckDependencies

DockerBuild
DockerPush
DockerPull
DockerRun
DockerCompose

NginxGenerate
NginxValidate
NginxReload

ReleaseCreate
ReleaseSwitch

SystemdStart
SystemdStop
SystemdRestart
SystemdReload

DatabaseMigration

HealthCheck

Approval
RollbackPoint

LocalCommand
RemoteCommand
CustomScript
```

---

# 56. Workflow 操作

用户可以：

```text
运行全部
运行单节点
从这里运行
运行到这里
跳过
禁用
重新运行失败节点
```

---

# 57. Node Input / Output

例如：

```text
Build
```

输出：

```text
artifact
```

Upload：

```text
input = artifact
```

如果用户从 Upload 开始：

系统检查：

```text
是否已有 artifact
```

没有则阻止执行。

---

# 58. Workflow Template

内置：

```text
Frontend Nginx
Frontend Docker
Node systemd
Java Jar
Go Binary
Python Service
Docker
Docker Compose
Existing Artifact
Custom
```

用户基于模板修改。

---

# 59. Workflow Version

每次修改流程：

```text
Workflow Version +1
```

Deployment Snapshot 保存：

```text
workflow_version
```

---

# 60. Build

Build 和 Deploy 必须分开。

支持：

```text
Local Build
Remote Build
Docker Build
External CI
No Build
```

---

# 61. Artifact

Artifact：

```text
Static Directory
Zip
Tar
Jar
Binary
Docker Image
Docker Digest
Custom
```

必须保存：

```text
checksum
commit
build id
```

---

# 62. Build Once, Deploy Many

推荐：

```text
Artifact
↓
Test
↓
Staging
↓
Production
```

Production 不重新 Build。

---

# 63. Deployment Strategy

用户选择：

```text
Nginx Static
Docker
Docker Compose
Native Service
Custom
```

系统判断是否支持。

---

# 64. Frontend Deployment

前端通常：

```text
BuildTime Config
Static Artifact
Atomic Release
HTTP Health
```

---

# 65. Backend Deployment

后端通常：

```text
Runtime Config
Dependency Health
Migration(optional)
Process Start
Port
HTTP Health
```

---

# 66. Native Backend

支持：

```text
Node + systemd
Java + systemd
Go + systemd
Python + systemd
Rust binary + systemd
```

以后：

```text
OpenRC
Windows Service
```

---

# 67. Docker Backend

典型：

```text
Docker Build
↓
Push
↓
Remote Pull
↓
Resolve Env
↓
Start New
↓
Health
↓
Promote
```

---

# 68. Docker Compose

Compose 可能：

```text
API
Worker
Redis
DB
Nginx
```

用户选择：

```text
Dependency ManagedByCompose
```

或者：

```text
External Dependency
```

---

# 69. Availability Mode

不是所有项目都有“热更新”。

定义：

```text
Restart
GracefulReload
AtomicSwitch
Rolling
BlueGreen
```

---

# 70. 前端热发布

默认：

```text
AtomicSwitch
```

---

# 71. Nginx 配置

默认：

```text
GracefulReload
```

---

# 72. systemd

默认：

```text
Restart
```

如果程序本身支持 reload：

```text
GracefulReload
```

---

# 73. Docker Single Container

默认：

```text
Restart
```

可选：

```text
BlueGreen
```

---

# 74. 多服务器

Deployment Target：

```text
SingleServer
MultipleServers
ServerGroup
```

---

# 75. Multi Server Mode

```text
Parallel
Rolling
BlueGreen
ManualBatch
```

---

# 76. Health Check

支持：

```text
Process
Port
HTTP
HTTPS
DockerHealth
Command
Database
Redis
Elasticsearch
Composite
```

---

# 77. Deployment Success

不能：

```text
Exit Code = 0
=> Success
```

必须：

```text
Execution Success
+
Health Check Success
```

---

# 78. Auto Rollback

可以配置：

```text
auto_rollback_on_health_failure
```

Production 推荐开启。

---

# 79. Deployment Snapshot

每次成功部署保存：

```text
Project
Environment
Git Commit
Artifact
Workflow Version
Resolved Config
Dependency Snapshot
Server Fingerprint
Docker Digest
Nginx Config
Compose Snapshot
systemd Snapshot
Migration State
Health Result
```

---

# 80. Rollback

前端：

```text
Switch current
```

Docker：

```text
previous digest
```

Native：

```text
previous release
restart
```

Nginx：

```text
restore snapshot
validate
reload
```

数据库：

```text
默认不自动 down migration
```

---

# 81. CI/CD

SSH 工具本身不需要拥有云端后台。

支持：

```text
Desktop Pipeline
GitHub Actions
GitLab CI
Jenkins
Gitea
External CI
```

---

# 82. Desktop Pipeline

客户端运行期间：

```text
Git
Build
Test
Deploy
```

客户端退出后：

```text
不承担持续在线 Webhook Server
```

---

# 83. External CI

例如 GitHub Actions：

```text
Build
↓
Artifact
↓
Deploy
```

SSH 工具可以：

```text
触发
查看状态
关联项目
登记部署
```

---

# 84. AI 的正确位置

AI 应首先服务：

```text
SSH
Terminal
Logs
Server Diagnosis
```

然后才是：

```text
Project
Build
Deployment
```

---

# 85. Terminal AI

用户选中：

```text
permission denied
```

操作：

```text
解释错误
分析原因
生成修复建议
```

---

# 86. Command AI

用户：

```text
查一下 8080 是哪个程序
```

AI 推荐：

```text
ss -lntp | grep :8080
```

默认：

```text
只展示
```

用户点击：

```text
运行
```

才进入 Rust Risk Engine。

---

# 87. Log AI

用户选择：

```text
nginx error log
docker logs
systemd journal
```

AI：

```text
分析根因
```

---

# 88. AI Project Advisor

可以：

```text
扫描源码
推荐项目类型
推荐 Workflow
发现环境变量
发现 Dependency
```

但用户确认。

---

# 89. AI Deployment Advisor

输入：

```text
User Selection
ServerFacts
Capabilities
Project Config
Dependencies
Workflow
```

只输出：

```text
Recommendation
Warnings
Missing Config
Risk
```

---

# 90. AI 不直接执行

固定：

```text
AI Proposal
↓
User Apply / Run
↓
Rust Validation
↓
Risk Engine
↓
Execution
```

---

# 91. Local Login

用户体系只存本地。

SQLite：

```text
users
```

密码：

```text
Argon2id
```

不需要：

```text
Account Server
JWT Server
Cloud User DB
```

---

# 92. 用户数据

全部本机：

```text
Servers
Projects
Configs
History
Deployments
Settings
```

---

# 93. SQLite 表建议

```text
users

servers
server_groups
server_tags
server_facts
server_capabilities

credentials
known_hosts

ssh_sessions
command_history
quick_commands
port_forwards

file_transfers

projects
project_environments
project_relations

service_dependencies
dependency_connections

config_definitions
config_values
config_relations
config_snapshots

git_sources
git_snapshots

workflows
workflow_versions
workflow_nodes
workflow_edges
workflow_runs
workflow_node_runs

build_profiles
builds
artifacts

deployment_profiles
deployments
deployment_snapshots

health_profiles
health_runs

nginx_instances
nginx_configs
nginx_snapshots

docker_hosts
docker_snapshots

migration_profiles
migration_runs

ci_integrations

ai_providers
ai_conversations

audit_logs

settings
```

---

# 94. Rust 目录

```text
src-tauri/src/

commands/
    ssh.rs
    server.rs
    file.rs
    project.rs
    build.rs
    workflow.rs
    deploy.rs
    docker.rs
    nginx.rs
    ai.rs

domain/
    ssh/
    server/
    credential/
    file/
    project/
    environment/
    dependency/
    config/
    relation/
    workflow/
    build/
    artifact/
    deployment/
    health/
    version/

services/
    ssh_service.rs
    server_service.rs
    file_service.rs
    project_service.rs
    build_service.rs
    workflow_service.rs
    deployment_service.rs
    docker_service.rs
    nginx_service.rs
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

adapters/
    package_manager/
    init_system/
    docker/
    nginx/
    deployment/
    dependency/

infrastructure/
    ssh/
    sftp/
    sqlite/
    keyring/
    git/
    filesystem/
    process/
    http/

ai/
    provider/
    gateway/
    terminal_assistant/
    project_advisor/
    deployment_advisor/
    failure_analyzer/

security/
    known_hosts/
    permissions/
    secrets/
    risk/
    approval/
    audit/
```

---

# 95. React 页面

```text
SSH
Servers
ServerWorkspace
Files
Projects
ProjectDetail
Builds
Workflows
Deployments
Docker
Nginx
Tasks
AI
Settings
```

---

# 96. SSH 首页

建议首页：

```text
Recent Servers
Favorites
Groups
Active Sessions
Recent Commands
Quick Connect
```

---

# 97. Quick Connect

输入：

```text
user@host:22
```

然后：

```text
Credential
ProxyJump
Save Server(optional)
```

快速进入 Terminal。

---

# 98. Server Workspace UI

```text
Server-Prod-01
Ubuntu 24.04
192.168.1.20

[Terminal] [Files] [Docker] [Nginx]

Tabs:
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

---

# 99. Project Detail UI

前端：

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

后端：

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

# 100. 现代 SSH 工具必须避免的设计

不允许：

```text
把 Terminal 做成次级功能
```

不允许：

```text
用户必须先创建项目才能 SSH
```

不允许：

```text
项目没有配置时不能正常使用 SSH
```

不允许：

```text
所有服务器操作都必须通过 Project
```

SSH 本身必须完整独立可用。

---

# 101. 项目功能必须是可选增强

用户可以：

```text
只把它当 SSH 工具
```

完全不创建项目。

也可以：

```text
SSH
+
Project
+
Deployment
```

逐渐启用高级能力。

---

# 102. Server 与 Project 是多对多

一个 Server：

```text
Web
API
Worker
Redis
```

多个项目。

一个项目：

```text
API
```

也可能部署到：

```text
API-01
API-02
API-03
```

所以：

```text
ProjectServerRelation
```

必须是多对多。

---

# 103. 系统检测和项目选择边界

系统自动：

```text
服务器 Facts
Capabilities
```

用户选择：

```text
Project Type
Build Type
Deployment Type
Dependency Type
Workflow
```

系统推荐：

```text
Project suggestions
Workflow suggestions
Deployment suggestions
```

---

# 104. Workflow 不固定

必须支持：

```text
A → B → D
A → C → D
```

和：

```text
B → E
C → F
```

底层必须 DAG 化。

---

# 105. 风险控制

危险动作：

```text
rm
reboot
shutdown
iptables
firewall
migration
delete volume
delete container data
overwrite config
```

通过：

```text
Risk Engine
```

---

# 106. SSH 命令执行权限

AI / Quick Command / Script / User Command 都统一走：

```text
CommandExecutionService
```

记录：

```text
source
risk
server
command
result
```

---

# 107. 任务中心

所有：

```text
Transfer
Build
Deploy
Rollback
Docker Pull
Git Clone
```

统一 Task Center。

---

# 108. Task 状态

```text
Pending
Running
WaitingApproval
Paused
Succeeded
Failed
Cancelled
RollingBack
```

---

# 109. Audit

所有关键操作记录：

```text
SSH Login
Command
File Upload
File Edit
Docker Operation
Nginx Change
Build
Deploy
Rollback
AI Proposed Action
```

---

# 110. MVP 开发顺序

## v0.1 SSH

```text
Server CRUD
Credential
known_hosts
SSH Connect
Terminal
Multi Tab
Reconnect
KeepAlive
History
```

---

## v0.2 Modern SSH

```text
Split Terminal
SFTP
Transfer
Remote Edit
Port Forward
ProxyJump
Quick Command
Server Group / Tag
```

---

## v0.3 Server Workspace

```text
Environment Inspector
Capability
Processes
Services
Ports
Docker Basic
Nginx Basic
Logs
```

---

## v0.4 Project

```text
Project
Environment
Config
Relation
Dependency
Git
```

---

## v0.5 Build / Workflow

```text
Workflow DAG
Build
Artifact
Node Run
Skip / Start From / Run To
```

---

## v0.6 Deploy

```text
Frontend Nginx
Docker
Docker Compose
Native Backend
Health
Snapshot
Rollback
```

---

## v0.7 CI/CD

```text
GitHub Actions
GitLab
External CI
Promotion
```

---

## v0.8 AI

```text
Terminal AI
Log AI
Project Advisor
Deployment Advisor
Failure Analyzer
```

---

# 111. Cursor 硬性实现规则

1. SSH Core 为最高优先级。
2. 项目系统不得依赖云端业务服务器。
3. 用户可完全不使用 Project 功能。
4. React 不得直接执行本机或远程 Shell。
5. Host Key 不得自动忽略。
6. Secret 不得明文 SQLite。
7. Terminal 实时流不得使用普通 invoke 等待返回。
8. 长任务统一进入 Task Engine。
9. ServerFacts 必须自动探测。
10. 项目类型必须以用户选择为正式值。
11. 系统项目扫描只作为 Recommendation。
12. Deployment Type 由用户选择。
13. Capability Engine 负责禁用不支持的选项。
14. 不得硬编码 apt。
15. 不得硬编码 systemd。
16. 不得假设 Docker 存在。
17. 前端与后端 Deployment Model 必须分开。
18. 后端必须支持 Dependency Model。
19. DB / Redis / ES 不得未经用户选择自动安装。
20. Workflow 必须 Node + Edge。
21. Workflow 必须可跳步。
22. Workflow 必须可单节点执行。
23. Build 与 Deploy 必须分开。
24. Production 必须 Snapshot。
25. Deployment Success 必须经过 Health Check。
26. Rollback 不等同于 git checkout。
27. DB Migration 必须独立。
28. AI 不得直接执行命令。
29. 所有危险操作通过 Risk Engine。
30. 所有关键操作可审计。

---

# 112. 一句话架构结论

> **这是一个以 SSH 为内核的现代化桌面运维工具。**

底层：

```text
SSH
SFTP
Server
Terminal
```

中层：

```text
Server Workspace
Docker
Nginx
Process
Service
```

上层：

```text
Project
Build
Workflow
Deployment
CI/CD
```

智能层：

```text
AI
```

最终：

```text
SSH 是产品本体
项目部署是高级能力
AI 是辅助能力
```

而不是反过来。
