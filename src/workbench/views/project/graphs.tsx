import { cn } from "@/lib/cn";
import type {
  DeploymentInstance,
  ServerCapabilityProfile,
} from "@/api/ops-api";
import { Detail } from "./Detail";

/**
 * 运行形态总览：宿主机进程 / Docker 容器 / Kubernetes Pod 各有多少，
 * 以及每个被认出来的服务（Nginx、MySQL…）分别跑在哪一层。
 *
 * 这一块存在的理由：**容器化和编排是可以层层嵌套的** —— k8s 集群用 docker
 * 承载 Pod，同一个 docker 里又可能有管理员手起的普通容器。只看
 * "服务器装了 docker / nginx 没有" 会得出错误结论（"这台机器有 Nginx"，
 * 而实际上 Nginx 只存在于某个容器里）。
 */
export function RuntimeComposition({ instances }: { instances: DeploymentInstance[] }) {
  if (instances.length === 0) return null;
  const host = instances.filter((i) => i.runtime === "host").length;
  const container = instances.filter((i) => i.runtime === "container").length;
  const kubernetes = instances.filter((i) => i.runtime === "kubernetes").length;

  // 服务 → 各层数量。认不出来的服务不进表（不猜）。
  const byService = new Map<string, { label: string; host: number; container: number; k8s: number }>();
  for (const instance of instances) {
    const service = instance.service;
    if (!service) continue;
    const row = byService.get(service.id) ?? {
      label: service.label,
      host: 0,
      container: 0,
      k8s: 0,
    };
    if (instance.runtime === "host") row.host += 1;
    else if (instance.runtime === "container") row.container += 1;
    else row.k8s += 1;
    byService.set(service.id, row);
  }

  const layer = (label: string, count: number, tone: string) =>
    count > 0 ? (
      <span className={cn("rounded px-1.5 py-0.5 text-10", tone)}>
        {label} {count}
      </span>
    ) : null;

  return (
    <div className="rounded-[8px] border border-line bg-surface-1 px-3 py-2 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          运行形态
        </span>
        {layer("宿主机", host, "bg-surface-2 text-fg-muted")}
        {layer("Docker 容器", container, "bg-[#0ea5e9]/12 text-[#0369a1]")}
        {layer("Kubernetes Pod", kubernetes, "bg-[#6366f1]/12 text-[#4338ca]")}
        {container > 0 && kubernetes > 0 && (
          <span className="text-10 text-fg-subtle">
            （Kubernetes 常用 Docker/containerd 承载 Pod，两者会同时出现，已按归属分开计数）
          </span>
        )}
      </div>
      {byService.size > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {[...byService.values()].map((row) => (
            <span key={row.label} className="text-10 text-fg-muted">
              <strong className="text-fg">{row.label}</strong>
              {"："}
              {row.host > 0 && `宿主机 ${row.host}`}
              {row.container > 0 && ` · 容器 ${row.container}`}
              {row.k8s > 0 && ` · k8s ${row.k8s}`}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function CapabilityGraph({ profile }: { profile: ServerCapabilityProfile }) {
  const sys = profile.system;
  const sysFacts = [
    `操作系统：${sys.os || "未知"}`,
    `架构：${sys.arch || "未知"}`,
    `初始化系统：${sys.init_system || "未知"}`,
    `包管理器：${sys.package_manager || "未知"}`,
    `当前用户：${sys.user || "未知"}`,
    `sudo：${sys.sudo === null ? "无法判定" : sys.sudo ? "可用" : "不可用"}`,
    `安全模块：${sys.security_module || "未知"}`,
    `cgroup：${sys.cgroup_version || "未知"}`,
  ];
  const runtimes = Object.entries(profile.runtimes).filter(([, v]) => v) as [string, string][];
  const buildTools = Object.entries(profile.build_tools).filter(([, v]) => v) as [string, string][];
  const vm = Object.entries(profile.version_managers).filter(([, v]) => v) as [string, string][];
  const deployment = Object.entries(profile.deployment) as [string, boolean | null][];
  const enabled = deployment.filter(([, v]) => v === true).map(([k]) => k);
  const missing = deployment.filter(([, v]) => v === false).map(([k]) => k);

  return (
    <section className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-3">
        <span className="rounded-full bg-accent/12 px-2 py-0.5 text-10 font-medium text-accent">
          服务器能力图谱
        </span>
        <span className="text-11 text-fg-subtle">先识别服务器，再决定启用哪些收集器</span>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <Detail title="系统档案" items={sysFacts} />
        <Detail title="运行时" items={runtimes.map(([k, v]) => `${k} ${v}`)} />
        {buildTools.length > 0 && <Detail title="构建工具" items={buildTools.map(([k, v]) => `${k} ${v}`)} />}
        {vm.length > 0 && <Detail title="版本管理器" items={vm.map(([k]) => k)} />}
        <Detail title="已启用的能力收集器" items={enabled.length ? enabled : ["（无）"]} />
        {missing.length > 0 && (
          <div className="rounded-[8px] border border-dashed border-line px-3 py-2 text-10 text-fg-subtle lg:col-span-2">
            未安装（不启用收集器，避免无意义报错）：{missing.join("、")}
          </div>
        )}
      </div>
    </section>
  );
}
