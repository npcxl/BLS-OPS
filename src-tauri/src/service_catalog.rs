//! Service recognition catalogue + host-path classification.
//!
//! # Why this exists
//!
//! "发现服务器项目" 最大的误报来源有两个：
//!
//! 1. **操作系统自带的目录被当成项目**。`find /home /srv /opt /var/www /data`
//!    会命中 `/usr/local/lib/python3/.../site-packages/foo/package.json` 这类
//!    属于系统的东西 —— 它们不是用户的项目，列出来只会淹没真正的业务代码。
//! 2. **基础设施被当成业务项目**。一台机器上跑的 MySQL、Redis、RabbitMQ、
//!    Nginx 是**依赖**，不是"项目"。它们通常没有源码、没有构建清单、配置在
//!    镜像里或 `/etc` 下，混在候选里会让人以为"MySQL 也是我的一个项目"。
//!
//! 这个模块只做**纯判定**（零 I/O、零网络）：给出一个镜像名 / 单元名 / 端口 /
//! 路径，回答"这是什么服务、属于哪一类、这条路径归谁"。收集器与评分器共用同一
//! 张表，避免两处各写一套规则而对不上。
//!
//! 铁律：**识别不出来就说识别不出来**（返回 `None`），绝不猜测成某个具体服务。
//!
//! # 匹配策略（2026-09 修订）
//!
//! 旧实现用宽泛子串匹配（`haystack.contains(keyword)`），会把
//! `redis-proxy-api`、`mysql-backup-worker` 这类**业务服务**误判成基础设施。
//! 现在的规则：
//!
//! 1. 镜像先归一化 basename，再与别名**精确匹配**（`redis` ✓，`redis-proxy-api` ✗）；
//! 2. 支持"命名空间/名字"整体匹配（`bitnami/redis` 这类明确别名）；
//! 3. systemd 用规范化 unit basename（去 `.service`、截 `@` 模板段）；
//! 4. 可执行文件用 basename（`/usr/bin/redis-server` → `redis-server`）；
//! 5. 配置路径与端口只是**辅助证据**，永远不能单独决定业务角色。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 分类模型（工作负载角色 / 基础设施类别 / 组件角色 / 技术）
// ---------------------------------------------------------------------------

/// 一个实例的**业务角色**。
///
/// 这是顶层互斥分类的唯一依据：应用服务 / 基础设施 / 系统组件 / 待归类。
/// 旧的 `ServiceGroup` 同时承担技术类型、业务角色与 UI 配色多个职责，
/// 已不再用于分类判断（仅保留给 UI 徽标配色）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkloadRole {
    /// 用户业务代码产生的运行实例（API、Worker、SSR 前端…）。
    Application,
    /// 数据库、缓存、存储、消息、网关等支撑组件。
    Infrastructure,
    /// 操作系统或容器平台自身组件（sshd、cron、containerd、pause…）。
    System,
    /// 证据不足，暂时无法判断。**绝不**默认归基础设施。
    #[default]
    Unknown,
}

impl WorkloadRole {
    pub fn label(self) -> &'static str {
        match self {
            WorkloadRole::Application => "应用服务",
            WorkloadRole::Infrastructure => "基础设施",
            WorkloadRole::System => "系统组件",
            WorkloadRole::Unknown => "待归类",
        }
    }
}

/// 基础设施的**稳定类别**。只枚举类别，不枚举具体产品；
/// 具体产品（`mysql` / `minio` / …）用 [`DetectedTechnology`] 字符串表达。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InfrastructureCategory {
    Database,
    Cache,
    ObjectStorage,
    Messaging,
    Search,
    Gateway,
    Coordination,
    Observability,
    Devops,
    ContainerPlatform,
    Security,
    AiRuntime,
    Unknown,
}

impl InfrastructureCategory {
    /// 前端分组顺序（保持展示稳定）。
    pub const ORDERED: [InfrastructureCategory; 12] = [
        InfrastructureCategory::Database,
        InfrastructureCategory::Cache,
        InfrastructureCategory::ObjectStorage,
        InfrastructureCategory::Messaging,
        InfrastructureCategory::Search,
        InfrastructureCategory::Gateway,
        InfrastructureCategory::Coordination,
        InfrastructureCategory::Observability,
        InfrastructureCategory::Devops,
        InfrastructureCategory::ContainerPlatform,
        InfrastructureCategory::Security,
        InfrastructureCategory::AiRuntime,
    ];

    pub fn label(self) -> &'static str {
        match self {
            InfrastructureCategory::Database => "数据库",
            InfrastructureCategory::Cache => "缓存",
            InfrastructureCategory::ObjectStorage => "对象存储",
            InfrastructureCategory::Messaging => "消息与流处理",
            InfrastructureCategory::Search => "搜索与索引",
            InfrastructureCategory::Gateway => "网关与代理",
            InfrastructureCategory::Coordination => "配置与协调",
            InfrastructureCategory::Observability => "可观测性",
            InfrastructureCategory::Devops => "研发运维",
            InfrastructureCategory::ContainerPlatform => "容器平台",
            InfrastructureCategory::Security => "安全与身份",
            InfrastructureCategory::AiRuntime => "AI 推理",
            InfrastructureCategory::Unknown => "其他",
        }
    }
}

/// 实例在业务架构里承担的**组件角色**（应用内部的 frontend/backend 等）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComponentRole {
    Frontend,
    Backend,
    Worker,
    ScheduledJob,
    Database,
    Cache,
    ObjectStorage,
    MessageQueue,
    Search,
    Gateway,
    Observability,
    AiInference,
    #[default]
    Unknown,
}

impl ComponentRole {
    pub fn label(self) -> &'static str {
        match self {
            ComponentRole::Frontend => "前端",
            ComponentRole::Backend => "后端",
            ComponentRole::Worker => "后台任务",
            ComponentRole::ScheduledJob => "定时任务",
            ComponentRole::Database => "数据库",
            ComponentRole::Cache => "缓存",
            ComponentRole::ObjectStorage => "对象存储",
            ComponentRole::MessageQueue => "消息队列",
            ComponentRole::Search => "搜索引擎",
            ComponentRole::Gateway => "网关",
            ComponentRole::Observability => "可观测性",
            ComponentRole::AiInference => "AI 推理",
            ComponentRole::Unknown => "角色未知",
        }
    }
}

/// 识别出的**具体技术产品**（字符串 ID，新增产品无需改核心枚举）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedTechnology {
    /// 稳定 ID：`mysql` / `redis` / `minio` / `nginx` / `node` / `ollama` …
    pub id: String,
    /// 人读名称：`MySQL` / `Redis` / `Node.js` …
    pub label: String,
}

/// 实例归属：共享基础设施 / 项目专属 / 未知。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceOwnership {
    /// 多个项目共用的基础设施（共享 MySQL、共享 Nginx）。
    Shared,
    /// 只服务某一个项目（项目专属前端容器、项目自带 Redis）。
    ProjectScoped,
    #[default]
    Unknown,
}

impl InstanceOwnership {
    pub fn label(self) -> &'static str {
        match self {
            InstanceOwnership::Shared => "共享",
            InstanceOwnership::ProjectScoped => "项目专属",
            InstanceOwnership::Unknown => "归属未知",
        }
    }
}

/// 分类所依据的**一条证据**。禁止猜测，每条分类都要能说出理由。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassificationEvidence {
    /// 证据来源：`image` / `unit` / `executable` / `config` / `port` /
    /// `system` / `runtime` / `project_marker` / `nginx_root` / `unknown`。
    pub source: String,
    /// 人读描述：`镜像 mysql:8.0 精确匹配 MySQL`。
    pub detail: String,
}

impl ClassificationEvidence {
    pub fn new(source: &str, detail: impl Into<String>) -> Self {
        Self {
            source: source.to_string(),
            detail: detail.into(),
        }
    }
}

/// 分类的**置信度**。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationConfidence {
    High,
    Medium,
    #[default]
    Low,
}

impl ClassificationConfidence {
    pub fn label(self) -> &'static str {
        match self {
            ClassificationConfidence::High => "高",
            ClassificationConfidence::Medium => "中",
            ClassificationConfidence::Low => "低",
        }
    }
}

