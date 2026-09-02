import { useState } from "react";
import {
  Check,
  ChevronRight,
  EyeOff,
  FileCode2,
  FolderOpen,
  FolderSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import type { ProjectCandidate, ReviewState } from "@/api/ops-api";
import { Detail } from "./Detail";
import {
  PortChips,
  ProjectKindBadge,
  RuntimeBadge,
  ServiceBadge,
  configFileLabel,
  instanceKindMeta,
} from "./badges";

export function CandidateCard({
  candidate,
  onOpenPath,
  serverId,
  review,
  onReview,
}: {
  candidate: ProjectCandidate;
  /** 在右侧文件面板打开某个路径（目录或文件）。 */
  onOpenPath: (path: string) => void;
  /** 服务器 ID，写复核结论用。 */
  serverId: string;
  /** 当前复核结论（由父组件从扫描结果 / 本地状态合并而来）。 */
  review: ReviewState;
  /** 用户确认 / 忽略后回调，父组件据此刷新列表。 */
  onReview: (path: string, state: ReviewState) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<ReviewState | null>(null);
  const running = candidate.runtime_links.length > 0;
  const confidence =
    candidate.confidence === "high"
      ? "高置信度"
      : candidate.confidence === "likely"
        ? "待确认"
        : "可能项目";
  const instances = candidate.deploy_instances ?? [];
  // 候选自身端口为空时（systemd 不报端口），用关联实例的端口补齐展示。
  const ports = candidate.detected_ports.length
    ? candidate.detected_ports
    : Array.from(new Set(instances.flatMap((instance) => instance.ports))).sort(
        (a, b) => a - b,
      );

  const submitReview = async (state: ReviewState) => {
    setBusy(state);
    try {
      await opsApi.projectReviewSet(
        serverId,
        candidate.path,
        state,
        candidate.name,
        candidate.project_type,
      );
      onReview(candidate.path, state);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-shadow hover:shadow-[0_2px_6px_rgb(15_23_42/0.07)]">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover/60"
        onClick={() => setExpanded((value) => !value)}
      >
        <FolderSearch size={16} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="truncate text-13 text-fg">{candidate.name}</strong>
            <ProjectKindBadge kind={candidate.project_kind} />
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-10",
                candidate.confidence === "high"
                  ? "bg-success/12 text-success"
                  : "bg-warning/12 text-warning",
              )}
            >
              {confidence} · {candidate.score} 分
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-10",
                candidate.category === "deployed"
                  ? "bg-accent/12 text-accent"
                  : "bg-surface-2 text-fg-subtle",
              )}
            >
              {candidate.category === "deployed" ? "已部署" : "仅源码"}
            </span>
            {running && <span className="text-10 text-success">正在运行</span>}
            {review === "confirmed" && (
              <span className="rounded bg-success/12 px-1.5 py-0.5 text-10 text-success">
                已确认
              </span>
            )}
            {review === "ignored" && (
              <span className="rounded bg-surface-3 px-1.5 py-0.5 text-10 text-fg-subtle">
                已忽略
              </span>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-11 text-fg-muted" title={candidate.path}>
            {candidate.path}
          </div>
          {/* 端口是重要数据：单独一行等宽 chip，认得的服务直接标出来 */}
          <div className="mt-1.5">
            <PortChips ports={ports} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {instances.slice(0, 3).map((instance) => (
              <span
                key={instance.id}
                className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-10"
              >
                <RuntimeBadge runtime={instance.runtime} className="bg-transparent p-0" />
                <ServiceBadge service={instance.service} />
              </span>
            ))}
            <span className="text-10 text-fg-subtle">
              {candidate.project_type} · {candidate.modules.length} 个模块 · 准备度{" "}
              {candidate.readiness.score}
            </span>
          </div>
        </div>
        <ChevronRight
          size={14}
          className={cn(
            "shrink-0 text-fg-subtle transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>

      {expanded && (
        <div className="border-t border-line px-4 py-3 text-11">
          {/* 部署文件：直接跳到项目目录或具体配置文件 */}
          <DeploymentFiles
            candidate={candidate}
            instances={instances}
            onOpenPath={onOpenPath}
          />

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Detail
              title="判定依据"
              items={candidate.evidence.map(
                (item) => `+${item.weight} ${item.summary}（${item.source}）`,
              )}
            />
            <div className="space-y-4">
              <Detail
                title="扣分与风险"
                items={candidate.penalties.map((item) => `-${item.weight} ${item.summary}`)}
              />
              <Detail
                title="运行关联"
                items={candidate.runtime_links.map(
                  (item) =>
                    `${item.kind}：${item.name}${item.ports.length ? ` · 端口 ${item.ports.join(", ")}` : ""}${item.service ? ` · ${item.service.label}` : ""}`,
                )}
              />
            </div>
            <div className="space-y-4 lg:col-span-2">
              <Detail title="环境变量名称" items={candidate.required_environment_names} />
              <Detail
                title="部署准备"
                items={[
                  ...candidate.readiness.blockers.map((item) => `阻塞：${item}`),
                  ...candidate.readiness.warnings.map((item) => `警告：${item}`),
                  ...candidate.readiness.confirmed_facts,
                ]}
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-1 border-t border-line pt-3">
            {review !== "confirmed" && (
              <Button
                variant="secondary"
                size="xs"
                disabled={busy !== null}
                onClick={() => void submitReview("confirmed")}
              >
                <Check size={11} />
                {busy === "confirmed" ? "保存中…" : "确认项目"}
              </Button>
            )}
            {review !== "ignored" && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                onClick={() => void submitReview("ignored")}
              >
                <EyeOff size={11} />
                {busy === "ignored" ? "保存中…" : "忽略目录"}
              </Button>
            )}
            {(review === "confirmed" || review === "ignored") && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                onClick={() => void submitReview("pending")}
              >
                撤销结论
              </Button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * 部署文件入口：点一下就在右侧文件面板打开对应目录 / 文件。
 *
 * 两种情况必须如实呈现，不能给假入口：
 * - 镜像运行的实例（k8s Pod、纯镜像容器）**没有宿主机配置文件** → 明说。
 * - 实例既没有配置也没有工作目录 → 只留"运行实例，源码未知"。
 */
function DeploymentFiles({
  candidate,
  instances,
  onOpenPath,
}: {
  candidate: ProjectCandidate;
  instances: NonNullable<ProjectCandidate["deploy_instances"]>;
  onOpenPath: (path: string) => void;
}) {
  if (instances.length === 0) {
    return (
      <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-11 text-fg-subtle">仅源码，未关联到运行实例</span>
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onOpenPath(candidate.path)}
            title={`在文件面板打开 ${candidate.path}`}
          >
            <FolderOpen size={11} />
            查看项目文件
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          部署文件
        </span>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => onOpenPath(candidate.path)}
          title={`在文件面板打开 ${candidate.path}`}
        >
          <FolderOpen size={11} />
          打开项目目录
        </Button>
      </div>
      <div className="space-y-2">
        {instances.map((instance) => {
          const meta = instanceKindMeta(instance.kind);
          const Icon = meta.icon;
          return (
            <div key={instance.id} className="flex flex-wrap items-start gap-1.5">
              <span className="mt-[3px] inline-flex shrink-0 items-center gap-1 text-10 text-fg-muted">
                <Icon size={11} />
                {instance.name}
              </span>
              <RuntimeBadge runtime={instance.runtime} />
              <ServiceBadge service={instance.service} />
              <PortChips ports={instance.ports} empty="" />
              <span className="flex-1" />
              {instance.config_files.length > 0 ? (
                instance.config_files.map((file) => (
                  <Button
                    key={file}
                    variant="ghost"
                    size="xs"
                    onClick={() => onOpenPath(file)}
                    title={`打开 ${file}`}
                  >
                    <FileCode2 size={11} />
                    {configFileLabel(file)}
                  </Button>
                ))
              ) : (
                // 镜像跑起来的 MySQL、k8s Pod 之类真的没有宿主配置文件 ——
                // 如实说，不给假按钮。
                <span className="text-10 text-fg-subtle">
                  {instance.image
                    ? "镜像运行，宿主机上没有配置文件"
                    : "没有可用的配置文件"}
                </span>
              )}
              {instance.working_directories.length > 0 && (
                <span
                  className="w-full truncate font-mono text-10 text-fg-subtle"
                  title={instance.working_directories.join("\n")}
                >
                  {instance.working_directories.join("  ·  ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
