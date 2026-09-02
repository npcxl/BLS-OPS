//! Kubernetes collector — `kubectl get pods --all-namespaces`.
//!
//! # Why this collector is separate from the Docker one
//!
//! 一台机器上"容器"和"k8s"可以层层嵌套：k8s 集群的节点上跑 docker/containerd
//! 来承载 Pod，而同一个 docker 里也可能同时有管理员手起的普通容器。二者的
//! 归属完全不同：
//!
//! - **普通容器 / Compose**：用户自己 `docker run` 的，源码通常在宿主 bind mount 上。
//! - **k8s Pod 容器**：由控制器（Deployment/StatefulSet…）调度出来的，源码在
//!   镜像里，**没有宿主目录**，也不该去找"项目目录"。
//!
//! `docker ps` 里 k8s 容器的名字以 `k8s_` 开头，docker 收集器据此把它们标成
//! `runtime = kubernetes`；本收集器则从**集群视角**补一层：用 kubectl 直接问
//! 集群"有哪些 Pod、跑的什么镜像"，两者互为印证而不是互相覆盖。
//!
//! 前置条件：kubectl 装了**且真的连得上集群**（先跑 `KubeNodes`）。连不上就
//! 如实报"无法连接集群"，绝不返回空列表冒充"没有工作负载"。

use super::model::{push_unique, DeploymentInstance};
use crate::remote::run_on_linux;
use crate::safe::Capability;
use crate::service_catalog::{identify_image, InstanceRuntime};
use crate::ssh::SshSessionManager;

/// 一次最多收录多少个 Pod（集群可以很大，这里只服务于"这台机器上有什么"）。
const MAX_PODS: usize = 300;

/// `kubectl get pods` 的一行（自定义列：NS NAME STATUS IMAGES）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KubePodRow {
    pub namespace: String,
    pub pod: String,
    pub status: String,
    /// 该 Pod 里的容器镜像（可能多个：业务容器 + sidecar）。
    pub images: Vec<String>,
}

pub(crate) async fn collect_k8s(
    session_id: &str,
    mgr: &SshSessionManager,
    warnings: &mut Vec<String>,
) -> anyhow::Result<Vec<DeploymentInstance>> {
    // 第一步：确认 kubectl 真能连上集群。装了客户端 ≠ 在集群里。
    let nodes = match run_on_linux(mgr, session_id, &Capability::KubeNodes).await {
        Ok(output) if !output.trim().is_empty() => output,
        Ok(_) => {
            warnings.push(
                "kubectl 已安装但查询不到节点：未连接到 Kubernetes 集群，跳过 k8s 工作负载收集"
                    .to_string(),
            );
            return Ok(Vec::new());
        }
        Err(error) => {
            warnings.push(format!(
                "无法连接 Kubernetes 集群（kubectl get nodes 失败：{error}），跳过 k8s 工作负载收集"
            ));
            return Ok(Vec::new());
        }
    };
    let node_count = nodes.lines().filter(|line| !line.trim().is_empty()).count();

    // 第二步：枚举所有命名空间下的 Pod。
    let listing = run_on_linux(mgr, session_id, &Capability::KubePods).await?;
    let mut instances = Vec::new();
    for row in parse_kube_pods(&listing).take(MAX_PODS) {
        instances.push(pod_instance(&row));
    }
    if !instances.is_empty() {
        warnings.push(format!(
            "已从 Kubernetes 集群（{node_count} 个节点）收录 {} 个 Pod",
            instances.len()
        ));
    }
    Ok(instances)
}

/// 解析 `kubectl get pods --all-namespaces -o custom-columns=…` 的输出。
///
/// 列之间由空白分隔：`NS NAME STATUS IMAGES`；镜像列是逗号分隔的列表，
/// 且整行只会剩这一列含多个 token。表头由 `--no-headers` 去掉，但某些版本
/// 仍会输出 `NS` 之类的列名行，识别到就跳过。
pub fn parse_kube_pods(output: &str) -> impl Iterator<Item = KubePodRow> + '_ {
    output.lines().filter_map(|line| {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 4 {
            return None;
        }
        let namespace = tokens[0].to_string();
        let pod = tokens[1].to_string();
        let status = tokens[2].to_string();
        // 表头行（列名就是 NS/NAME/STATUS/IMAGES）直接丢弃。
        if namespace == "NS" || pod == "NAME" {
            return None;
        }
        let images: Vec<String> = tokens[3..]
            .join(" ")
            .split(',')
            .map(str::trim)
            .filter(|image| !image.is_empty() && *image != "<none>")
            .map(str::to_string)
            .collect();
        Some(KubePodRow {
            namespace,
            pod,
            status,
            images,
        })
    })
}