// ---------------------------------------------------------------------------
// 服务身份（保留：UI 徽标仍用 group 配色）
// ---------------------------------------------------------------------------

/// 一个被识别出来的服务（MySQL / Redis / Nginx / …）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceIdentity {
    /// 稳定标识：`mysql` / `redis` / `nginx` / `postgres` …
    pub id: &'static str,
    /// 人读名称：`MySQL` / `Redis` / `Nginx` …
    pub label: &'static str,
    /// 归属大类：决定它算不算"业务项目"。
    pub group: ServiceGroup,
}

/// 可序列化的服务身份（[`ServiceIdentity`] 的持有版）。
///
/// `ServiceIdentity` 里全是 `&'static str`，能 Serialize 但不能 Deserialize；
/// 而 `DeploymentInstance` / `ProjectCandidate` 需要同时具备两者（要进 JSON
/// 往返与测试），所以对外一律用这个结构。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedService {
    /// 稳定标识：`mysql` / `redis` / `nginx` …
    pub id: String,
    /// 人读名称：`MySQL` / `Redis` / `Nginx` …
    pub label: String,
    /// 归属大类。
    pub group: ServiceGroup,
}

impl DetectedService {
    /// 业务应用（不是数据库 / 缓存 / 网关这类基础设施）。
    pub fn is_application(&self) -> bool {
        matches!(self.group, ServiceGroup::Application)
    }
}

impl ServiceIdentity {
    /// 转成可序列化的持有版。
    pub fn detected(&self) -> DetectedService {
        DetectedService {
            id: self.id.to_string(),
            label: self.label.to_string(),
            group: self.group,
        }
    }
}

/// 服务归属大类（**仅用于 UI 徽标配色**；分类判断一律用 [`WorkloadRole`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceGroup {
    /// 业务应用（我们自己写的代码）。
    Application,
    /// 数据库。
    Database,
    /// 缓存。
    Cache,
    /// 消息队列 / 流处理。
    Messaging,
    /// 搜索引擎。
    Search,
    /// 网关 / Web 服务器。
    Gateway,
    /// 对象存储。
    Storage,
    /// 配置中心 / 注册中心 / 协调服务。
    Coordination,
    /// 可观测性（监控、日志、链路）。
    Observability,
    /// 研发运维平台（CI、镜像仓库、面板）。
    Devops,
    /// 容器 / 编排基础设施（docker、containerd、kubelet、pause 容器）。
    Infrastructure,
    /// 安全与身份（Vault、Keycloak…）。
    Security,
    /// AI 推理运行时（Ollama、vLLM…）。
    AiRuntime,
}

impl ServiceGroup {
    /// 是否属于"基础设施"——即不是用户要部署的业务项目。
    pub fn is_infrastructure(self) -> bool {
        !matches!(self, ServiceGroup::Application)
    }

    /// 中文标签。
    pub fn label(self) -> &'static str {
        match self {
            ServiceGroup::Application => "业务应用",
            ServiceGroup::Database => "数据库",
            ServiceGroup::Cache => "缓存",
            ServiceGroup::Messaging => "消息队列",
            ServiceGroup::Search => "搜索引擎",
            ServiceGroup::Gateway => "网关",
            ServiceGroup::Storage => "对象存储",
            ServiceGroup::Coordination => "配置与协调",
            ServiceGroup::Observability => "可观测性",
            ServiceGroup::Devops => "研发运维平台",
            ServiceGroup::Infrastructure => "容器基础设施",
            ServiceGroup::Security => "安全与身份",
            ServiceGroup::AiRuntime => "AI 推理",
        }
    }
}

// ---------------------------------------------------------------------------
// 识别目录：基础设施产品表（精确 basename 匹配）
// ---------------------------------------------------------------------------

/// 识别目录的一个条目：一个具体的基础设施产品。
///
/// 匹配永远基于**归一化后的精确 basename**，绝不做宽泛子串。
#[derive(Debug, Clone, Copy)]
pub struct ServiceCatalogEntry {
    /// 稳定 ID：`mysql` / `redis` / `minio` …
    pub id: &'static str,
    /// 人读名称：`MySQL` / `Redis` / `MinIO` …
    pub label: &'static str,
    /// UI 徽标配色沿用的大类。
    pub group: ServiceGroup,
    /// 基础设施类别。
    pub infrastructure_category: InfrastructureCategory,
    /// 组件角色。
    pub component_role: ComponentRole,
    /// 镜像 basename 别名（`mysql`、`percona-server`…，精确匹配）。
    pub image_aliases: &'static [&'static str],
    /// systemd unit basename 别名（精确匹配）。
    pub unit_aliases: &'static [&'static str],
    /// 可执行文件 basename 别名（精确匹配）。
    pub executable_aliases: &'static [&'static str],
    /// 配置路径片段（辅助证据）。
    pub config_patterns: &'static [&'static str],
    /// 默认端口（辅助证据）。
    pub default_ports: &'static [u16],
}

const fn cat(
    id: &'static str,
    label: &'static str,
    group: ServiceGroup,
    category: InfrastructureCategory,
    component: ComponentRole,
    images: &'static [&'static str],
    units: &'static [&'static str],
    execs: &'static [&'static str],
    configs: &'static [&'static str],
    ports: &'static [u16],
) -> ServiceCatalogEntry {
    ServiceCatalogEntry {
        id,
        label,
        group,
        infrastructure_category: category,
        component_role: component,
        image_aliases: images,
        unit_aliases: units,
        executable_aliases: execs,
        config_patterns: configs,
        default_ports: ports,
    }
}

use ComponentRole as CR;
use InfrastructureCategory as IC;
use ServiceGroup as SG;

