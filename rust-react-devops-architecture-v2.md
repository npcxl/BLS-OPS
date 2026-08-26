# Rust + React 桌面 DevOps 平台总体架构设计文档 v2

> 技术栈：Rust + Tauri 2 + React + TypeScript + SQLite  
> 产品定位：本地化、项目中心化、可视化、可组合流程的一键构建与自动化部署平台  
> 核心思想：**用户选择意图，系统判断环境并自动执行；AI 只负责推荐、补全、分析与诊断。**  
> 适用对象：Cursor / 架构开发人员 / 前后端开发人员 / 运维人员

---

# 1. 产品目标

本项目不是 SSH 客户端，也不是“把 Shell 命令做成按钮”。

系统真正需要解决：

```text
项目管理
+
项目配置
+
项目关联
+
构建管理
+
环境依赖
+
自动部署
+
CI/CD
+
版本管理
+
回滚
+
AI 辅助
```

最终目标：

```text
用户创建项目
↓
选择项目类型
↓
配置源码 / 构建 / 部署方式
↓
关联服务器
↓
关联数据库 / Redis / Elasticsearch / MQ 等依赖
↓
配置环境变量
↓
选择或组合 Workflow
↓
系统判断目标环境是否支持
↓
自动执行
↓
健康检查
↓
记录版本
↓
支持回滚
```

---

# 2. 核心产品原则

## 2.1 用户决定“我要什么”

以下信息由用户明确选择：

```text
项目类型
源码来源
项目环境
构建方式
构建位置
部署方式
目标服务器
依赖服务
环境变量来源
健康检查方式
Workflow 模板
Workflow 节点关系
回滚策略
CI/CD 触发方式
```

系统可以推荐，但不能擅自决定。

---

## 2.2 系统负责“怎么实现”

以下信息应自动检测：

```text
服务器 OS
OS Version
CPU Architecture
Kernel
Package Manager
Init System
Docker
Docker Compose
Nginx
Node
Java
Python
Go
磁盘
内存
端口
权限
防火墙
SELinux / AppArmor
```

例如用户选择：

```text
部署方式：Docker
```

系统负责判断：

```text
服务器是否有 Docker？
↓
没有
↓
当前 OS 是否支持自动安装？
↓
支持
↓
显示自动安装方案
```

---

## 2.3 AI 不是最终决策者

AI 可以：

```text
推荐项目类型
推荐 Workflow
分析 Dockerfile
分析 Compose
分析失败日志
生成 Nginx 草案
生成环境变量建议
发现可能的项目依赖
分析修改影响
```

AI 不可以：

```text
直接 SSH 执行
直接修改服务器
直接删除文件
直接重启生产服务
直接修改数据库
```

所有实际执行必须经过：

```text
Rust Engine
↓
Capability Validation
↓
Risk Validation
↓
Workflow Engine
↓
Execution
↓
Audit
```

---

# 3. 前端与后端必须使用不同部署模型

这是整个架构的基础。

前端项目和后端项目不能共用一个固定部署流程。

---

# 4. 前端项目部署特点

典型前端：

```text
React
Vue
Vite
Angular
Static Site
```

核心流程通常是：

```text
源码
↓
依赖安装
↓
Build
↓
生成静态 Artifact
↓
发布静态文件
↓
Nginx / CDN
```

前端最终产物一般：

```text
dist/
build/
out/
```

前端运行时通常不需要：

```text
Node Runtime
Redis
Database
Elasticsearch
```

生产服务器通常只需要：

```text
Nginx
静态文件
SSL
反向代理
```

---

# 5. 后端项目部署特点

典型后端：

```text
Node
Java
Go
Python
Rust
.NET
```

后端部署通常存在：

```text
Runtime
Process Manager
Ports
Database
Redis
Elasticsearch
MQ
Object Storage
Service Discovery
Environment Variables
Secrets
Database Migration
Health Check
```

例如一个后端 API：

```text
API Service
├── PostgreSQL
├── Redis
├── Elasticsearch
├── RabbitMQ
├── MinIO
└── SMTP
```

因此后端 Deployment 必须先解析依赖，而不是直接启动程序。

---

# 6. 后端依赖模型

定义：

```text
ServiceDependency
```

支持：

```text
Database
Redis
Elasticsearch
MessageQueue
ObjectStorage
ExternalAPI
SMTP
Service
Custom
```

