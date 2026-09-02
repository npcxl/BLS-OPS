import { useState } from "react";
import { CircleAlert, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DeploymentInstance } from "@/api/ops-api";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  instanceKindMeta,
} from "./badges";

/**
 * 第一轮部署实例清单：真实容器 / 服务 / 站点 / k8s 工作负载。
 *
 * 两条铁律：
 * - `source_known === false` 的实例明确标为"源码未知"，绝不猜测路径。
 * - **操作系统自带的实例（sshd / cron / containerd / kubelet / k8s 沙箱容器）
 *   默认折叠不显示** —— 它们不是用户部署的东西，列出来只会淹没真正的业务
 *   实例。想知道扫到了什么可以展开看。
 */
export function InstanceList({ instances }: { instances: DeploymentInstance[] }) {
  const [showSystem, setShowSystem] = useState(false);
  if (instances.length === 0) return null;
  const systemOwned = instances.filter((instance) => instance.system_owned);
  const visible = showSystem ? instances : instances.filter((i) => !i.system_owned);
  const unknown = visible.filter((instance) => !instance.source_known).length;

  return (
    <section className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-3">
        <span className="rounded-full bg-accent/12 px-2 py-0.5 text-10 font-medium text-accent">
          部署实例
        </span>
        <span className="text-11 text-fg-subtle">
          {visible.length} 个实例 · {unknown} 个源码未知
        </span>
        {systemOwned.length > 0 && (
          <button
            type="button"
            onClick={() => setShowSystem((value) => !value)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-10 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
            title="sshd、cron、containerd、kubelet、k8s 沙箱容器等属于系统组件，不是用户部署的服务"
          >
            <EyeOff size={10} />
            {showSystem ? "隐藏" : "显示"}系统自带（{systemOwned.length}）
          </button>
        )}
      </div>
      <div className="divide-y divide-line/70">
        {visible.map((instance) => {
          const meta = instanceKindMeta(instance.kind);
          const Icon = meta.icon;
          return (
            <div
              key={instance.id}
              className={cn(
                "flex items-start gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover/50",
                instance.system_owned && "opacity-60",
              )}
            >
              <Icon size={14} className="mt-1 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="truncate text-12 text-fg">{instance.name}</strong>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                    {meta.label}
                  </span>
                  {/* 跑在哪里：宿主机 / Docker / k8s。k8s 常用 docker 承载 Pod，
                      单看 kind 分不出来，必须看这个。 */}
                  <RuntimeBadge runtime={instance.runtime} />
                  <ServiceBadge service={instance.service} />
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-10",
                      instance.system_owned
                        ? "bg-surface-2 text-fg-subtle"
                        : instance.source_known
                          ? "bg-success/12 text-success"
                          : "bg-warning/12 text-warning",
                    )}
                  >
                    {instance.system_owned
                      ? "系统自带"
                      : instance.source_known
                        ? "已关联源码"
                        : "源码未知"}
                  </span>
                  {instance.status && (
                    <span className="text-10 text-fg-subtle">{instance.status}</span>
                  )}
                </div>
                <div className="mt-1.5">
                  <PortChips ports={instance.ports} empty="" />
                </div>
                {instance.source_paths.length > 0 && (
                  <div
                    className="mt-1 truncate font-mono text-10 text-fg-subtle"
                    title={instance.source_paths.join("\n")}
                  >
                    {instance.source_paths.join("  ·  ")}
                  </div>
                )}
                {instance.detail && (
                  <div className="mt-0.5 truncate text-10 text-fg-subtle" title={instance.detail}>
                    {instance.detail}
                  </div>
                )}
              </div>
              {!instance.source_known && !instance.system_owned && (
                <CircleAlert size={13} className="mt-1.5 shrink-0 text-warning" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