/// 基础设施产品目录。顺序即识别优先级（精确匹配下仅影响并列证据时的取用）。
pub static CATALOG: &[ServiceCatalogEntry] = &[
    // ---- 数据库 ----
    cat(
        "mysql",
        "MySQL",
        SG::Database,
        IC::Database,
        CR::Database,
        &["mysql", "mysqld", "mysql-server"],
        &["mysql", "mysqld", "mysql-server"],
        &["mysqld", "mysql"],
        &["/etc/mysql", "my.cnf"],
        &[3306, 3307],
    ),
    cat(
        "mariadb",
        "MariaDB",
        SG::Database,
        IC::Database,
        CR::Database,
        &["mariadb", "mariadbd"],
        &["mariadb", "mariadbd"],
        &["mariadbd"],
        &["/etc/mariadb"],
        &[3306],
    ),
    cat(
        "percona",
        "Percona MySQL",
        SG::Database,
        IC::Database,
        CR::Database,
        &["percona", "percona-server", "percona-xtradb-cluster"],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "postgres",
        "PostgreSQL",
        SG::Database,
        IC::Database,
        CR::Database,
        &[
            "postgres",
            "postgresql",
            "postgis",
            "timescaledb",
            "timescale",
        ],
        &["postgresql", "postgres"],
        &["postgres", "postgresql"],
        &["/etc/postgresql", "/var/lib/postgresql", "postgresql.conf"],
        &[5432, 5433],
    ),
    cat(
        "clickhouse",
        "ClickHouse",
        SG::Database,
        IC::Database,
        CR::Database,
        &["clickhouse", "clickhouse-server"],
        &["clickhouse-server"],
        &[],
        &["/etc/clickhouse-server"],
        &[8123],
    ),
    cat(
        "influxdb",
        "InfluxDB",
        SG::Database,
        IC::Database,
        CR::Database,
        &["influxdb"],
        &["influxdb"],
        &["influxdb"],
        &[],
        &[8086],
    ),
    cat(
        "mongodb",
        "MongoDB",
        SG::Database,
        IC::Database,
        CR::Database,
        &["mongodb", "mongo", "mongod"],
        &["mongod", "mongodb", "mongos"],
        &["mongod", "mongos"],
        &["/etc/mongodb", "mongod.conf"],
        &[27017],
    ),
    cat(
        "tidb",
        "TiDB",
        SG::Database,
        IC::Database,
        CR::Database,
        &["tidb", "tidb-server", "tikv", "pd-server"],
        &[],
        &[],
        &[],
        &[],
    ),
    // ---- 缓存 ----
    cat(
        "redis",
        "Redis",
        SG::Cache,
        IC::Cache,
        CR::Cache,
        &["redis", "redis-server"],
        &["redis", "redis-server"],
        &["redis-server", "redis"],
        &["/etc/redis", "redis.conf"],
        &[6379, 6380],
    ),
    cat(
        "valkey",
        "Valkey",
        SG::Cache,
        IC::Cache,
        CR::Cache,
        &["valkey", "valkey-server"],
        &["valkey", "valkey-server"],
        &["valkey-server"],
        &[],
        &[6379],
    ),
    cat(
        "memcached",
        "Memcached",
        SG::Cache,
        IC::Cache,
        CR::Cache,
        &["memcached"],
        &["memcached"],
        &["memcached"],
        &[],
        &[11211],
    ),
    cat(
        "keydb",
        "KeyDB",
        SG::Cache,
        IC::Cache,
        CR::Cache,
        &["keydb"],
        &["keydb"],
        &["keydb"],
        &[],
        &[6379],
    ),
    // ---- 对象存储 ----
    cat(
        "minio",
        "MinIO",
        SG::Storage,
        IC::ObjectStorage,
        CR::ObjectStorage,
        &["minio"],
        &["minio"],
        &["minio"],
        &["/etc/minio"],
        &[9000, 9001],
    ),
    cat(
        "seaweedfs",
        "SeaweedFS",
        SG::Storage,
        IC::ObjectStorage,
        CR::ObjectStorage,
        &[
            "seaweedfs",
            "seaweedfs-volume",
            "seaweedfs-master",
            "seaweedfs-filer",
        ],
        &[],
        &["weed"],
        &[],
        &[9333],
    ),
    // ---- 消息与流 ----
    cat(
        "kafka",
        "Kafka",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &["kafka"],
        &["kafka"],
        &["kafka"],
        &[],
        &[9092, 9093],
    ),
    cat(
        "rabbitmq",
        "RabbitMQ",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &["rabbitmq"],
        &["rabbitmq-server", "rabbitmq"],
        &["rabbitmq-server", "rabbitmqmq"],
        &["/etc/rabbitmq"],
        &[5672, 15672],
    ),
    cat(
        "rocketmq",
        "RocketMQ",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &[
            "rocketmq",
            "rmqbroker",
            "rmqnamesrv",
            "rocketmq-broker",
            "rocketmq-namesrv",
        ],
        &[],
        &[],
        &[],
        &[9876],
    ),
    cat(
        "pulsar",
        "Pulsar",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &["pulsar", "pulsar-broker", "pulsar-standalone"],
        &[],
        &[],
        &[],
        &[6650],
    ),
    cat(
        "nsq",
        "NSQ",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &["nsq", "nsqd", "nsqlookupd"],
        &[],
        &[],
        &[],
        &[4150],
    ),
    cat(
        "emqx",
        "EMQX",
        SG::Messaging,
        IC::Messaging,
        CR::MessageQueue,
        &["emqx"],
        &["emqx"],
        &["emqx"],
        &[],
        &[1883],
    ),
    // ---- 搜索 ----
    cat(
        "elasticsearch",
        "Elasticsearch",
        SG::Search,
        IC::Search,
        CR::Search,
        &["elasticsearch", "elasticsearch-oss"],
        &["elasticsearch"],
        &["elasticsearch"],
        &[],
        &[9200, 9300],
    ),
    cat(
        "opensearch",
        "OpenSearch",
        SG::Search,
        IC::Search,
        CR::Search,
        &["opensearch"],
        &["opensearch"],
        &["opensearch"],
        &[],
        &[9200],
    ),
    cat(
        "solr",
        "Solr",
        SG::Search,
        IC::Search,
        CR::Search,
        &["solr"],
        &["solr"],
        &["solr"],
        &[],
        &[8983],
    ),
    cat(
        "meilisearch",
        "Meilisearch",
        SG::Search,
        IC::Search,
        CR::Search,
        &["meilisearch"],
        &["meilisearch"],
        &["meilisearch"],
        &[],
        &[7700],
    ),
    // ---- 网关 ----
    cat(
        "nginx",
        "Nginx",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["nginx"],
        &["nginx"],
        &["nginx"],
        &["/etc/nginx", "nginx.conf"],
        &[80, 443],
    ),
    cat(
        "openresty",
        "OpenResty",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["openresty"],
        &["openresty"],
        &["openresty"],
        &[],
        &[80, 443],
    ),
    cat(
        "traefik",
        "Traefik",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["traefik"],
        &["traefik"],
        &["traefik"],
        &[],
        &[80, 443],
    ),
    cat(
        "caddy",
        "Caddy",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["caddy"],
        &["caddy"],
        &["caddy"],
        &[],
        &[80, 443],
    ),
    cat(
        "haproxy",
        "HAProxy",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["haproxy"],
        &["haproxy"],
        &["haproxy"],
        &["/etc/haproxy"],
        &[80, 443],
    ),
    cat(
        "envoy",
        "Envoy",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["envoy"],
        &["envoy"],
        &["envoy"],
        &[],
        &[],
    ),
    cat(
        "apache",
        "Apache",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["httpd", "apache", "apache2"],
        &["apache2", "httpd", "apache"],
        &["apache2", "httpd"],
        &["/etc/apache2", "/etc/httpd", "apache2.conf", "httpd.conf"],
        &[80, 443],
    ),
    cat(
        "apisix",
        "APISIX",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["apisix"],
        &[],
        &[],
        &[],
        &[9080],
    ),
    cat(
        "kong",
        "Kong",
        SG::Gateway,
        IC::Gateway,
        CR::Gateway,
        &["kong", "kong-gateway"],
        &[],
        &[],
        &[],
        &[8000, 8443],
    ),
    // ---- 配置与协调 ----
    cat(
        "etcd",
        "etcd",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &["etcd"],
        &["etcd"],
        &["etcd"],
        &[],
        &[2379, 2380],
    ),
    cat(
        "zookeeper",
        "ZooKeeper",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &["zookeeper"],
        &["zookeeper"],
        &["zookeeper"],
        &[],
        &[2181],
    ),
    cat(
        "nacos",
        "Nacos",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &["nacos", "nacos-server"],
        &["nacos"],
        &["nacos"],
        &[],
        &[8848],
    ),
    cat(
        "consul",
        "Consul",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &["consul"],
        &["consul"],
        &["consul"],
        &["/etc/consul.d"],
        &[8500],
    ),
    cat(
        "apollo",
        "Apollo",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &[
            "apollo",
            "apollo-adminservice",
            "apollo-configservice",
            "apollo-portal",
        ],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "xxl-job",
        "XXL-JOB",
        SG::Coordination,
        IC::Coordination,
        CR::Unknown,
        &["xxl-job", "xxl-job-admin"],
        &["xxl-job"],
        &[],
        &[],
        &[],
    ),
    // ---- 可观测性 ----
    cat(
        "prometheus",
        "Prometheus",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["prometheus"],
        &["prometheus"],
        &["prometheus"],
        &["/etc/prometheus", "prometheus.yml"],
        &[9090],
    ),
    cat(
        "grafana",
        "Grafana",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["grafana"],
        &["grafana-server", "grafana"],
        &["grafana", "grafana-server"],
        &[],
        &[3000],
    ),
    cat(
        "alertmanager",
        "Alertmanager",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["alertmanager"],
        &["alertmanager"],
        &["alertmanager"],
        &[],
        &[9093],
    ),
    cat(
        "loki",
        "Loki",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["loki"],
        &["loki"],
        &["loki"],
        &[],
        &[3100],
    ),
    cat(
        "promtail",
        "Promtail",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["promtail"],
        &["promtail"],
        &["promtail"],
        &[],
        &[],
    ),
    cat(
        "jaeger",
        "Jaeger",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &[
            "jaeger",
            "all-in-one",
            "jaeger-all-in-one",
            "jaeger-agent",
            "jaeger-collector",
            "jaeger-query",
        ],
        &[],
        &[],
        &[],
        &[16686],
    ),
    cat(
        "zipkin",
        "Zipkin",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["zipkin"],
        &["zipkin"],
        &["zipkin"],
        &[],
        &[9411],
    ),
    cat(
        "skywalking",
        "SkyWalking",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["skywalking", "skywalking-oap", "skywalking-ui"],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "node-exporter",
        "Node Exporter",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["node-exporter", "node_exporter", "prometheus-node-exporter"],
        &["node-exporter", "node_exporter", "prometheus-node-exporter"],
        &["node_exporter", "node-exporter"],
        &[],
        &[9100],
    ),
    cat(
        "cadvisor",
        "cAdvisor",
        SG::Observability,
        IC::Observability,
        CR::Observability,
        &["cadvisor"],
        &[],
        &["cadvisor"],
        &[],
        &[],
    ),
    // ---- 研发运维 ----
    cat(
        "jenkins",
        "Jenkins",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["jenkins"],
        &["jenkins"],
        &["jenkins"],
        &[],
        &[],
    ),
    cat(
        "gitlab",
        "GitLab",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["gitlab", "gitlab-ce", "gitlab-ee"],
        &["gitlab-runsvdir", "gitlab"],
        &[],
        &[],
        &[],
    ),
    cat(
        "gitlab-runner",
        "GitLab Runner",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["gitlab-runner"],
        &["gitlab-runner"],
        &["gitlab-runner"],
        &[],
        &[],
    ),
    cat(
        "gitea",
        "Gitea",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["gitea"],
        &["gitea"],
        &["gitea"],
        &[],
        &[],
    ),
    cat(
        "harbor",
        "Harbor",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &[
            "harbor",
            "harbor-core",
            "harbor-jobservice",
            "harbor-portal",
            "harbor-registry",
            "harbor-db",
            "harbor-redis",
            "harbor-trivy",
            "harbor-exporter",
        ],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "sonarqube",
        "SonarQube",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["sonarqube", "sonar"],
        &["sonarqube"],
        &["sonarqube"],
        &[],
        &[],
    ),
    cat(
        "portainer",
        "Portainer",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["portainer", "portainer-ce"],
        &["portainer"],
        &["portainer"],
        &[],
        &[],
    ),
    cat(
        "nexus",
        "Nexus",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["nexus", "nexus3"],
        &["nexus"],
        &["nexus"],
        &[],
        &[8081],
    ),
    cat(
        "argocd",
        "Argo CD",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &[
            "argocd",
            "argocd-server",
            "argocd-repo-server",
            "argocd-application-controller",
            "argocd-dex",
            "argocd-notifications",
            "argocd-redis",
        ],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "mongo-express",
        "Mongo Express",
        SG::Devops,
        IC::Devops,
        CR::Unknown,
        &["mongo-express"],
        &[],
        &[],
        &[],
        &[],
    ),
    // ---- 安全与身份 ----
    cat(
        "vault",
        "Vault",
        SG::Security,
        IC::Security,
        CR::Unknown,
        &["vault"],
        &["vault"],
        &["vault"],
        &["/etc/vault.d"],
        &[8200],
    ),
    cat(
        "keycloak",
        "Keycloak",
        SG::Security,
        IC::Security,
        CR::Unknown,
        &["keycloak"],
        &["keycloak"],
        &["keycloak"],
        &[],
        &[],
    ),
    cat(
        "teleport",
        "Teleport",
        SG::Security,
        IC::Security,
        CR::Unknown,
        &["teleport"],
        &["teleport"],
        &["teleport"],
        &[],
        &[],
    ),
    cat(
        "certbot",
        "Certbot",
        SG::Security,
        IC::Security,
        CR::Unknown,
        &["certbot"],
        &["certbot"],
        &["certbot"],
        &[],
        &[],
    ),
    // ---- AI 推理 ----
    cat(
        "ollama",
        "Ollama",
        SG::AiRuntime,
        IC::AiRuntime,
        CR::AiInference,
        &["ollama"],
        &["ollama"],
        &["ollama"],
        &["/etc/ollama"],
        &[11434],
    ),
    cat(
        "vllm",
        "vLLM",
        SG::AiRuntime,
        IC::AiRuntime,
        CR::AiInference,
        &["vllm", "vllm-openai"],
        &[],
        &["vllm"],
        &[],
        &[],
    ),
    cat(
        "triton",
        "Triton",
        SG::AiRuntime,
        IC::AiRuntime,
        CR::AiInference,
        &["triton", "tritonserver", "triton-inference-server"],
        &[],
        &["tritonserver"],
        &[],
        &[],
    ),
    cat(
        "localai",
        "LocalAI",
        SG::AiRuntime,
        IC::AiRuntime,
        CR::AiInference,
        &["localai", "local-ai"],
        &[],
        &["local-ai"],
        &[],
        &[],
    ),
    cat(
        "xinference",
        "Xinference",
        SG::AiRuntime,
        IC::AiRuntime,
        CR::AiInference,
        &["xinference"],
        &[],
        &["xinference"],
        &[],
        &[],
    ),
    // ---- 容器平台（通常以 system_owned 实例出现；镜像别名用于 k8s 组件识别）----
    cat(
        "pause",
        "Kubernetes pause 沙箱",
        SG::Infrastructure,
        IC::ContainerPlatform,
        CR::Unknown,
        &["pause"],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "kube-proxy",
        "Kubernetes 节点代理",
        SG::Infrastructure,
        IC::ContainerPlatform,
        CR::Unknown,
        &["kube-proxy"],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "kube-rbac-proxy",
        "Kubernetes RBAC 代理",
        SG::Infrastructure,
        IC::ContainerPlatform,
        CR::Unknown,
        &["kube-rbac-proxy"],
        &[],
        &[],
        &[],
        &[],
    ),
    cat(
        "coredns",
        "CoreDNS",
        SG::Infrastructure,
        IC::ContainerPlatform,
        CR::Unknown,
        &["coredns"],
        &["coredns"],
        &["coredns"],
        &[],
        &[],
    ),
];