---

# 7. 数据库类型

内置枚举：

```text
PostgreSQL
MySQL
MariaDB
SQL Server
Oracle
SQLite
MongoDB
Custom
```

注意：

```text
SQLite
```

属于应用本地依赖，不一定属于远程基础设施。

---

# 8. Redis

Redis Dependency 配置：

```text
Host
Port
Database Index
Username
Password
TLS
Sentinel
Cluster
```

环境变量可能：

```text
REDIS_HOST
REDIS_PORT
REDIS_PASSWORD
REDIS_DB
REDIS_URL
```

---

# 9. Elasticsearch

配置：

```text
Hosts
Username
Password
API Key
TLS
Index Prefix
Version
```

环境变量可能：

```text
ELASTICSEARCH_URL
ES_HOST
ES_USERNAME
ES_PASSWORD
ES_INDEX_PREFIX
```

系统需要检测版本兼容。

不能假设：

```text
ES 7
=
ES 8
```

---

# 10. Message Queue

支持：

```text
RabbitMQ
Kafka
RocketMQ
NATS
Redis Streams
Custom
```

---

# 11. Object Storage

支持：

```text
S3
MinIO
Aliyun OSS
Tencent COS
Custom S3 Compatible
```

配置：

```text
Endpoint
Bucket
Region
Access Key
Secret Key
Public URL
```

Secret 必须使用 SecretRef。

---

# 12. 服务依赖

一个后端项目也可以依赖另一个项目。

例如：

```text
Order API
↓
User API
```

这种应该：

```text
ProjectRelation
```

而不是普通字符串 URL。

---

# 13. ProjectRelation

```rust
pub struct ProjectRelation {
    pub source_project_id: String,
    pub target_project_id: String,
    pub relation_type: RelationType,
    pub environment_mapping: EnvironmentMapping,
}
```

例如：

```text
WEB.production
    ↓ API
API.production
```

---

# 14. ServiceDependency

```rust
pub struct ServiceDependency {
    pub id: String,
    pub project_id: String,
    pub environment_id: String,

    pub dependency_type: DependencyType,

    pub provider: DependencyProvider,

    pub connection: DependencyConnection,

    pub required: bool,

    pub health_check: Option<HealthCheckProfile>,
}
```

---

# 15. 环境变量模型

后端项目不能只用：

```text
.env
```

系统内部应该使用：

```text
ConfigDefinition
+
ConfigValue
+
ConfigSource
+
SecretRef
```

---

# 16. Config Definition

例如：

```text
DATABASE_URL
REDIS_URL
ELASTICSEARCH_URL
JWT_SECRET
S3_ENDPOINT
S3_BUCKET
```

字段定义：

```rust
pub struct ConfigDefinition {
    pub id: String,
    pub key: String,
    pub data_type: ConfigDataType,
    pub required: bool,
    pub secret: bool,
    pub description: Option<String>,
}
```

---

# 17. ConfigSource

支持：

```text
Literal
Secret
ProjectReference
DependencyReference
EnvironmentReference
Generated
File
AIProposed
```

---

# 18. Dependency Reference

例如：

```text
DATABASE_URL
```

不要直接保存：

```text
postgres://user:pass@10.0.0.5:5432/app
```

而是：

```text
${dependency.primary_database.connection_url}
```

系统运行时解析。

---

# 19. Secret 引用

例如数据库：

```text
Host:
db-prod-01

Username:
app

Password:
secret://credential/db-prod-password
```

最终 Build / Deploy 时才生成：

```text
DATABASE_URL
```

---

# 20. 配置关系

例如：

```text
WEB.VITE_API_URL
    ↓
API.PUBLIC_URL
```

后端：

```text
API.DATABASE_URL
    ↓
PostgreSQL.primary.connection
```

```text
API.REDIS_URL
    ↓
Redis.primary.connection
```

```text
SearchService.ELASTICSEARCH_URL
    ↓
Elasticsearch.search-cluster.connection
```

---

# 21. 配置修改影响分析

修改：

```text
PostgreSQL Host
```

系统应该计算：

```text
影响项目：
API
Worker
Admin API

影响环境：
Production

需要：
更新 runtime env
重启 API
重启 Worker
```

如果是前端：

```text
VITE_API_URL
```

修改后：

```text
需要重新 Build
```

这两种必须区分。

---