/// 把一个 Pod 变成部署实例。
///
/// Pod 里的容器跑在**镜像**中，没有宿主机目录可指 —— 所以 `source_paths` 与
/// `working_directories` 一律为空、`source_known = false`。这不是漏扫，是
/// k8s 工作负载的真实形态；冒充一个宿主路径才是撒谎。
pub fn pod_instance(row: &KubePodRow) -> DeploymentInstance {
    // 一个 Pod 可能有 sidecar；以**第一个能识别出服务**的镜像作为服务身份，
    // 识别不出就留 `None`（例如纯业务镜像）。
    let service = row
        .images
        .iter()
        .filter_map(|image| identify_image(image))
        .next()
        .map(|identity| identity.detected());
    // 全都是基础设施镜像（pause 之类）时，这个 Pod 就是集群自身的组件。
    // 注意：一个镜像都没认出来时**不能**算集群组件（那是普通业务镜像，
    // 只是我们没见过），`all()` 对空集合返回 true，必须单独挡掉。
    let identified: Vec<_> = row
        .images
        .iter()
        .filter_map(|image| identify_image(image))
        .collect();
    let system_owned = !identified.is_empty()
        && identified.iter().all(|identity| {
            matches!(
                identity.group,
                crate::service_catalog::ServiceGroup::Infrastructure
            )
        });

    let mut detail = if row.images.is_empty() {
        "未声明镜像".to_string()
    } else {
        format!("镜像 {}", row.images.join(", "))
    };
    detail = format!("Pod {}/{} · {}", row.namespace, row.pod, detail);

    let mut images = Vec::new();
    for image in &row.images {
        push_unique(&mut images, image.clone());
    }

    DeploymentInstance {
        id: format!("k8s:{}/{}", row.namespace, row.pod),
        kind: "k8s".into(),
        name: row.pod.clone(),
        status: row.status.clone(),
        runtime: InstanceRuntime::Kubernetes,
        // 单容器 Pod 直接给镜像名；多容器 Pod 给首个镜像（完整列表在 detail）。
        image: row.images.first().cloned(),
        service,
        system_owned,
        ports: Vec::new(), // Service/Ingress 端口需要额外查询，暂不猜测
        working_directories: Vec::new(),
        config_files: Vec::new(),
        source_paths: Vec::new(),
        source_known: false,
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pod_rows_carry_every_container_image() {
        let rows: Vec<KubePodRow> = parse_kube_pods(
            "default   nginx-deploy-7d4b9   Running   nginx:1.24\n\
             kube-system   coredns-5dd5   Running   registry.k8s.io/coredns:1.11\n\
             app   api-0   Running   registry.local/team/api:1.2,istio/proxyv2:1.20\n\
             NS   NAME   STATUS   IMAGES\n",
        )
        .collect();
        assert_eq!(rows.len(), 3, "表头行必须被丢弃：{rows:?}");
        assert_eq!(rows[0].namespace, "default");
        assert_eq!(rows[0].pod, "nginx-deploy-7d4b9");
        assert_eq!(rows[0].status, "Running");
        assert_eq!(rows[0].images, vec!["nginx:1.24"]);
        // 多容器 Pod：业务容器 + sidecar 都要留下。
        assert_eq!(
            rows[2].images,
            vec!["registry.local/team/api:1.2", "istio/proxyv2:1.20"]
        );
    }

    #[test]
    fn a_pod_has_no_host_source_directory_and_says_so() {
        let row = KubePodRow {
            namespace: "app".into(),
            pod: "api-0".into(),
            status: "Running".into(),
            images: vec!["registry.local/team/api:1.2".into()],
        };
        let instance = pod_instance(&row);
        assert_eq!(instance.runtime, InstanceRuntime::Kubernetes);
        assert!(!instance.source_known, "Pod 里没有宿主源码目录，不能伪造");
        assert!(instance.source_paths.is_empty());
        assert!(instance.working_directories.is_empty());
        // 认不出来的业务镜像不能猜成某个服务。
        assert!(instance.service.is_none());
        assert!(!instance.system_owned);
    }

    #[test]
    fn nginx_in_kubernetes_is_recognised_as_a_gateway() {
        let row = KubePodRow {
            namespace: "default".into(),
            pod: "nginx-deploy-7d4b9".into(),
            status: "Running".into(),
            images: vec!["nginx:1.24".into()],
        };
        let instance = pod_instance(&row);
        let service = instance.service.expect("nginx 镜像必须被识别");
        assert_eq!(service.id, "nginx");
        assert_eq!(service.label, "Nginx");
        // 网关属于基础设施，不是业务项目。
        assert!(service.group.is_infrastructure());
    }

    #[test]
    fn cluster_owned_pods_are_marked_system_owned() {
        let row = KubePodRow {
            namespace: "kube-system".into(),
            pod: "coredns-5dd5".into(),
            status: "Running".into(),
            images: vec!["registry.k8s.io/pause:3.9".into()],
        };
        let instance = pod_instance(&row);
        assert!(instance.system_owned, "集群自身的 Pod 属于系统组件");
    }
}