/// 按 ID 查目录条目（分类器从 `DetectedService.id` 反查类别时用）。
pub fn find_catalog_entry(id: &str) -> Option<&'static ServiceCatalogEntry> {
    CATALOG.iter().find(|entry| entry.id == id)
}

/// 按**镜像名**查目录（精确 basename / 命名空间别名）。
pub fn find_by_image(image: &str) -> Option<&'static ServiceCatalogEntry> {
    let name = image_name(image);
    if name.is_empty() {
        return None;
    }
    let basename = name.to_ascii_lowercase();
    // 完整 repo 路径（`bitnami/redis`）支持命名空间别名。
    let full = image
        .trim()
        .split('@')
        .next()
        .unwrap_or("")
        .rsplit_once(':')
        .filter(|(_, tail)| !tail.contains('/'))
        .map_or_else(|| image.trim().to_string(), |(head, _)| head.to_string())
        .to_ascii_lowercase();
    CATALOG.iter().find(|entry| {
        entry
            .image_aliases
            .iter()
            .any(|alias| alias.eq_ignore_ascii_case(&basename) || alias.eq_ignore_ascii_case(&full))
    })
}

/// 按**systemd 单元名**查目录（unit basename 精确匹配）。
pub fn find_by_unit(unit: &str) -> Option<&'static ServiceCatalogEntry> {
    let base = unit_basename(unit);
    if base.is_empty() {
        return None;
    }
    CATALOG.iter().find(|entry| {
        entry
            .unit_aliases
            .iter()
            .any(|a| a.eq_ignore_ascii_case(&base))
    })
}

/// 按**可执行文件路径**查目录（basename 精确匹配）。
pub fn find_by_executable(exec_path: &str) -> Option<&'static ServiceCatalogEntry> {
    let base = exec_path
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        return None;
    }
    CATALOG.iter().find(|entry| {
        entry
            .executable_aliases
            .iter()
            .any(|a| a.eq_ignore_ascii_case(&base))
    })
}

// ---------------------------------------------------------------------------
// 操作系统自带单元表（精确 basename + 有限的明确前缀）
// ---------------------------------------------------------------------------

/// 操作系统自带单元条目。
#[derive(Debug, Clone, Copy)]
pub struct SystemUnit {
    pub id: &'static str,
    pub label: &'static str,
    pub group: ServiceGroup,
    /// 精确 basename 别名。
    pub aliases: &'static [&'static str],
    /// 明确命名空间前缀（仅 `systemd-` 这类发行版命名空间）。
    pub prefixes: &'static [&'static str],
}

const fn su(
    id: &'static str,
    label: &'static str,
    group: ServiceGroup,
    aliases: &'static [&'static str],
    prefixes: &'static [&'static str],
) -> SystemUnit {
    SystemUnit {
        id,
        label,
        group,
        aliases,
        prefixes,
    }
}