# 22. 配置生效类型

每一个 ConfigDefinition 可以定义：

```rust
pub enum ApplyMode {
    BuildTime,
    Runtime,
    Reload,
    Restart,
}
```

例如：

```text
VITE_API_URL
= BuildTime
```

修改需要：

```text
重新构建前端
```

而：

```text
DATABASE_URL
= Runtime
```

修改可能：

```text
更新配置
+
重启后端
```

---

# 23. 项目类型用户枚举

用户创建项目时主动选择：

```text
前端
后端
全栈
静态站点
Docker
Docker Compose
Worker
定时任务
基础设施
自定义
```

系统可以：

```text
检测 package.json / pom.xml / Dockerfile
```

然后推荐。

但正式值由用户确认。

---

# 24. 后端类型进一步选择

例如：

```text
后端
```

然后：

```text
Node
Java
Go
Python
Rust
.NET
Other
```

框架：

```text
NestJS
Express
Spring Boot
FastAPI
Django
Gin
Axum
Actix
Other
```

框架可以：

```text
系统推荐
+
用户确认
```

---

# 25. Source Provider

项目源码不是必须 Git。

支持：

```text
Git
LocalDirectory
RemoteDirectory
ExistingArtifact
DockerRegistry
None
```

---

# 26. 构建方式

用户选择：

```text
本机构建
远程服务器构建
独立构建服务器
Docker 构建
外部 CI 构建
不构建
```

---

# 27. Artifact 类型

前端：

```text
StaticDirectory
Zip
Tar
```

后端：

```text
Jar
Binary
NodeBundle
PythonPackage
DockerImage
DockerImageDigest
ContainerBundle
Custom
```

---

# 28. Workflow 必须是图，不是固定步骤

底层：

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

允许跳过。

允许单独运行节点。

允许从某节点开始。

允许运行到某节点结束。

允许分支。

---

# 29. Workflow

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

# 30. 前端 Workflow 示例

## 标准 Nginx

```text
Git Pull
↓
Install Dependencies
↓
Build
↓
Create Artifact
↓
Upload
↓
Create Release
↓
Switch Current
↓
HTTP Health Check
```

---

# 31. 前端快速发布

已有 dist：

```text
Use Existing Artifact
↓
Upload
↓
Create Release
↓
Switch Current
↓
Health Check
```

---

# 32. 前端 Docker

```text
Git
↓
Build Frontend
↓
Docker Build
↓
Docker Push
↓
Remote Pull
↓
Start Container
↓
Health Check
```

---

# 33. 后端 Node Native Workflow

```text
Git Pull
↓
Install
↓
Build
↓
Create Release
↓
Resolve Runtime Config
↓
Check Dependencies
↓
Upload
↓
Install Production Dependencies
↓
Switch Release
↓
Restart systemd
↓
Health Check
```

---

# 34. Java Workflow

```text
Git
↓
Maven / Gradle Build
↓
Jar Artifact
↓
Resolve Runtime Config
↓
Check Database / Redis / ES
↓
Run Migration(optional)
↓
Upload Jar
↓
Switch Release
↓
Restart systemd
↓
Health Check
```

---

# 35. Go Workflow

```text
Git
↓
Build Binary
↓
Architecture Check
↓
Resolve Config
↓
Check Dependencies
↓
Upload
↓
Switch Release
↓
Restart Service
↓
Health Check
```

---

# 36. Python Workflow

```text
Git
↓
Build / Package
↓
Upload
↓
Create venv
↓
Install Requirements
↓
Resolve Runtime Config
↓
Check Dependencies
↓
Migration(optional)
↓
Restart Gunicorn/Uvicorn
↓
Health Check
```

---

# 37. Docker 后端 Workflow

```text
Git
↓
Docker Build
↓
Push Registry
↓
Resolve Runtime Config
↓
Check Dependencies
↓
Remote Pull
↓
Start New Container
↓
Health Check
↓
Promote
↓
Stop Old Container
```

---

# 38. Docker Compose 后端

Compose 可能包含：

```text
API
PostgreSQL
Redis
Elasticsearch
Worker
Nginx
```

用户需要选择：

```text
全部由 Compose 管理
```

或者：

```text
数据库 / Redis 使用外部服务
```

不能自动假设全部启动。

---

# 39. Compose Dependency Mode

