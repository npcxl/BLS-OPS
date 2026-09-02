import { cn } from "@/lib/cn";
import type { AdapterReadiness, ServerCapabilityProfile } from "@/api/ops-api";
import { Detail } from "./Detail";

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
  const runtimes = Object.entries(profile.runtimes).filter(([, v]) => v) as [
    string,
    string,
  ][];
  const buildTools = Object.entries(profile.build_tools).filter(
    ([, v]) => v,
  ) as [string, string][];
  const vm = Object.entries(profile.version_managers).filter(([, v]) => v) as [
    string,
    string,
  ][];
  const deployment = Object.entries(profile.deployment) as [
    string,
    boolean | null,
  ][];
  const enabled = deployment.filter(([, v]) => v === true).map(([k]) => k);
  const missing = deployment.filter(([, v]) => v === false).map(([k]) => k);
  return (
    <section className="rounded-[10px] border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-1 text-11 font-medium text-fg">
        <span className="rounded bg-accent/12 px-2 py-0.5 text-accent">
          服务器能力图谱
        </span>
        <span className="text-fg-subtle">
          先识别服务器，再决定启用哪些收集器
        </span>
      </div>
      <Detail title="系统档案" items={sysFacts} />
      <Detail title="运行时" items={runtimes.map(([k, v]) => `${k} ${v}`)} />
      {buildTools.length > 0 && (
        <Detail
          title="构建工具"
          items={buildTools.map(([k, v]) => `${k} ${v}`)}
        />
      )}
      {vm.length > 0 && (
        <Detail title="版本管理器" items={vm.map(([k]) => k)} />
      )}
      <Detail
        title="已启用的能力收集器"
        items={enabled.length ? enabled : ["（无）"]}
      />
      {missing.length > 0 && (
        <div className="mt-2 text-10 text-fg-subtle">
          未安装（不启用收集器，避免无意义报错）：{missing.join("、")}
        </div>
      )}
    </section>
  );
}

const READINESS_LABEL: Record<string, string> = {
  ready: "可直接部署",
  needs_install: "需安装",
  conflict: "冲突",
  unconfirmed: "无法确认",
};

export function ReadinessGraph({ items }: { items: AdapterReadiness[] }) {
  const verdictClass = (v: string) =>
    v === "ready"
      ? "bg-success/12 text-success"
      : v === "needs_install"
        ? "bg-warning/12 text-warning"
        : v === "conflict"
          ? "bg-danger/12 text-danger"
          : "bg-surface-3 text-fg-subtle";
  return (
    <section className="rounded-[10px] border border-line bg-surface-1 p-3">
      <div className="mb-2 text-11 font-medium text-fg">
        <span className="rounded bg-accent/12 px-2 py-0.5 text-accent">
          部署可行性图谱
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.adapter}
            className="flex items-center justify-between gap-2 rounded-[6px] border border-line px-2 py-1.5"
          >
            <span className="truncate text-11 text-fg">{item.adapter}</span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-10",
                verdictClass(item.verdict),
              )}
            >
              {READINESS_LABEL[item.verdict] ?? item.verdict}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-10 text-fg-subtle">
        未确认的部署方式不会猜测为支持；需安装的方式由 P4 决定是否处理。
      </div>
    </section>
  );
}