/// 操作系统 / 容器平台自带的服务单元。这些单元即使 WorkingDirectory
/// 落在业务根下，也不是用户部署的项目。
static SYSTEM_UNITS: &[SystemUnit] = &[
    // 容器 / 编排运行时。
    su(
        "docker",
        "Docker 引擎",
        SG::Infrastructure,
        &["docker"],
        &[],
    ),
    su(
        "containerd",
        "containerd",
        SG::Infrastructure,
        &["containerd", "containerd.io"],
        &[],
    ),
    su(
        "kubelet",
        "Kubelet",
        SG::Infrastructure,
        &["kubelet", "kubelet.service"],
        &[],
    ),
    su(
        "kube-proxy",
        "Kube Proxy",
        SG::Infrastructure,
        &["kube-proxy"],
        &[],
    ),
    su("podman", "Podman", SG::Infrastructure, &["podman"], &[]),
    su(
        "cri-dockerd",
        "cri-dockerd",
        SG::Infrastructure,
        &["cri-docker", "cri-dockerd"],
        &[],
    ),
    su(
        "container-runtime",
        "容器运行时套件",
        SG::Infrastructure,
        &["buildkit", "buildkitd", "fuse-overlayfs"],
        &[],
    ),
    // 发行版自带服务。
    su(
        "sshd",
        "SSH 服务",
        SG::Infrastructure,
        &["sshd", "ssh", "ssh.socket", "sshd.socket"],
        &[],
    ),
    su(
        "cron",
        "计划任务",
        SG::Infrastructure,
        &["cron", "crond", "atd", "anacron"],
        &[],
    ),
    su(
        "dbus",
        "DBus",
        SG::Infrastructure,
        &["dbus", "dbus-broker"],
        &[],
    ),
    su(
        "systemd",
        "systemd 内部单元",
        SG::Infrastructure,
        &[],
        &["systemd-"],
    ),
    su(
        "rsyslog",
        "系统日志",
        SG::Infrastructure,
        &["rsyslog", "rsyslogd", "syslog-ng", "syslog"],
        &[],
    ),
    su(
        "firewall",
        "防火墙",
        SG::Infrastructure,
        &["ufw", "firewalld", "iptables", "nftables", "firewall"],
        &[],
    ),
    su(
        "network",
        "网络管理",
        SG::Infrastructure,
        &[
            "networkmanager",
            "network-manager",
            "dhcpcd",
            "wicd",
            "modemmanager",
        ],
        &["networkmanager-dispatcher"],
    ),
    su(
        "snapd",
        "Snap 守护进程",
        SG::Infrastructure,
        &["snapd"],
        &["snap-"],
    ),
    su(
        "polkit",
        "权限管理",
        SG::Infrastructure,
        &["polkit", "polkitd", "policykit"],
        &[],
    ),
    su(
        "getty",
        "终端",
        SG::Infrastructure,
        &["getty", "serial-getty", "mingetty"],
        &[],
    ),
    su(
        "user-session",
        "用户会话",
        SG::Infrastructure,
        &["user", "user-runtime-dir", "session"],
        &["user@", "session-"],
    ),
    su("tuned", "性能调优", SG::Infrastructure, &["tuned"], &[]),
    su(
        "chronyd",
        "时间同步",
        SG::Infrastructure,
        &["chronyd", "chrony", "chrony-wait", "ntpd", "ntp", "ntpsec"],
        &[],
    ),
    su("auditd", "审计", SG::Infrastructure, &["auditd"], &[]),
    su(
        "irqbalance",
        "中断均衡",
        SG::Infrastructure,
        &["irqbalance"],
        &[],
    ),
    su(
        "multipathd",
        "多路径",
        SG::Infrastructure,
        &["multipathd", "multipath-tools"],
        &[],
    ),
    su(
        "lvm",
        "逻辑卷管理",
        SG::Infrastructure,
        &[
            "lvm2",
            "lvm2-lvmetad",
            "lvm2-monitor",
            "lvm2-lvmpolld",
            "dm-event",
            "dm-event.service",
        ],
        &["lvm2-"],
    ),
    su(
        "kmod",
        "内核模块",
        SG::Infrastructure,
        &["kmod", "kmod-static-nodes"],
        &[],
    ),
    su(
        "iscsi",
        "iSCSI",
        SG::Infrastructure,
        &["iscsid", "open-iscsi", "iscsiuio", "iscsi"],
        &[],
    ),
    su(
        "nfs",
        "NFS",
        SG::Infrastructure,
        &[
            "nfs-server",
            "nfs-kernel-server",
            "nfs-common",
            "nfs-idmapd",
            "nfs-utils",
            "nfsdcld",
            "rpcbind",
            "rpcbind.socket",
            "rpc-statd",
        ],
        &["nfs-"],
    ),
    su(
        "acpid",
        "电源管理",
        SG::Infrastructure,
        &["acpid", "acpi-support"],
        &[],
    ),
    su(
        "qemu-agent",
        "虚拟机代理",
        SG::Infrastructure,
        &["qemu-guest-agent", "spice-vdagentd"],
        &[],
    ),
    su(
        "cloud-init",
        "云初始化",
        SG::Infrastructure,
        &[
            "cloud-init",
            "cloud-config",
            "cloud-final",
            "cloud-init-local",
        ],
        &[],
    ),
    su(
        "vm-agent",
        "云运维代理",
        SG::Infrastructure,
        &[
            "amazon-ssm-agent",
            "aliyun-service",
            "aliyun",
            "assist_daemon",
            "sgagent",
            "barad_agent",
        ],
        &[],
    ),
    // 监控 agent：包管理器常把它装成系统服务（保留旧行为，视为系统自带）。
    su(
        "node-exporter",
        "Node Exporter",
        SG::Observability,
        &["node_exporter", "node-exporter", "prometheus-node-exporter"],
        &[],
    ),
];

impl SystemUnit {
    fn matches(&self, base: &str) -> bool {
        self.aliases.iter().any(|a| a.eq_ignore_ascii_case(base))
            || self
                .prefixes
                .iter()
                .any(|p| base.to_ascii_lowercase().starts_with(p))
    }
}