```rust
pub enum DependencyMode {
    ManagedByWorkflow,
    External,
    ExistingServerService,
    ExistingDockerService,
}
```

---

# 40. 数据库部署选择

如果项目需要 PostgreSQL：

用户应该看到：

```text
数据库：

○ 使用现有数据库
○ Docker 部署 PostgreSQL
○ 在服务器安装 PostgreSQL
○ 外部托管数据库
```

系统根据 ServerFacts 判断：

```text
哪些可用
```

而不是自动安装数据库。

---

# 41. Redis 部署选择

```text
Redis：

○ 使用现有
○ Docker
○ Native
○ External
```

---

# 42. Elasticsearch 特殊处理

ES 比 Redis 更复杂。

部署前必须检查：

```text
内存
JVM
磁盘
vm.max_map_count
架构
版本
```

如果机器：

```text
1 GB RAM
```

系统应该：

```text
不推荐自动部署 Elasticsearch
```

提示：

```text
当前服务器内存不足，不建议部署 Elasticsearch。
建议使用外部 ES 或更高配置服务器。
```

---

# 43. 数据库 Preflight

例如 PostgreSQL：

```text
network reachable
port
credentials
database exists
permissions
version
TLS
```

---

# 44. Redis Preflight

```text
PING
AUTH
DB select
TLS
version
```

---

# 45. Elasticsearch Preflight

```text
HTTP reachable
auth
cluster health
version
index permission
```

---

# 46. Dependency Health Engine

所有后端服务启动前：

```text
required dependencies
```

进行健康检查。

例如：

```text
PostgreSQL   OK
Redis        OK
ES           FAIL
```

项目策略：

```text
Block deploy
```

或者：

```text
Warn only
```

由用户设置。

---

# 47. Deployment Dependency Policy

```rust
pub enum DependencyFailurePolicy {
    Block,
    Warn,
    Ignore,
}
```

Production 默认：

```text
Block
```

---

# 48. Database Migration

后端常见：

```text
Prisma migrate
TypeORM migration
Flyway
Liquibase
Django migrate
Alembic
Custom SQL
```

Migration 必须作为独立 Workflow Node。

---

# 49. Migration Node

```text
DatabaseMigration
```

配置：

```text
command
timeout
approval
rollback_supported
```

---

# 50. Migration 风险

Production 默认：

```text
Migration = High Risk
```

需要：

```text
显示 SQL / Command
显示目标数据库
显示项目
显示环境
```

---

# 51. 数据库版本无法简单回滚

必须明确：

```text
应用版本回滚
≠
数据库版本回滚
```

Deployment Snapshot 中记录：

```text
migration_version
migration_state
```

但默认不自动执行：

```text
down migration
```

---

# 52. 启动顺序

后端可能有：

```text
Database
↓
Redis
↓
ES
↓
API
↓
Worker
↓
Frontend
```

但流程不固定。

Workflow Graph 负责。

---

# 53. 并行启动

可以：

```text
PostgreSQL ─┐
Redis ──────┼→ API
ES ─────────┘
```

只要依赖健康后：

```text
API
```

才能启动。

---

# 54. Workflow Edge 条件

```rust
pub struct WorkflowEdge {
    pub source: NodeId,
    pub target: NodeId,
    pub condition: Option<WorkflowCondition>,
}
```

例如：

```text
dependency.redis.health == success
```

---

# 55. Node 输入输出

每个节点必须有 typed input / output。

例如：

```text
DockerBuild
```

输出：

```text
image_tag
image_digest
```

RemotePull 输入：

```text
image_digest
```

---

# 56. Workflow Context

```rust
pub struct WorkflowContext {
    pub project: ProjectSnapshot,
    pub environment: EnvironmentSnapshot,
    pub configs: ResolvedConfigSnapshot,

    pub servers: Vec<ServerFacts>,
    pub dependencies: Vec<ResolvedDependency>,

    pub node_outputs: HashMap<NodeId, NodeOutput>,
}
```

---

# 57. 多服务器

后端 Production 可能：

```text
API-01
API-02
API-03
```

Deployment Target 支持：

```text
Single
Multiple
ServerGroup
```

---

# 58. 多服务器发布方式

用户选择：

```text
全部并行
逐台滚动
蓝绿
手动批次
```

---

# 59. Rolling Deployment

例如：

```text
API-01
↓ health
API-02
↓ health
API-03
```

任一失败：

