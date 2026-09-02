import { Boxes } from "lucide-react";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { DeploymentInstance } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
} from "../badges";

/**
 * 未关联服务 tab：扫描到的运行实例里，**源码未知**（只有运行实例、没找到宿主
 * 项目目录）的部分。这类通常是数据库 / 缓存 / 网关等基础设施，或纯镜像容器，
 * 不应和业务项目混排，单独一屏看清楚。
 */
export function TabUnlinked({
  instances,
  onOpenPath,
}: {
  instances: DeploymentInstance[];
  onOpenPath: (path: string) => void;
}) {
  if (instances.length === 0) {
    return (
      <ModuleEmpty
        icon={Boxes}
        title="没有源码未知的服务"
        hint="所有运行实例都关联到了宿主项目目录，或本次扫描没有发现未关联实例。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-11 text-fg-subtle">
        这些是正在运行、但没找到对应源码目录的实例（多为数据库 / 缓存 / 网关等基础设施，或纯镜像容器）。它们不是要部署的业务项目。
      </p>
      {instances.map((instance) => {
        const meta = instanceKindMeta(instance.kind);
        const Icon = meta.icon;
        return (
          <article
            key={instance.id}
            className="overflow-hidden rounded-[12px] border border-line bg-surface-1 px-4 py-3 shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Icon size={15} className="shrink-0 text-accent" />
              <strong className="text-13 text-fg">{instance.name}</strong>
              <RuntimeBadge runtime={instance.runtime} />
              <ServiceBadge service={instance.service} />
              <span className="text-10 text-fg-subtle">{instance.kind}</span>
              {instance.status && (
                <span className="text-10 text-success">{instance.status}</span>
              )}
            </div>
            <div className="mt-1.5">
              <PortChips ports={instance.ports} empty="无暴露端口" />
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-10 text-fg-subtle">
              <span className="rounded bg-surface-2 px-1.5 py-0.5">源码未知</span>
              {instance.working_directories.map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className="font-mono text-fg-muted hover:text-fg"
                  onClick={() => onOpenPath(dir)}
                  title={`在文件面板打开 ${dir}`}
                >
                  {dir}
                </button>
              ))}
            </div>
            {instance.config_files.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {instance.config_files.map((file) => (
                  <button
                    key={file}
                    type="button"
                    className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted hover:text-fg"
                    onClick={() => onOpenPath(file)}
                    title={`打开 ${file}`}
                  >
                    {file}
                  </button>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