fn unit_basename(unit: &str) -> String {
    unit.trim()
        .trim_end_matches(".service")
        .trim_end_matches(".timer")
        .trim_end_matches(".socket")
        .split('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// 从**镜像名**识别服务（docker / k8s 容器共用）。
///
/// 归一化 basename 后**精确匹配**目录别名。识别不出返回 `None` ——
/// `company/redis-proxy-api` 这类业务镜像绝不因为包含 "redis" 被误判。
pub fn identify_image(image: &str) -> Option<ServiceIdentity> {
    find_by_image(image).map(|entry| ServiceIdentity {
        id: entry.id,
        label: entry.label,
        group: entry.group,
    })
}

/// 从 **systemd 单元名**识别服务。识别不出返回 `None`。
///
/// 先查"操作系统自带"表（明确不属于用户项目），再查产品目录。
pub fn identify_unit(unit: &str) -> Option<ServiceIdentity> {
    let base = unit_basename(unit);
    if base.is_empty() {
        return None;
    }
    if let Some(sys) = SYSTEM_UNITS.iter().find(|sys| sys.matches(&base)) {
        return Some(ServiceIdentity {
            id: sys.id,
            label: sys.label,
            group: sys.group,
        });
    }
    find_by_unit(unit).map(|entry| ServiceIdentity {
        id: entry.id,
        label: entry.label,
        group: entry.group,
    })
}

/// 从**可执行文件路径**识别服务（`/usr/bin/redis-server` → Redis）。
pub fn identify_executable(exec_path: &str) -> Option<ServiceIdentity> {
    find_by_executable(exec_path).map(|entry| ServiceIdentity {
        id: entry.id,
        label: entry.label,
        group: entry.group,
    })
}

/// 语言运行时 / 进程管理器技术（**不是**基础设施类别，用于应用实例标注）。
///
/// 镜像 `node:20-alpine`、单元 `pm2-root.service`、可执行 `/usr/bin/pm2`
/// 都指向"这是一个业务运行时"，但它们本身不构成基础设施。
/// 第四列是**明确命名空间前缀**（仅 `pm2-` 这类固定命名约定：
/// PM2 为每个用户生成 `pm2-<user>.service`）。
static RUNTIME_TECH: &[(&str, &[&str], &str, &[&str])] = &[
    (
        "node",
        &[
            "node",
            "nodejs",
            "node20",
            "node18",
            "node22",
            "bun",
            "deno",
            "pm2",
            "pm2-runtime",
            "tsx",
        ],
        "Node.js",
        &["pm2-"],
    ),
    (
        "java",
        &[
            "java",
            "openjdk",
            "temurin",
            "eclipse-temurin",
            "adoptopenjdk",
            "jdk",
            "zulu",
            "bellsoft",
            "graalvm",
            "jre",
        ],
        "Java",
        &[],
    ),
    (
        "python",
        &[
            "python", "python3", "pypy", "uvicorn", "gunicorn", "uwsgi", "celery",
        ],
        "Python",
        &[],
    ),
    ("go", &["go", "golang"], "Go", &[]),
    ("rust", &["rust"], "Rust", &[]),
    ("php", &["php", "php-fpm"], "PHP", &[]),
    ("dotnet", &["dotnet", "aspnet", "aspnetcore"], ".NET", &[]),
    (
        "ruby",
        &["ruby", "puma", "puma-worker", "rails"],
        "Ruby",
        &[],
    ),
];

/// 识别**语言运行时技术**。输入可以是镜像名 / 单元名 / 可执行路径，
/// 内部统一归一化成 basename 后精确匹配（外加 `pm2-` 等固定命名前缀）。
pub fn identify_runtime_tech(raw: &str) -> Option<DetectedTechnology> {
    // 统一归一化：镜像去 registry/tag，单元去后缀，路径取末段。
    let mut name = raw.trim();
    if let Some((head, _)) = name.split_once('@') {
        name = head;
    }
    let name = match name.rsplit_once(':') {
        Some((head, tail)) if !tail.contains('/') => head,
        _ => name,
    };
    let base = name
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim_end_matches(".service")
        .trim_end_matches(".timer")
        .split('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        return None;
    }
    RUNTIME_TECH
        .iter()
        .find(|(_, aliases, _, prefixes)| {
            aliases.iter().any(|a| a.eq_ignore_ascii_case(&base))
                || prefixes.iter().any(|p| base.starts_with(p))
        })
        .map(|(id, _, label, _)| DetectedTechnology {
            id: (*id).to_string(),
            label: (*label).to_string(),
        })
}

/// systemd 单元文件路径是否属于**包管理器安装的系统单元**。
///
/// `/usr/lib/systemd/system` 与 `/lib/systemd/system` 是发行版/包管理器的目录；
/// `/etc/systemd/system` 才是管理员自建服务的位置。这条比单元名更可靠 ——
/// 同一个名字 `redis.service` 可能是系统装的，也可能是管理员手写的。
pub fn is_system_unit_path(fragment_path: &str) -> bool {
    fragment_path.starts_with("/usr/lib/systemd/system/")
        || fragment_path.starts_with("/lib/systemd/system/")
        || fragment_path.starts_with("/usr/share/systemd/")
        || fragment_path.starts_with("/snap/")
}

/// 该 systemd 单元是否为**操作系统自带**（不是管理员自建的业务服务）。
pub fn is_os_unit(unit: &str) -> bool {
    let base = unit_basename(unit);
    if base.is_empty() {
        return false;
    }
    SYSTEM_UNITS.iter().any(|sys| sys.matches(&base))
}

/// 从**端口**猜测服务。只在没有镜像/单元线索时使用，且只认极少数"事实上
/// 已成标准"的端口。识别不出返回 `None` —— 端口可以任意改，绝不硬猜。
pub fn identify_port(port: u16) -> Option<ServiceIdentity> {
    find_catalog_entry_by_port(port).map(|entry| ServiceIdentity {
        id: entry.id,
        label: entry.label,
        group: entry.group,
    })
}

/// 端口辅助识别：只查目录表里的"事实上标准"端口。
fn find_catalog_entry_by_port(port: u16) -> Option<&'static ServiceCatalogEntry> {
    match port {
        3306 | 3307 => find_catalog_entry("mysql"),
        5432 | 5433 => find_catalog_entry("postgres"),
        6379 | 6380 => find_catalog_entry("redis"),
        11211 => find_catalog_entry("memcached"),
        27017 => find_catalog_entry("mongodb"),
        5672 | 15672 => find_catalog_entry("rabbitmq"),
        9092 => find_catalog_entry("kafka"),
        2181 => find_catalog_entry("zookeeper"),
        9200 | 9300 => find_catalog_entry("elasticsearch"),
        2379 | 2380 => find_catalog_entry("etcd"),
        _ => None,
    }
}

/// 从配置文件路径猜测服务（`/etc/mysql/my.cnf`、`/etc/nginx/nginx.conf` …）。
///
/// **只是辅助证据**：管理员可以把 MySQL 配置放到任何地方，端口/配置永远
/// 不能单独决定业务角色。
pub fn identify_config_path(path: &str) -> Option<ServiceIdentity> {
    let lower = path.to_ascii_lowercase();
    CATALOG
        .iter()
        .find(|entry| {
            entry
                .config_patterns
                .iter()
                .any(|pattern| lower.contains(pattern))
        })
        .map(|entry| ServiceIdentity {
            id: entry.id,
            label: entry.label,
            group: entry.group,
        })
}

/// 端口的常见用途（用于 UI 着色与 tooltip），识别不出返回 `None`。
pub fn port_hint(port: u16) -> Option<&'static str> {
    identify_port(port).map(|service| service.label)
}

/// 镜像名归一化：去掉 registry 主机、命名空间前缀与 tag/digest，
/// 只留"软件名"那一段，便于精确匹配。
///
/// `docker.io/library/nginx:1.24` → `nginx`
/// `registry.k8s.io/pause:3.9`    → `pause`
/// `bitnami/mysql:8.0`            → `mysql`
fn image_name(image: &str) -> String {
    let mut value = image.trim();
    // 去掉 digest / tag。
    if let Some((head, _)) = value.split_once('@') {
        value = head;
    }
    let without_tag = match value.rsplit_once(':') {
        // 只有形如 `host:5000/repo` 里的端口冒号才会被误伤：冒号后必须不含 `/`。
        Some((head, tail)) if !tail.contains('/') => head,
        _ => value,
    };
    // 取最后一段路径作为软件名。
    without_tag
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

// ---------------------------------------------------------------------------
// 宿主路径归属判定
// ---------------------------------------------------------------------------

/// **操作系统自带**的路径前缀。落在这些前缀下的目录属于发行版/包管理器，
/// 不是用户的项目 —— 即使里面躺着 `package.json`。
///
/// 注意：`/usr/local` 本身是合法的项目根（`/usr/local/myapp` 很常见），所以
/// 这里列的是它的**子目录** `/usr/local/lib`、`/usr/local/share`。
const SYSTEM_PREFIXES: &[&str] = &[
    "/usr/lib",
    "/usr/lib32",
    "/usr/lib64",
    "/usr/libexec",
    "/usr/share",
    "/usr/src",
    "/usr/include",
    "/usr/local/lib",
    "/usr/local/share",
    "/usr/local/include",
    "/lib",
    "/lib32",
    "/lib64",
    "/libexec",
    "/bin",
    "/sbin",
    "/etc",
    "/boot",
    "/proc",
    "/sys",
    "/dev",
    "/run",
    "/snap",
    "/var/lib",
    "/var/cache",
    "/var/log",
    "/var/spool",
    "/var/snap",
    "/var/tmp",
    "/tmp",
    "/lost+found",
    "/nix",
    "/gnu",
    "/sysroot",
    "/cdrom",
    "/media",
];

/// 语言运行时 / 包管理器的缓存与依赖目录。出现在路径**任何一层**都说明这个
/// 目录是依赖树的一部分，而不是项目根。
const RUNTIME_DIR_NAMES: &[&str] = &[
    "node_modules",
    "site-packages",
    "dist-packages",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    ".cargo",
    ".rustup",
    ".nvm",
    ".pyenv",
    ".rbenv",
    ".sdkman",
    ".gradle",
    ".m2",
    ".npm",
    ".yarn",
    ".pnpm-store",
    ".composer",
    ".gem",
    ".bundle",
    ".terraform",
    ".vscode-server",
    ".local/share",
];

/// 该路径是否属于**操作系统自带的目录**（不是用户的项目）。
pub fn is_system_path(path: &str) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    SYSTEM_PREFIXES
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

/// 该路径是否位于语言运行时 / 包管理器的依赖或缓存目录里。
pub fn is_runtime_dependency_path(path: &str) -> bool {
    path.split('/').any(|segment| {
        RUNTIME_DIR_NAMES
            .iter()
            .any(|name| segment.eq_ignore_ascii_case(name))
    })
}

/// 该路径能否作为"项目候选"的根。
///
/// 返回 `false` 的理由会写入 `reason`，供前端解释"为什么没列出它"。
pub fn is_plausible_project_root(path: &str) -> Result<(), String> {
    if is_system_path(path) {
        return Err("属于操作系统自带目录，不是业务项目".to_string());
    }
    if is_runtime_dependency_path(path) {
        return Err("位于语言依赖或缓存目录内".to_string());
    }
    Ok(())
}

/// 实例运行的**位置**：宿主机进程 / Docker / Kubernetes。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceRuntime {
    /// 直接跑在宿主机上（systemd / 裸进程 / 宿主机 Nginx）。
    Host,
    /// Docker / Podman 容器（含 Compose）。
    Container,
    /// Kubernetes 工作负载（Pod 里的容器）。
    Kubernetes,
}