```text
停止后续发布
```

并根据策略：

```text
Rollback failed node
Rollback all
Manual
```

---

# 60. Blue-Green

适合：

```text
Docker Web Backend
```

流程：

```text
Blue running
↓
Deploy Green
↓
Dependency check
↓
Green health
↓
Nginx switch
↓
Observe
↓
Stop Blue
```

---

# 61. Frontend Atomic Switch

前端默认：

```text
AtomicSwitch
```

目录：

```text
/opt/apps/web/
releases/
current
```

这样无需“重启前端”。

---

# 62. 前端环境变量

注意：

Vite / React 环境变量通常在 Build Time 注入。

因此：

```text
VITE_API_URL
```

修改后：

```text
必须 rebuild
```

不能只修改服务器 `.env`。

---

# 63. 后端环境变量

后端通常 Runtime 注入。

例如：

```text
DATABASE_URL
REDIS_URL
JWT_SECRET
```

可以：

```text
systemd EnvironmentFile
Docker env
Compose env
```

修改后：

```text
Restart / Reload
```

---

# 64. Environment Variable Renderer

系统应该支持：

```text
.env
systemd EnvironmentFile
Docker Env
Compose Env
JSON
YAML
TOML
Custom Template
```

---

# 65. Config Template

例如：

```text
application.yml
```

可以配置：

```text
template
```

系统把：

```text
${dependency.database.host}
```

渲染进去。

---

# 66. Secret 不写日志

Renderer 遇到 Secret：

```text
output file 可以写真实值
```

但：

```text
UI
Audit
Log
Snapshot
```

全部脱敏。

---

# 67. Environment

项目支持：

```text
Development
Test
Staging
Production
Custom
```

同一项目不同环境：

```text
不同服务器
不同数据库
不同 Redis
不同 ES
不同域名
不同 Workflow
```

---

# 68. Environment Mapping

前端：

```text
WEB.production
→ API.production
```

测试：

```text
WEB.test
→ API.test
```

不能只关联 Project。

必须关联：

```text
Project + Environment
```

---

# 69. Project Detail

页面：

```text
Overview
Configuration
Dependencies
Relations
Git
Build
Workflow
Deploy
CI/CD
Versions
Logs
```

---

# 70. Backend Dependency 页面

例如：

```text
Production Dependencies

PostgreSQL
Ready
db-prod-01:5432

Redis
Ready
redis-prod-01:6379

Elasticsearch
Warning
es-prod-01:9200

User API
Ready
https://user-api.internal
```

---

# 71. 依赖来源

每个 Dependency 显示：

```text
类型
来源
运行位置
版本
Health
被哪些 Config 使用
```

例如：

```text
Redis
External Server

Config:
REDIS_URL
CACHE_REDIS_URL
```

---

# 72. Infrastructure Project

数据库 / Redis / ES 也可以独立成为：

```text
Infrastructure Project
```

例如：

```text
Prod PostgreSQL
Prod Redis
Search Elasticsearch
```

这样可以：

```text
统一管理
统一部署
统一关系
统一版本
```

---

# 73. Infrastructure 项目类型

```text
PostgreSQL
MySQL
Redis
Elasticsearch
RabbitMQ
Kafka
MinIO
Nginx
Custom
```

---

# 74. Infrastructure Workflow

例如 Redis Docker：

```text
Check Server
↓
Docker Pull
↓
Prepare Volume
↓
Render Config
↓
Start Redis
↓
Health Check
↓
Register Dependency
```

---

# 75. Infrastructure 不是必须由本工具创建

可以：

```text
Existing External Service
```

只是保存：

```text
连接信息
健康状态
关系
```

---

# 76. Server Environment Inspector

系统自动：

```text
OS
Version
Arch
Package Manager
Init
Docker
Compose
Nginx
Runtime
Firewall
Security Modules
Disk
Memory
Ports
```

---

# 77. Capability Engine

用户选：

```text
Docker
```

Capability Engine 判断：

```text
DockerReady
DockerInstallSupported
DockerUnsupported
```

---

# 78. 用户枚举优先

比如后端部署方式：

```text
○ Docker
○ Docker Compose
○ Native Service
○ Existing Runtime
○ Custom
```

系统只负责：

```text
禁用不支持的选项
+
告诉原因
```

---

# 79. Option State

