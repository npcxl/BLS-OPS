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

use serde::{Deserialize, Serialize};

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

/// 服务归属大类。
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
}

impl ServiceGroup {
    /// 是否属于"基础设施"——即不是用户要部署的业务项目。
    ///
    /// 网关（Nginx）属于基础设施，但它同时是项目部署的关键载体，所以单独
    /// 保留可见；其余（数据库/缓存/消息/监控/CI…）默认不跟业务项目混排。
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
        }
    }
}

/// 目录条目：`(匹配关键字, 标识, 展示名, 归类)`。
///
/// 匹配方式是"包含"（对镜像名/单元名做小写子串匹配），所以关键字要取得短而
/// 不易误伤：`mysql` 能命中 `mysql:8`、`bitnami/mysql`、`mysql-server`。
struct Entry(&'static str, &'static str, &'static str, ServiceGroup);

const IMAGE_TABLE: &[Entry] = &[
    // -- 容器 / 编排基础设施：必须最先判，否则 k8s 的 pause 容器会被当成项目 --
    Entry(
        "pause",
        "pause",
        "Kubernetes pause",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "kube-rbac-proxy",
        "kube-rbac-proxy",
        "Kubernetes RBAC 代理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "kube-proxy",
        "kube-proxy",
        "Kubernetes 节点代理",
        ServiceGroup::Infrastructure,
    ),
    Entry("etcd", "etcd", "etcd", ServiceGroup::Coordination),
    // -- 数据库 --
    Entry("mysql", "mysql", "MySQL", ServiceGroup::Database),
    Entry("mariadb", "mariadb", "MariaDB", ServiceGroup::Database),
    Entry(
        "percona",
        "percona",
        "Percona MySQL",
        ServiceGroup::Database,
    ),
    Entry("postgres", "postgres", "PostgreSQL", ServiceGroup::Database),
    Entry("postgis", "postgis", "PostGIS", ServiceGroup::Database),
    Entry(
        "timescale",
        "timescale",
        "TimescaleDB",
        ServiceGroup::Database,
    ),
    Entry(
        "clickhouse",
        "clickhouse",
        "ClickHouse",
        ServiceGroup::Database,
    ),
    Entry("influxdb", "influxdb", "InfluxDB", ServiceGroup::Database),
    Entry("mongodb", "mongodb", "MongoDB", ServiceGroup::Database),
    Entry(
        "mongo-express",
        "mongo-express",
        "Mongo Express",
        ServiceGroup::Devops,
    ),
    // 官方镜像就叫 `mongo`。必须排在 `mongo-express` 之后 —— 匹配是顺序取首个，
    // 否则 Mongo Express 会被当成 MongoDB。
    Entry("mongo", "mongodb", "MongoDB", ServiceGroup::Database),
    Entry("tidb", "tidb", "TiDB", ServiceGroup::Database),
    // -- 缓存 --
    Entry("redis", "redis", "Redis", ServiceGroup::Cache),
    Entry("valkey", "valkey", "Valkey", ServiceGroup::Cache),
    Entry("memcached", "memcached", "Memcached", ServiceGroup::Cache),
    Entry("keydb", "keydb", "KeyDB", ServiceGroup::Cache),
    // -- 消息 --
    Entry("kafka", "kafka", "Kafka", ServiceGroup::Messaging),
    Entry(
        "zookeeper",
        "zookeeper",
        "ZooKeeper",
        ServiceGroup::Coordination,
    ),
    Entry("rabbitmq", "rabbitmq", "RabbitMQ", ServiceGroup::Messaging),
    Entry("rocketmq", "rocketmq", "RocketMQ", ServiceGroup::Messaging),
    Entry("pulsar", "pulsar", "Pulsar", ServiceGroup::Messaging),
    Entry("nsq", "nsq", "NSQ", ServiceGroup::Messaging),
    Entry("emqx", "emqx", "EMQX", ServiceGroup::Messaging),
    // -- 搜索 --
    Entry(
        "elasticsearch",
        "elasticsearch",
        "Elasticsearch",
        ServiceGroup::Search,
    ),
    Entry(
        "opensearch",
        "opensearch",
        "OpenSearch",
        ServiceGroup::Search,
    ),
    Entry("solr", "solr", "Solr", ServiceGroup::Search),
    Entry(
        "meilisearch",
        "meilisearch",
        "Meilisearch",
        ServiceGroup::Search,
    ),
    // -- 网关（注意：必须早于通用的 web 关键字）--
    Entry("nginx", "nginx", "Nginx", ServiceGroup::Gateway),
    Entry("openresty", "openresty", "OpenResty", ServiceGroup::Gateway),
    Entry("traefik", "traefik", "Traefik", ServiceGroup::Gateway),
    Entry("caddy", "caddy", "Caddy", ServiceGroup::Gateway),
    Entry("haproxy", "haproxy", "HAProxy", ServiceGroup::Gateway),
    Entry("envoy", "envoy", "Envoy", ServiceGroup::Gateway),
    Entry("httpd", "httpd", "Apache", ServiceGroup::Gateway),
    Entry("apache", "apache", "Apache", ServiceGroup::Gateway),
    Entry("apisix", "apisix", "APISIX", ServiceGroup::Gateway),
    Entry("kong", "kong", "Kong", ServiceGroup::Gateway),
    // -- 对象存储 --
    Entry("minio", "minio", "MinIO", ServiceGroup::Storage),
    Entry("seaweedfs", "seaweedfs", "SeaweedFS", ServiceGroup::Storage),
    // -- 配置中心 --
    Entry("nacos", "nacos", "Nacos", ServiceGroup::Coordination),
    Entry("apollo", "apollo", "Apollo", ServiceGroup::Coordination),
    Entry("consul", "consul", "Consul", ServiceGroup::Coordination),
    Entry("xxl-job", "xxl-job", "XXL-JOB", ServiceGroup::Coordination),
    // -- 可观测性 --
    Entry(
        "prometheus",
        "prometheus",
        "Prometheus",
        ServiceGroup::Observability,
    ),
    Entry("grafana", "grafana", "Grafana", ServiceGroup::Observability),
    Entry(
        "alertmanager",
        "alertmanager",
        "Alertmanager",
        ServiceGroup::Observability,
    ),
    Entry("loki", "loki", "Loki", ServiceGroup::Observability),
    Entry(
        "promtail",
        "promtail",
        "Promtail",
        ServiceGroup::Observability,
    ),
    Entry("jaeger", "jaeger", "Jaeger", ServiceGroup::Observability),
    Entry("zipkin", "zipkin", "Zipkin", ServiceGroup::Observability),
    Entry(
        "skywalking",
        "skywalking",
        "SkyWalking",
        ServiceGroup::Observability,
    ),
    Entry(
        "node-exporter",
        "node-exporter",
        "Node Exporter",
        ServiceGroup::Observability,
    ),
    Entry(
        "cadvisor",
        "cadvisor",
        "cAdvisor",
        ServiceGroup::Observability,
    ),
    // -- 研发运维平台 --
    Entry("jenkins", "jenkins", "Jenkins", ServiceGroup::Devops),
    Entry("gitlab", "gitlab", "GitLab", ServiceGroup::Devops),
    Entry("gitea", "gitea", "Gitea", ServiceGroup::Devops),
    Entry("harbor", "harbor", "Harbor", ServiceGroup::Devops),
    Entry("sonarqube", "sonarqube", "SonarQube", ServiceGroup::Devops),
    Entry("portainer", "portainer", "Portainer", ServiceGroup::Devops),
    Entry("nexus", "nexus", "Nexus", ServiceGroup::Devops),
    Entry("argocd", "argocd", "Argo CD", ServiceGroup::Devops),
];

/// systemd 单元名关键字 → 服务。只在镜像识别不出时兜底。
const UNIT_TABLE: &[Entry] = &[
    // 注意：docker / containerd / kubelet / podman 属于平台基础设施，已由
    // `OS_UNIT_TABLE` 优先命中（那里先判），这里不再重复。
    // -- 数据库 --
    Entry("mysqld", "mysql", "MySQL", ServiceGroup::Database),
    Entry("mysql", "mysql", "MySQL", ServiceGroup::Database),
    Entry("mariadb", "mariadb", "MariaDB", ServiceGroup::Database),
    Entry(
        "postgresql",
        "postgres",
        "PostgreSQL",
        ServiceGroup::Database,
    ),
    Entry(
        "clickhouse",
        "clickhouse",
        "ClickHouse",
        ServiceGroup::Database,
    ),
    Entry("mongodb", "mongodb", "MongoDB", ServiceGroup::Database),
    Entry("mongod", "mongodb", "MongoDB", ServiceGroup::Database),
    // -- 缓存 --
    Entry("redis", "redis", "Redis", ServiceGroup::Cache),
    Entry("memcached", "memcached", "Memcached", ServiceGroup::Cache),
    // -- 消息 --
    Entry("kafka", "kafka", "Kafka", ServiceGroup::Messaging),
    Entry(
        "zookeeper",
        "zookeeper",
        "ZooKeeper",
        ServiceGroup::Coordination,
    ),
    Entry("rabbitmq", "rabbitmq", "RabbitMQ", ServiceGroup::Messaging),
    // -- 搜索 --
    Entry(
        "elasticsearch",
        "elasticsearch",
        "Elasticsearch",
        ServiceGroup::Search,
    ),
    // -- 网关 --
    Entry("nginx", "nginx", "Nginx", ServiceGroup::Gateway),
    Entry("httpd", "httpd", "Apache", ServiceGroup::Gateway),
    Entry("apache2", "apache", "Apache", ServiceGroup::Gateway),
    Entry("caddy", "caddy", "Caddy", ServiceGroup::Gateway),
    Entry("traefik", "traefik", "Traefik", ServiceGroup::Gateway),
    Entry("haproxy", "haproxy", "HAProxy", ServiceGroup::Gateway),
    // -- 配置中心 --
    Entry("etcd", "etcd", "etcd", ServiceGroup::Coordination),
    Entry("consul", "consul", "Consul", ServiceGroup::Coordination),
    Entry("nacos", "nacos", "Nacos", ServiceGroup::Coordination),
];

/// **操作系统自带**的服务单元：即使有 WorkingDirectory，也不是用户的项目。
/// 这些服务由发行版提供，列出来毫无意义。
const OS_UNIT_TABLE: &[Entry] = &[
    // -- 容器 / 编排运行时：属于平台基础设施，不是用户部署的东西 --
    Entry(
        "docker",
        "docker",
        "Docker 引擎",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "containerd",
        "containerd",
        "containerd",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "kubelet",
        "kubelet",
        "Kubelet",
        ServiceGroup::Infrastructure,
    ),
    Entry("podman", "podman", "Podman", ServiceGroup::Infrastructure),
    Entry(
        "cri-docker",
        "cri-dockerd",
        "cri-dockerd",
        ServiceGroup::Infrastructure,
    ),
    // -- 发行版自带服务 --
    Entry("sshd", "sshd", "SSH 服务", ServiceGroup::Infrastructure),
    Entry("ssh", "sshd", "SSH 服务", ServiceGroup::Infrastructure),
    Entry("cron", "cron", "计划任务", ServiceGroup::Infrastructure),
    Entry("crond", "cron", "计划任务", ServiceGroup::Infrastructure),
    Entry("dbus", "dbus", "DBus", ServiceGroup::Infrastructure),
    Entry(
        "systemd-",
        "systemd",
        "systemd 内部单元",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "rsyslog",
        "rsyslog",
        "系统日志",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "syslog",
        "rsyslog",
        "系统日志",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "journald",
        "journald",
        "系统日志",
        ServiceGroup::Infrastructure,
    ),
    Entry("ufw", "ufw", "防火墙", ServiceGroup::Infrastructure),
    Entry(
        "firewalld",
        "firewalld",
        "防火墙",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "iptables",
        "iptables",
        "防火墙",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "nftables",
        "nftables",
        "防火墙",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "networkd",
        "networkd",
        "网络管理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "NetworkManager",
        "network-manager",
        "网络管理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "snapd",
        "snapd",
        "Snap 守护进程",
        ServiceGroup::Infrastructure,
    ),
    Entry("polkit", "polkit", "权限管理", ServiceGroup::Infrastructure),
    Entry("getty", "getty", "终端", ServiceGroup::Infrastructure),
    Entry(
        "serial-getty",
        "getty",
        "终端",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "user@",
        "user-session",
        "用户会话",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "session-",
        "user-session",
        "用户会话",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "systemd-logind",
        "logind",
        "登录管理",
        ServiceGroup::Infrastructure,
    ),
    Entry("tuned", "tuned", "性能调优", ServiceGroup::Infrastructure),
    Entry(
        "chronyd",
        "chronyd",
        "时间同步",
        ServiceGroup::Infrastructure,
    ),
    Entry("ntp", "ntp", "时间同步", ServiceGroup::Infrastructure),
    Entry(
        "systemd-timesyncd",
        "timesyncd",
        "时间同步",
        ServiceGroup::Infrastructure,
    ),
    Entry("auditd", "auditd", "审计", ServiceGroup::Infrastructure),
    Entry(
        "irqbalance",
        "irqbalance",
        "中断均衡",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "multipathd",
        "multipathd",
        "多路径",
        ServiceGroup::Infrastructure,
    ),
    Entry("lvm2", "lvm", "逻辑卷", ServiceGroup::Infrastructure),
    Entry(
        "dm-event",
        "device-mapper",
        "设备映射",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "kmod-static-nodes",
        "kmod",
        "内核模块",
        ServiceGroup::Infrastructure,
    ),
    Entry("iscsid", "iscsi", "iSCSI", ServiceGroup::Infrastructure),
    Entry("nfs-", "nfs", "NFS", ServiceGroup::Infrastructure),
    Entry("rpcbind", "rpcbind", "RPC", ServiceGroup::Infrastructure),
    Entry("atd", "atd", "计划任务", ServiceGroup::Infrastructure),
    Entry("acpid", "acpid", "电源管理", ServiceGroup::Infrastructure),
    Entry(
        "qemu-guest-agent",
        "qemu-agent",
        "虚拟机代理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "cloud-init",
        "cloud-init",
        "云初始化",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "amazon-ssm-agent",
        "ssm-agent",
        "云运维代理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "aliyun",
        "cloud-agent",
        "云运维代理",
        ServiceGroup::Infrastructure,
    ),
    Entry(
        "node_exporter",
        "node-exporter",
        "Node Exporter",
        ServiceGroup::Observability,
    ),
    Entry(
        "prometheus-node-exporter",
        "node-exporter",
        "Node Exporter",
        ServiceGroup::Observability,
    ),
];

/// 从**镜像名**识别服务（docker / k8s 容器共用）。
///
/// 匹配前先去掉 registry 前缀与 tag，只看中间那段名字。识别不出返回 `None`。
pub fn identify_image(image: &str) -> Option<ServiceIdentity> {
    let name = image_name(image);
    if name.is_empty() {
        return None;
    }
    let haystack = name.to_ascii_lowercase();
    IMAGE_TABLE
        .iter()
        .find(|entry| haystack.contains(entry.0))
        .map(|entry| ServiceIdentity {
            id: entry.1,
            label: entry.2,
            group: entry.3,
        })
}

/// 从 **systemd 单元名**识别服务。识别不出返回 `None`。
///
/// 单元名形如 `mysql.service`、`redis-server.service`、`app@1.service`。
pub fn identify_unit(unit: &str) -> Option<ServiceIdentity> {
    let base = unit
        .trim_end_matches(".service")
        .split('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if base.is_empty() {
        return None;
    }
    // 先看"操作系统自带"表：这些服务明确不属于用户的项目。
    if let Some(hit) = OS_UNIT_TABLE
        .iter()
        .find(|entry| base.contains(&entry.0.to_ascii_lowercase()))
    {
        return Some(ServiceIdentity {
            id: hit.1,
            label: hit.2,
            group: hit.3,
        });
    }
    UNIT_TABLE
        .iter()
        .find(|entry| base.contains(entry.0))
        .map(|entry| ServiceIdentity {
            id: entry.1,
            label: entry.2,
            group: entry.3,
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
    let base = unit
        .trim_end_matches(".service")
        .split('@')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    OS_UNIT_TABLE
        .iter()
        .any(|entry| base.contains(&entry.0.to_ascii_lowercase()))
}

/// 从**端口**猜测服务。只在没有镜像/单元线索时使用，且只认极少数"事实上
/// 已成标准"的端口。识别不出返回 `None` —— 端口可以任意改，绝不硬猜。
pub fn identify_port(port: u16) -> Option<ServiceIdentity> {
    match port {
        3306 | 3307 => Some(ServiceIdentity {
            id: "mysql",
            label: "MySQL",
            group: ServiceGroup::Database,
        }),
        5432 | 5433 => Some(ServiceIdentity {
            id: "postgres",
            label: "PostgreSQL",
            group: ServiceGroup::Database,
        }),
        6379 | 6380 => Some(ServiceIdentity {
            id: "redis",
            label: "Redis",
            group: ServiceGroup::Cache,
        }),
        11211 => Some(ServiceIdentity {
            id: "memcached",
            label: "Memcached",
            group: ServiceGroup::Cache,
        }),
        27017 => Some(ServiceIdentity {
            id: "mongodb",
            label: "MongoDB",
            group: ServiceGroup::Database,
        }),
        5672 | 15672 => Some(ServiceIdentity {
            id: "rabbitmq",
            label: "RabbitMQ",
            group: ServiceGroup::Messaging,
        }),
        9092 => Some(ServiceIdentity {
            id: "kafka",
            label: "Kafka",
            group: ServiceGroup::Messaging,
        }),
        2181 => Some(ServiceIdentity {
            id: "zookeeper",
            label: "ZooKeeper",
            group: ServiceGroup::Coordination,
        }),
        9200 | 9300 => Some(ServiceIdentity {
            id: "elasticsearch",
            label: "Elasticsearch",
            group: ServiceGroup::Search,
        }),
        2379 | 2380 => Some(ServiceIdentity {
            id: "etcd",
            label: "etcd",
            group: ServiceGroup::Coordination,
        }),
        _ => None,
    }
}

/// 从配置文件路径猜测服务（`/etc/mysql/my.cnf`、`/etc/nginx/nginx.conf` …）。
pub fn identify_config_path(path: &str) -> Option<ServiceIdentity> {
    let lower = path.to_ascii_lowercase();
    let hit = |needle: &str| lower.contains(needle);
    if hit("/etc/mysql") || hit("/etc/mariadb") || hit("my.cnf") {
        return Some(ServiceIdentity {
            id: "mysql",
            label: "MySQL",
            group: ServiceGroup::Database,
        });
    }
    if hit("/etc/postgresql") || hit("/var/lib/postgresql") || hit("postgresql.conf") {
        return Some(ServiceIdentity {
            id: "postgres",
            label: "PostgreSQL",
            group: ServiceGroup::Database,
        });
    }
    if hit("/etc/redis") || hit("redis.conf") {
        return Some(ServiceIdentity {
            id: "redis",
            label: "Redis",
            group: ServiceGroup::Cache,
        });
    }
    if hit("/etc/nginx") || hit("nginx.conf") {
        return Some(ServiceIdentity {
            id: "nginx",
            label: "Nginx",
            group: ServiceGroup::Gateway,
        });
    }
    if hit("/etc/mongodb") || hit("mongod.conf") {
        return Some(ServiceIdentity {
            id: "mongodb",
            label: "MongoDB",
            group: ServiceGroup::Database,
        });
    }
    if hit("/etc/rabbitmq") {
        return Some(ServiceIdentity {
            id: "rabbitmq",
            label: "RabbitMQ",
            group: ServiceGroup::Messaging,
        });
    }
    None
}

/// 端口的常见用途（用于 UI 着色与 tooltip），识别不出返回 `None`。
pub fn port_hint(port: u16) -> Option<&'static str> {
    identify_port(port).map(|service| service.label)
}

/// 镜像名归一化：去掉 registry 主机、命名空间前缀与 tag/digest，
/// 只留"软件名"那一段，便于子串匹配。
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

    /// 操作系统自带的服务必须被认出来，否则"Linux 自己跑的东西"会混进项目列表。
    #[test]
    fn operating_system_units_are_recognised() {
        for unit in [
            "sshd.service",
            "cron.service",
            "systemd-journald.service",
            "dbus.service",
            "getty@tty1.service",
            "containerd.service",
            "docker.service",
            "kubelet.service",
        ] {
            assert!(is_os_unit(unit), "{unit} 必须是系统自带服务");
        }
        assert!(!is_os_unit("my-app.service"));
        assert!(!is_os_unit("nginx.service"));
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
}
