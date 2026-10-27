import { useMemo, useState } from "react";
import { Boxes } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance } from "@/api/ops-api";
import { instanceRole } from "../classify";
import { RuntimeInstanceCard } from "../runtime-instance-card";

type Filter = "all" | "linked" | "unlinked" | "unclassified" | "stopped";

/** 筛选名存英文 key，渲染处 t()（模块级常量不能调 hook）。 */
const FILTERS: { id: Filter; labelKey: string }[] = [
  { id: "all", labelKey: "All apps" },
  { id: "linked", labelKey: "Linked to projects" },
  { id: "unlinked", labelKey: "Unlinked" },
  { id: "unclassified", labelKey: "Unclassified" },
  { id: "stopped", labelKey: "Stopped" },
];

/**
 * 应用服务 tab：只展示后端判定为 `application` 的运行实例
 * （Node/Java/Go 业务进程、项目专属容器等），外加"待归类"实例供筛选查看。
 * MySQL/Redis 这类基础设施在「基础设施」tab —— 两个 tab 互斥，不会重复。
 *
 * 每张卡片各自持有右键菜单（动作要碰会话与工作台标签页），所以卡片是独立
 * 组件 `RuntimeInstanceCard`；这里只负责筛选与计数。
 */
export function TabRuntime({
  instances,
  serverId,
  sessionId,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  /** 服务器与会话：右键里的容器 / Nginx 动作走它们。 */
  serverId: string;
  sessionId: string;
  onOpenPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("all");

  // 已关联项目 = 后端回填的 linked_project_ids 非空；待归类 = workload_role 缺证据。
  const counts = useMemo(() => {
    const linked = instances.filter((i) => i.linked_project_ids.length > 0).length;
    const unlinked = instances.filter(
      (i) => i.linked_project_ids.length === 0 && instanceRole(i) === "application",
    ).length;
    const unclassified = instances.filter((i) => instanceRole(i) === "unknown").length;
    const stopped = instances.filter((i) => i.status && i.status !== "running").length;
    return { all: instances.length, linked, unlinked, unclassified, stopped };
  }, [instances]);

  const visible = useMemo(() => {
    switch (filter) {
      case "linked":
        return instances.filter((i) => i.linked_project_ids.length > 0);
      case "unlinked":
        return instances.filter(
          (i) => i.linked_project_ids.length === 0 && instanceRole(i) === "application",
        );
      case "unclassified":
        return instances.filter((i) => instanceRole(i) === "unknown");
      case "stopped":
        return instances.filter((i) => i.status && i.status !== "running");
      default:
        return instances;
    }
  }, [instances, filter]);

  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Boxes}
        title={t("No app services")}
        hint={t(
          "Only running instances the backend classified as business apps are listed here (Node/Java/Go processes, project-scoped containers…). Dependencies like MySQL and Redis live in the Infrastructure tab; unrecognized instances are marked unclassified and never pose as business apps.",
        )}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-10 transition-colors",
              filter === f.id
                ? "bg-accent/15 text-accent"
                : "bg-surface-2 text-fg-subtle hover:text-fg",
            )}
          >
            {t(f.labelKey)}
            <span className="ml-1 tabular-nums opacity-70">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-11 text-fg-subtle">{t("No instances match this filter.")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((instance) => (
            <RuntimeInstanceCard
              key={instance.id}
              instance={instance}
              serverId={serverId}
              sessionId={sessionId}
              onOpenPath={onOpenPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}