```rust
pub struct UserOption {
    pub id: String,
    pub label: String,

    pub enabled: bool,

    pub recommended: bool,

    pub reason: Option<String>,
}
```

---

# 80. 一键部署

用户已经配置：

```text
项目类型
Environment
Workflow
Target
Dependencies
Configs
```

才进入：

```text
一键部署
```

不是完全无配置自动猜。

---

# 81. Preflight

后端部署：

```text
Git valid
Build inputs valid
Runtime compatible
Target server reachable
Disk sufficient
Port free
Database healthy
Redis healthy
ES healthy
Secrets available
Migration configured
Artifact valid
```

---

# 82. 前端 Preflight

```text
Build runtime
Package manager
Config resolved
Artifact path
Nginx
Target path
Disk
Domain
SSL(optional)
```

---

# 83. Health Check

前端：

```text
HTTP
HTTPS
Static Asset
```

后端：

```text
Process
Port
HTTP
Database
Dependency
Composite
```

---

# 84. Composite Health

例如：

```text
systemd active
AND
port 8080
AND
GET /health = 200
AND
database ping = OK
```

---

# 85. Deployment Snapshot

必须记录：

```text
Git commit
Artifact
Workflow version
Resolved Config
Dependency Snapshot
Server Fingerprint
Docker Digest
Nginx Snapshot
Compose Snapshot
systemd Snapshot
Migration Version
Health Result
```

---

# 86. Dependency Snapshot

例如：

```text
PostgreSQL:
host=db-prod-01
port=5432
database=app
credential_ref=xxx

Redis:
host=redis-prod-01
port=6379
credential_ref=xxx
```

Secret 本体不保存。

---

# 87. 回滚

前端：

```text
Switch current
```

Docker：

```text
Restore previous digest
```

Native：

```text
Switch release
Restart
```

Config：

```text
Restore Config Snapshot
```

数据库：

```text
默认不自动 down migration
```

---

# 88. CI/CD

用户可以选择：

```text
Desktop Workflow
GitHub Actions
GitLab CI
Jenkins
External
```

---

# 89. CI/CD 不绑定固定流程

Pipeline 仍然：

```text
nodes
+
edges
```

比如：

```text
Git Push
↓
Build
↓
Test
↓
Docker Build
↓
Push
↓
Deploy Test
↓
Manual Approval
↓
Deploy Production
```

也可以：

```text
Git Tag
↓
Use Existing CI Artifact
↓
Production Deploy
```

---

# 90. Git

Git 是 Source Provider，不是强制依赖。

支持：

```text
GitHub
GitLab
Gitea
Generic Git
Local
```

---

# 91. Git 版本

每个 Deployment：

```text
branch
tag
commit
dirty
```

Production 默认：

```text
dirty = false
```

---

# 92. Build Once Deploy Many

推荐：

```text
Build Artifact
↓
Test
↓
Staging
↓
Production
```

Production 不重新 Build。

---

# 93. AI Deployment Advisor

输入：

```text
User Selection
Project Config
Workflow
ServerFacts
Dependencies
CapabilityMatrix
```

输出：

```text
推荐修改
风险
缺失配置
依赖问题
部署建议
```

---

# 94. AI Backend Analyzer

特别负责：

```text
分析 .env.example
分析 application.yml
分析 Docker Compose
分析 README
分析 connection string
分析服务依赖
```

可以推荐：

```text
此项目可能需要：
PostgreSQL
Redis
Elasticsearch
```

但：

```text
由用户确认
```

---

# 95. AI Environment Variable Assistant

例如读取：

```text
.env.example
```

发现：

```text
DATABASE_URL
REDIS_URL
ES_URL
JWT_SECRET
```

展示：

```text
建议关联：

DATABASE_URL
→ PostgreSQL Dependency

REDIS_URL
→ Redis Dependency

ES_URL
→ Elasticsearch Dependency

JWT_SECRET
→ Local Secret
```

用户：

```text
Apply
```

---

# 96. 用户可以完全手动

所有 AI 推荐都可以：

```text
忽略
```

平台没有 AI 也必须正常工作。

---

# 97. 数据库

本地 SQLite：