impl Default for InstanceRuntime {
    /// 缺省值取"宿主机"：在容器归属被追踪之前，所有实例都按直接跑在机器上处理，
    /// 这与历史数据的语义一致。
    fn default() -> Self {
        InstanceRuntime::Host
    }
}

impl InstanceRuntime {
    pub fn label(self) -> &'static str {
        match self {
            InstanceRuntime::Host => "宿主机",
            InstanceRuntime::Container => "Docker 容器",
            InstanceRuntime::Kubernetes => "Kubernetes",
        }
    }
}

/// Kubernetes 容器名前缀。kubelet 用 docker/containerd 运行时创建的容器名形如
/// `k8s_<容器名>_<Pod 名>_<命名空间>_<UID>_<重启次数>`；Pod 沙箱容器则叫
/// `k8s_POD_<Pod>_<ns>_...`。**仅凭容器名就能判断它归属 k8s**，不需要额外命令。
const K8S_CONTAINER_PREFIX: &str = "k8s_";

/// 从容器名判断是否属于 Kubernetes 工作负载，并解析出 pod / namespace。
///
/// 这解答了"Docker 里跑的到底是普通容器还是 k8s 的 Pod"：同一台机器上
/// `docker ps` 会同时看到两者，容器名是唯一的区分依据。
pub fn parse_k8s_container_name(name: &str) -> Option<K8sContainer> {
    let rest = name.strip_prefix(K8S_CONTAINER_PREFIX)?;
    let mut parts = rest.splitn(5, '_');
    let container = parts.next()?.to_string();
    let pod = parts.next()?.to_string();
    let namespace = parts.next()?.to_string();
    if container.is_empty() || pod.is_empty() || namespace.is_empty() {
        return None;
    }
    Some(K8sContainer {
        // `k8s_POD_...` 是 Pod 的沙箱（pause）容器，它没有业务进程，
        // 不代表任何服务。
        is_sandbox: container == "POD",
        container,
        pod,
        namespace,
    })
}

/// 从 `k8s_` 容器名解析出的归属信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct K8sContainer {
    pub container: String,
    pub pod: String,
    pub namespace: String,
    /// `true` = Pod 的 pause 沙箱容器，不代表具体服务。
    pub is_sandbox: bool,
}

