import { useTranslation } from "react-i18next";
import type { ServerCapabilityProfile } from "@/api/ops-api";
import { Detail } from "./Detail";

/**
 * 服务器能力图谱：只描述"这台机器是什么、能做什么收集"，与项目身份无关。
 * 容器 / 运行实例等运行形态已拆到独立的「运行服务 / 基础设施」tab，不在这里列。
 */
export function CapabilityGraph({ profile }: { profile: ServerCapabilityProfile }) {
  const { t } = useTranslation();
  const sys = profile.system;
  const unknown = t("Unknown");
  const sysFacts = [
    t("OS: {{value}}", { value: sys.os || unknown }),
    t("Arch: {{value}}", { value: sys.arch || unknown }),
    t("Init system: {{value}}", { value: sys.init_system || unknown }),
    t("Package manager: {{value}}", { value: sys.package_manager || unknown }),
    t("Current user: {{value}}", { value: sys.user || unknown }),
    t("sudo: {{value}}", {
      value: sys.sudo === null ? t("Undetermined") : sys.sudo ? t("Available") : t("Unavailable"),
    }),
    t("Security module: {{value}}", { value: sys.security_module || unknown }),
    t("cgroup: {{value}}", { value: sys.cgroup_version || unknown }),
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
          {t("Server capability profile")}
        </span>
        <span className="text-11 text-fg-subtle">{t("Identify the server first, then decide which collectors to enable")}</span>
      </div>
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <Detail title={t("System profile")} items={sysFacts} />
        <Detail title={t("Runtimes")} items={runtimes.map(([k, v]) => `${k} ${v}`)} />
        {buildTools.length > 0 && <Detail title={t("Build tools")} items={buildTools.map(([k, v]) => `${k} ${v}`)} />}
        {vm.length > 0 && <Detail title={t("Version managers")} items={vm.map(([k]) => k)} />}
        <Detail title={t("Enabled capability collectors")} items={enabled.length ? enabled : [t("(none)")]} />
        {missing.length > 0 && (
          <div className="rounded-[8px] border border-dashed border-line px-3 py-2 text-10 text-fg-subtle lg:col-span-2">
            {t("Not installed (collectors disabled to avoid pointless errors): {{tools}}", {
              tools: missing.join(", "),
            })}
          </div>
        )}
      </div>
    </section>
  );
}