```text
users

projects
project_environments
project_relations

service_dependencies
dependency_connections

config_definitions
config_values
config_relations
config_snapshots

servers
server_facts
server_capabilities

git_sources
git_snapshots

build_profiles
builds
build_steps
artifacts

workflows
workflow_versions
workflow_nodes
workflow_edges
workflow_runs
workflow_node_runs

deployment_profiles
deployments
deployment_snapshots

health_profiles
health_runs

nginx_configs
nginx_snapshots

docker_configs
docker_snapshots

migration_profiles
migration_runs

credentials

ci_integrations
pipeline_runs

ai_providers
ai_conversations

audit_logs

settings
```

---

# 98. Rust 目录

```text
src-tauri/src/

domain/
    project/
    environment/
    relation/
    dependency/
    config/
    server/
    capability/
    source/
    git/
    build/
    artifact/
    workflow/
    deployment/
    health/
    migration/
    version/

services/
    project_service.rs
    dependency_service.rs
    config_service.rs
    server_service.rs
    build_service.rs
    workflow_service.rs
    deployment_service.rs
    version_service.rs

engines/
    environment_inspector/
    capability_engine/
    config_resolver/
    dependency_resolver/
    dependency_health/
    build_engine/
    workflow_engine/
    deployment_engine/
    health_engine/
    rollback_engine/
    migration_engine/
    risk_engine/

adapters/
    package_manager/
    init_system/
    docker/
    nginx/
    database/
    redis/
    elasticsearch/
    mq/
    object_storage/
    deployment/

infrastructure/
    sqlite/
    ssh/
    git/
    keyring/
    filesystem/
    process/
    http/

ai/
    provider/
    gateway/
    project_analyzer/
    workflow_advisor/
    config_advisor/
    failure_analyzer/

security/
    secrets/
    approval/
    audit/
```

---

# 99. React 页面

```text
Dashboard

Projects
ProjectDetail

Builds
Artifacts

Workflows

Deployments
Versions

Servers
ServerDetail

Dependencies
Infrastructure

Docker
Nginx

CI/CD

AI
Settings
```

---

# 100. 前端项目 UI

Project Detail：

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

Config：

```text
Build Variables
API References
Domain
Nginx
```

---

# 101. 后端项目 UI

Project Detail：

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

Dependencies 页面是后端重点。

---

# 102. 后端 Deploy 页面

展示：

```text
Runtime
Node 22

Server
API-PROD-01

Port
8080

Dependencies
PostgreSQL Ready
Redis Ready
Elasticsearch Ready

Migration
Prisma migrate deploy

Strategy
Docker Blue-Green

Health
GET /health
```

---

# 103. 一键部署 UX

```text
Project:
API

Environment:
Production

Workflow:
Production Docker v4

Targets:
API-01
API-02

Dependencies:
PostgreSQL   Ready
Redis        Ready
ES           Ready

Configs:
32 resolved
3 secret refs

Git:
main @ 8ac21e

Artifact:
api@sha256:xxx

Deployment:
Rolling

Migration:
Required
Manual approval

Health:
GET /health

[Start Deployment]
```

---

# 104. 不支持时必须明确告诉用户

例如：

```text
用户选择：
Native Java Service

服务器：
Alpine + OpenRC

当前 Strategy：
仅支持 systemd
```

返回：

```text
此部署方式当前不支持该服务器。

原因：
当前 Java Native Strategy 使用 systemd。

可选：
1. Docker
2. Docker Compose
3. 自定义 OpenRC Workflow
```

---

# 105. 自动化安装必须可控

例如用户选择：

```text
Nginx
```

没有 Nginx：

```text
Ubuntu 24.04
支持自动安装
```

UI：

```text
Nginx 未安装。

○ 自动安装
○ 使用已有 Docker Nginx
○ 手动处理
```

用户选择后系统执行。

---

# 106. 系统不能自动安装数据库这类重型基础设施

数据库 / Redis / ES：

```text
默认只推荐
```

用户明确选择：

```text
Native / Docker / External
```

之后才能执行。

---

# 107. 风险级别

```text
LOW
MEDIUM
HIGH
CRITICAL
```

例如：

```text
HTTP Health = LOW
Nginx reload = MEDIUM
Service restart = MEDIUM
Migration = HIGH
Delete Volume = CRITICAL
Drop Database = CRITICAL
```

---

# 108. AI 不得绕过风险

任何 AI Proposed Node：

```text
AI Proposed
↓
User Apply
↓
Workflow Node
↓
Risk Engine
↓
Execution
```

---

# 109. 最终架构核心

