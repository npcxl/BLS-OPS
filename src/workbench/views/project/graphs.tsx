import type { ServerCapabilityProfile } from "@/api/ops-api";
import { Detail } from "./Detail";

/**
 * 服务器能力图谱：只描述"这台机器是什么、能做什么收集"，与项目身份无关。
 * 容器 / 运行实例等运行形态已拆到独立的「运行服务 / 基础设施」tab，不在这里列。
 */
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