impl K8sContainer {
    /// k8s 里的稳定实例名：`namespace/pod[/container]`。
    pub fn qualified_name(&self) -> String {
        if self.is_sandbox {
            format!("{}/{}", self.namespace, self.pod)
        } else {
            format!("{}/{}/{}", self.namespace, self.pod, self.container)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_names_are_normalised_before_matching() {
        assert_eq!(image_name("nginx:1.24"), "nginx");
        assert_eq!(image_name("docker.io/library/nginx:1.24"), "nginx");
        assert_eq!(image_name("bitnami/mysql:8.0"), "mysql");
        assert_eq!(image_name("registry.k8s.io/pause:3.9"), "pause");
        // 带端口的 registry 不能被 tag 剥离逻辑误伤。
        assert_eq!(image_name("registry.local:5000/team/app:v2"), "app");
        // digest 形式。
        assert_eq!(image_name("nginx@sha256:abcdef"), "nginx");
    }

    /// 数据库与缓存必须被认成基础设施，绝不能混进"业务项目"。
    #[test]
    fn databases_and_caches_are_infrastructure() {
        for image in [
            "mysql:8.0",
            "mariadb:10.11",
            "postgres:16",
            "redis:7",
            "bitnami/redis:7.2",
            "mongo:7",
        ] {
            let service = identify_image(image).unwrap_or_else(|| panic!("{image} 必须被识别"));
            assert!(
                matches!(service.group, ServiceGroup::Database | ServiceGroup::Cache),
                "{image} → {:?}",
                service.group
            );
            assert!(service.group.is_infrastructure());
        }
    }

    #[test]
    fn nginx_is_a_gateway_whether_on_the_host_or_in_a_container() {
        let service = identify_image("nginx:1.24").expect("nginx 镜像");
        assert_eq!(service.group, ServiceGroup::Gateway);
        assert_eq!(service.label, "Nginx");
        // 宿主机上的 nginx 单元同样识别为网关。
        let unit = identify_unit("nginx.service").expect("nginx 单元");
        assert_eq!(unit.id, "nginx");
        assert_eq!(unit.group, ServiceGroup::Gateway);
    }

    #[test]
    fn an_unknown_image_is_never_guessed() {
        assert!(identify_image("my-registry/order-service:1.2.3").is_none());
        assert!(identify_image("scratch").is_none());
        assert!(identify_unit("my-app.service").is_none());
    }

    /// 宽泛子串误判必须被堵死：包含基础设施关键词的业务命名不能命中。
    #[test]
    fn business_names_containing_infra_keywords_are_not_guessed() {
        assert!(identify_image("company/redis-proxy-api:1.0").is_none());
        assert!(identify_image("redis-proxy-api").is_none());
        assert!(identify_image("mysql-backup-worker:2").is_none());
        assert!(identify_image("minio-upload-api").is_none());
        assert!(identify_unit("mysql-backup-worker.service").is_none());
        assert!(identify_unit("nginx-config-service.service").is_none());
        assert!(identify_executable("/opt/app/my-mysql-backup-worker").is_none());
        assert!(find_by_image("company/redis-proxy-api:1.0").is_none());
    }

    /// 精确匹配的正面用例：官方镜像与明确别名必须仍然命中。
    #[test]
    fn precise_aliases_still_match() {
        assert_eq!(identify_image("redis:7").unwrap().id, "redis");
        assert_eq!(identify_image("bitnami/redis:7").unwrap().id, "redis");
        assert_eq!(identify_image("percona-server:8").unwrap().id, "percona");
        assert_eq!(
            identify_image("mongo-express:1").unwrap().id,
            "mongo-express"
        );
        assert_eq!(identify_image("eclipse-temurin:17").is_none(), true);
        assert_eq!(identify_unit("redis-server.service").unwrap().id, "redis");
        assert_eq!(identify_unit("mongod.service").unwrap().id, "mongodb");
        assert_eq!(
            identify_executable("/usr/bin/redis-server").unwrap().id,
            "redis"
        );
        assert_eq!(identify_executable("/usr/sbin/nginx").unwrap().id, "nginx");
        assert_eq!(identify_executable("/usr/bin/mysqld").unwrap().id, "mysql");
    }

    /// 用户列出的第一版产品覆盖要求。
    #[test]
    fn first_batch_products_are_covered() {
        for (image, id) in [
            ("mysql:8", "mysql"),
            ("mariadb:10", "mariadb"),
            ("postgres:16", "postgres"),
            ("mongo:7", "mongodb"),
            ("clickhouse/clickhouse-server:24", "clickhouse"),
            ("tidb:8", "tidb"),
            ("redis:7", "redis"),
            ("valkey/valkey:8", "valkey"),
            ("memcached:1", "memcached"),
            ("minio/minio:latest", "minio"),
            ("rabbitmq:3", "rabbitmq"),
            ("bitnami/kafka:3", "kafka"),
            ("apache/rocketmq:5", "rocketmq"),
            ("elasticsearch:8", "elasticsearch"),
            ("opensearchproject/opensearch:2", "opensearch"),
            ("nginx:1.24", "nginx"),
            ("openresty/openresty:1", "openresty"),
            ("traefik:v3", "traefik"),
            ("caddy:2", "caddy"),
            ("nacos/nacos-server:v2", "nacos"),
            ("hashicorp/consul:1", "consul"),
            ("bitnami/etcd:3", "etcd"),
            ("zookeeper:3", "zookeeper"),
            ("prom/prometheus:v2", "prometheus"),
            ("grafana/grafana:10", "grafana"),
            ("grafana/loki:3", "loki"),
            ("jaegertracing/all-in-one:1", "jaeger"),
            ("jenkins/jenkins:lts", "jenkins"),
            ("goharbor/harbor-core:v2", "harbor"),
            ("hashicorp/vault:1", "vault"),
            ("ollama/ollama:latest", "ollama"),
            ("vllm/vllm-openai:latest", "vllm"),
            ("nvcr.io/nvidia/tritonserver:24", "triton"),
        ] {
            assert_eq!(
                identify_image(image).map(|s| s.id),
                Some(id),
                "{image} 必须识别为 {id}"
            );
        }
    }

    /// 语言运行时技术识别（Node 是运行时，不是基础设施类别）。
    #[test]
    fn runtime_techs_are_recognised_but_not_infrastructure() {
        assert_eq!(identify_runtime_tech("node:20-alpine").unwrap().id, "node");
        assert_eq!(
            identify_runtime_tech("eclipse-temurin:17").unwrap().id,
            "java"
        );
        assert_eq!(
            identify_runtime_tech("pm2-root.service").unwrap().id,
            "node"
        );
        assert_eq!(identify_runtime_tech("/usr/bin/pm2").unwrap().id, "node");
        assert!(
            identify_runtime_tech("node-exporter").is_none(),
            "node_exporter 是目录条目，不是运行时"
        );
        assert!(
            identify_runtime_tech("my-node-app").is_none(),
            "精确匹配不猜前缀"
        );
    }

    /// 操作系统自带的服务必须被认出来，否则"Linux 自己跑的东西"会混进项目列表。
    #[test]
    fn operating_system_units_are_recognised() {
        for unit in [
            "sshd.service",
            "cron.service",
            "systemd-journald.service",
            "systemd-logind.service",
            "dbus.service",
            "getty@tty1.service",
            "user@1000.service",
            "containerd.service",
            "docker.service",
            "kubelet.service",
            "nfs-server.service",
        ] {
            assert!(is_os_unit(unit), "{unit} 必须是系统自带服务");
        }
        assert!(!is_os_unit("my-app.service"));
        assert!(!is_os_unit("nginx.service"));
        assert!(!is_os_unit("mysql-backup-worker.service"));
    }

    /// 一个 k8s 集群里的容器，名字会暴露它的归属 —— 这是在同一次 `docker ps`
    /// 里区分"普通容器"与"k8s Pod 容器"的唯一依据。
    #[test]
    fn kubernetes_container_names_reveal_their_pod() {
        let parsed = parse_k8s_container_name("k8s_nginx_nginx-deploy-7d4b9_default_abc123_0")
            .expect("k8s 容器名必须可解析");
        assert_eq!(parsed.container, "nginx");
        assert_eq!(parsed.pod, "nginx-deploy-7d4b9");
        assert_eq!(parsed.namespace, "default");
        assert!(!parsed.is_sandbox);
        assert_eq!(parsed.qualified_name(), "default/nginx-deploy-7d4b9/nginx");

        // POD 沙箱容器不代表任何服务。
        let sandbox =
            parse_k8s_container_name("k8s_POD_nginx-deploy-7d4b9_default_abc123_0").expect("沙箱");
        assert!(sandbox.is_sandbox);
        assert_eq!(sandbox.qualified_name(), "default/nginx-deploy-7d4b9");

        // 普通容器不是 k8s 的。
        assert!(parse_k8s_container_name("my-nginx").is_none());
        assert!(parse_k8s_container_name("docker_nginx").is_none());
    }

    #[test]
    fn operating_system_directories_are_not_projects() {
        for path in [
            "/usr/lib/python3/dist-packages/requests",
            "/usr/local/lib/node_modules/npm",
            "/usr/share/nginx/html",
            "/var/lib/docker/overlay2/abc",
            "/etc/nginx",
            "/snap/core20/current",
        ] {
            assert!(is_system_path(path), "{path} 必须是系统目录");
            assert!(
                is_plausible_project_root(path).is_err(),
                "{path} 不该成为项目候选"
            );
        }
        // 这些是合法的项目根，不能被误伤。
        for path in [
            "/home/deploy/api",
            "/srv/order-service",
            "/opt/apps/gateway",
            "/var/www/html",
            "/data/projects/web",
            "/usr/local/myapp",
        ] {
            assert!(!is_system_path(path), "{path} 不是系统目录");
            assert!(
                is_plausible_project_root(path).is_ok(),
                "{path} 必须是合法项目根：{:?}",
                is_plausible_project_root(path)
            );
        }
    }

    #[test]
    fn dependency_directories_are_rejected_at_any_depth() {
        for path in [
            "/srv/app/node_modules/left-pad",
            "/srv/app/.venv/lib/python3.11/site-packages/django",
            "/root/.nvm/versions/node/v20/bin",
            "/home/u/.cache/yarn/v6/npm-lodash",
        ] {
            assert!(is_runtime_dependency_path(path), "{path} 必须是依赖目录");
            assert!(is_plausible_project_root(path).is_err());
        }
    }

    #[test]
    fn well_known_ports_name_their_service() {
        assert_eq!(port_hint(3306), Some("MySQL"));
        assert_eq!(port_hint(6379), Some("Redis"));
        assert_eq!(port_hint(5432), Some("PostgreSQL"));
        assert_eq!(port_hint(27017), Some("MongoDB"));
        // 端口可以随人改，不认识的端口绝不硬猜。
        assert_eq!(port_hint(8080), None);
        assert_eq!(port_hint(3000), None);
    }

    /// 配置路径只能做辅助识别，覆盖原有 6 组即可。
    #[test]
    fn config_paths_map_to_services() {
        assert_eq!(
            identify_config_path("/etc/mysql/my.cnf").unwrap().id,
            "mysql"
        );
        assert_eq!(
            identify_config_path("/etc/postgresql/16/main").unwrap().id,
            "postgres"
        );
        assert_eq!(
            identify_config_path("/etc/redis/redis.conf").unwrap().id,
            "redis"
        );
        assert_eq!(
            identify_config_path("/etc/nginx/nginx.conf").unwrap().id,
            "nginx"
        );
        assert_eq!(
            identify_config_path("/etc/mongod.conf").unwrap().id,
            "mongodb"
        );
        assert_eq!(
            identify_config_path("/etc/rabbitmq/rabbitmq.conf")
                .unwrap()
                .id,
            "rabbitmq"
        );
        assert!(identify_config_path("/srv/app/config.json").is_none());
    }

    /// 每条目录条目都要有完整的人类可读信息（新增条目忘了填 label 会挂）。
    #[test]
    fn catalog_entries_are_well_formed() {
        for entry in CATALOG {
            assert!(!entry.id.is_empty());
            assert!(!entry.label.is_empty());
            assert!(
                !entry.image_aliases.is_empty()
                    || !entry.unit_aliases.is_empty()
                    || !entry.executable_aliases.is_empty()
                    || !entry.config_patterns.is_empty(),
                "{} 必须至少提供一种识别证据",
                entry.id
            );
            assert!(
                matches!(entry.group, SG::Application) == false,
                "目录里不能有业务应用条目"
            );
        }
        // ID 必须唯一。
        let mut ids: Vec<&str> = CATALOG.iter().map(|e| e.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "目录 ID 必须唯一");
    }
}