```text
                    User Selection
                          │
             ┌────────────┼────────────┐
             │            │            │
         Project       Workflow    Dependency
             │            │            │
             └───────┬────┴────┬───────┘
                     │         │
                ConfigResolver │
                     │         │
                     ▼         ▼
                  Build     DependencyHealth
                     │         │
                     └────┬────┘
                          │
Server → EnvironmentInspector
                          │
                          ▼
                  CapabilityEngine
                          │
                          ▼
                   WorkflowEngine
                          │
                          ▼
                  DeploymentEngine
                          │
                          ▼
                    HealthEngine
                    /          \
                Success       Failed
                   │             │
                   ▼             ▼
               Snapshot      Rollback
                   │             │
                   └──────┬──────┘
                          ▼
                     Version Center
```

---

# 110. 最终产品理念

这个平台应该理解：

```text
“前端发布”
```

和：

```text
“后端服务部署”
```

根本不是同一个流程。

它应该知道：

```text
前端变量往往是 Build-Time

后端变量往往是 Runtime

前端通常输出静态 Artifact

后端通常是长期运行进程

前端通常依赖 API

后端可能依赖：
DB
Redis
ES
MQ
Object Storage
其他微服务

前端发布通常适合 Atomic Switch

后端发布通常涉及：
Restart
Rolling
Blue-Green

后端可能需要 Migration

数据库回滚不能和代码回滚混为一谈
```

---

# 111. Cursor 实现硬性要求

1. 不允许将前端和后端共用固定部署步骤。
2. Workflow 必须使用 Node + Edge。
3. 用户必须可以跳过节点。
4. 用户必须可以从任意合法节点开始。
5. 用户必须可以执行单个节点。
6. 项目类型正式值由用户选择。
7. 系统识别只能作为 Recommendation。
8. 服务器 Facts 必须自动检测。
9. 不允许硬编码 apt。
10. 不允许硬编码 systemd。
11. 不允许假设 Docker 存在。
12. 不允许自动安装数据库 / Redis / ES，除非用户明确选择。
13. 后端 Deployment 必须支持 Dependency Model。
14. Dependency 必须支持 Health Check。
15. Config 必须支持 BuildTime / Runtime / Reload / Restart。
16. Secret 不允许明文入 SQLite。
17. Deployment Snapshot 必须包含 Dependency Snapshot。
18. Migration 必须独立成为 Workflow Node。
19. App Rollback 不得自动等同于 DB Rollback。
20. 前端 Static Deploy 默认使用 Atomic Release。
21. Docker Production 必须记录 digest。
22. 所有危险操作必须通过 Risk Engine。
23. AI 只允许 Proposed，不允许直接执行。
24. Production 默认必须 Health Check。
25. Production 默认必须可回滚。
26. Workflow 本身必须版本化。
27. Deployment 必须记录 Workflow Version。
28. 所有长任务必须可追踪状态。
29. 所有日志必须脱敏。
30. 所有执行必须可审计。

---

# 112. 推荐 MVP 顺序

## V0.1

```text
Project
Environment
Server
Credential
Environment Inspector
Capability Engine
Workflow 基础模型
SQLite
```

## V0.2

```text
Frontend Project
Build
Artifact
Nginx Static
Atomic Release
Health Check
Rollback
```

## V0.3

```text
Backend Project
Runtime Config
Dependency Model
Database / Redis / ES External Connection
Dependency Health
systemd
Docker
Docker Compose
```

## V0.4

```text
Migration
Rolling
Blue-Green
Multi Server
Version Center
```

## V0.5

```text
CI/CD
GitHub Actions
GitLab CI
External Artifact
Promotion
```

## V0.6

```text
AI Recommendation
Config Analysis
Dependency Analysis
Failure Analysis
Workflow Advisor
```

---

# 113. 一句话结论

> 前端、后端、基础设施必须是三套不同领域模型；Workflow 负责组合它们，而不是用一条固定部署链把所有项目硬套进去。

最终真正的一键部署应该是：

```text
用户已经明确：
项目是什么
要怎么部署
用哪些依赖
用哪个 Workflow

↓

系统自动判断：
服务器能不能做
依赖是否健康
配置是否完整
目标环境是否安全

↓

系统执行：
Build
Deploy
Health
Snapshot
Rollback
```

这才是一套可长期扩展的桌面 DevOps 平台。
