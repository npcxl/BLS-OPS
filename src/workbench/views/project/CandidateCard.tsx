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
import type {
  ConfirmedScanState,
  DiscoveryStatus,
  ProjectCandidate,
  ReviewState,
} from "@/api/ops-api";
import { Detail } from "./Detail";
import {
  PortChips,
  RuntimeBadge,
  ServiceBadge,
  configFileLabel,
  instanceKindMeta,
} from "./badges";

/**
 * 候选状态徽标：优先级为「已确认 > 高可信 > 待确认 > 可能目录」。
 * 一旦人工确认，它就是确认资产，不再回退成"可能项目" —— 分数只是内部证据，
 * 不能覆盖人的结论。
 */
const STATUS_META: Record<
  DiscoveryStatus,
  { label: string; tone: string }
> = {
  confirmed: { label: "已确认", tone: "bg-success/12 text-success" },
  high_confidence: { label: "高可信", tone: "bg-accent/12 text-accent" },
  needs_confirm: { label: "待确认", tone: "bg-warning/12 text-warning" },
  possible_dir: { label: "可能目录", tone: "bg-surface-2 text-fg-subtle" },
  running_service: { label: "运行服务", tone: "bg-[#6366f1]/12 text-[#4338ca]" },
  not_project: { label: "非项目", tone: "bg-surface-3 text-fg-subtle" },
};

/**
 * 已确认项目跨扫描的持久化状态。仅在「项目」tab 的卡片上出现；
 * 待确认 / 本次新发现的高可信候选没有这部分信息。
 */
export interface ScanInfo {
  /** 本次扫描对该已确认项目的态度：active / missing / inaccessible / changed。 */
  scanState?: ConfirmedScanState;
  /** 系统重新将其分类为基础设施，但用户曾确认是业务项目 → 需复核。 */
  kindChanged?: boolean;
  /** 本次扫描未再发现该路径（快照仍在，仅供展示）。 */
  confirmedMissing?: boolean;
}

/** 已确认项目的持久化状态徽标：覆盖在「已确认」之上，提示跨扫描变化。 */
const SCAN_STATE_META: Record<
  ConfirmedScanState,
  { label: string; tone: string }
> = {
  active: { label: "本次已发现", tone: "bg-success/12 text-success" },
  missing: { label: "本次未发现", tone: "bg-warning/14 text-warning" },
  inaccessible: { label: "服务器不可访问", tone: "bg-danger/14 text-danger" },
  changed: { label: "信息有变化", tone: "bg-accent/14 text-accent" },
};

export function CandidateCard({
  candidate,
  onOpenPath,
  onClosePath,
  serverId,
  review,
  onReview,
  scanInfo,
}: {
  candidate: ProjectCandidate;
  /** 在右侧文件面板打开某个路径（目录或文件）。 */
  onOpenPath: (path: string) => void;
  /** 收起右侧文件面板（与「打开项目目录」成对，点开后再点收起）。 */
  onClosePath: () => void;
  /** 服务器 ID，写复核结论用。 */
  serverId: string;
  /** 当前复核结论（由父组件从扫描结果 / 本地状态合并而来）。 */
  review: ReviewState;
  /** 用户确认 / 忽略后回调，父组件据此刷新列表。 */
  onReview: (path: string, state: ReviewState) => void;
  /** 已确认项目的跨扫描持久化状态；非确认卡片不传。 */
  scanInfo?: ScanInfo;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [busy, setBusy] = useState<ReviewState | null>(null);
  const running = candidate.runtime_links.length > 0;
  // 最终展示状态 = 人工结论优先覆盖算法结论（candidate.status 只是算法发现结论）。
  // 重扫后后端会把 status 改回 confirmed，人工 review 与它合并成**一枚**标签，
  // 绝不渲染两枚"已确认"。
  const displayStatus: DiscoveryStatus | "ignored" =
    review === "confirmed"
      ? "confirmed"
      : review === "ignored"
        ? "ignored"
        : candidate.status;
  const statusMeta =
    displayStatus === "ignored"
      ? { label: "已忽略", tone: "bg-surface-3 text-fg-subtle" }
      : (STATUS_META[displayStatus] ?? STATUS_META.possible_dir);
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
      // 确认项目时随附当前候选完整快照，后端据此持久化，后续扫描即使没再
      // 发现该路径也能继续保留已确认项目。忽略/撤销不需要快照。
      const payload = state === "confirmed" ? JSON.stringify(candidate) : undefined;
      await opsApi.projectReviewSet(
        serverId,
        candidate.path,
        state,
        candidate.name,
        candidate.project_type,
        undefined,
        payload,
      );
      onReview(candidate.path, state);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)] transition-shadow hover:shadow-[0_2px_6px_rgb(15_23_42/0.07)]">
      <div className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <FolderSearch size={16} className="shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <strong className="truncate text-13 text-fg">{candidate.name}</strong>
            {/* 主状态标签（唯一一枚）：人工结论优先覆盖算法结论。
                project_kind 不再上卡片：能进项目/待确认列表的都是业务项目候选，
                基础设施改判场景已由「信息有变化」徽标提示复核。 */}
            <span className={cn("rounded px-1.5 py-0.5 text-10", statusMeta.tone)}>
              {statusMeta.label}
            </span>
            {/* 已确认项目的跨扫描状态：本次是否又被发现、信息是否变化、服务器是否不可访问。
                这些只在 review === "confirmed" 且 scanInfo 存在时才有意义（来自持久化快照）。 */}
            {review === "confirmed" && scanInfo?.scanState && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-10",
                  SCAN_STATE_META[scanInfo.scanState].tone,
                )}
              >
                {SCAN_STATE_META[scanInfo.scanState].label}
              </span>
            )}
            {review === "confirmed" && scanInfo?.kindChanged && (
              <span className="rounded bg-warning/14 px-1.5 py-0.5 text-10 text-warning">
                信息有变化
              </span>
            )}
            {review === "confirmed" && scanInfo?.confirmedMissing && (
              <span className="rounded bg-warning/14 px-1.5 py-0.5 text-10 text-warning">
                本次未发现
              </span>
            )}
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
            {candidate.status === "confirmed" && instances.length > 0 && (
              <span className="text-10 text-fg-subtle">
                · {instances.map((i) => instanceKindMeta(i.kind).label).join("/")}
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
      </div>

      {/* 部署文件：默认收起，点「部署文件」才展开；展开后右下角有「证据详情」 */}
      <div className="border-t border-line">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-4 py-2 text-11 text-fg-subtle transition-colors hover:bg-surface-hover/60 hover:text-fg"
          onClick={() => setShowDeploy((value) => !value)}
        >
          <ChevronRight
            size={12}
            className={cn("transition-transform", showDeploy && "rotate-90")}
          />
          部署文件
        </button>
        {showDeploy && (
          <div className="px-4 pb-3 pt-1">
            <DeploymentFiles
              candidate={candidate}
              instances={instances}
              onOpenPath={onOpenPath}
              open={deployOpen}
              onToggle={() => {
                if (deployOpen) {
                  onClosePath();
                  setDeployOpen(false);
                } else {
                  onOpenPath(candidate.path);
                  setDeployOpen(true);
                }
              }}
            />
            {/* 证据详情：部署文件右下角的小展开按钮，点开才显示评分 / 判定依据等 */}
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExpanded((value) => !value)}
              >
                <ChevronRight
                  size={12}
                  className={cn("transition-transform", expanded && "rotate-90")}
                />
                {expanded ? "收起证据详情" : "证据详情"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3 text-11">
          {/* 证据 / 评分细节：默认收起，点展开才看，避免卡片一打开就一堆数字 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Detail
              title={`发现结论：${statusMeta.label}（评分 ${candidate.score}）`}
              items={[`项目类型：${candidate.project_type}`, `模块数：${candidate.modules.length}`]}
            />
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
  open,
  onToggle,
}: {
  candidate: ProjectCandidate;
  instances: NonNullable<ProjectCandidate["deploy_instances"]>;
  onOpenPath: (path: string) => void;
  /** 文件面板是否已打开该项目目录，用于按钮文案切换。 */
  open: boolean;
  /** 点按钮：开则收起面板，关则打开。 */
  onToggle: () => void;
}) {
  if (instances.length === 0) {
    return (
      <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-11 text-fg-subtle">仅源码，未关联到运行实例</span>
          <Button
            variant="secondary"
            size="xs"
            onClick={onToggle}
            title={`在文件面板打开 ${candidate.path}`}
          >
            <FolderOpen size={11} />
            {open ? "关闭项目目录" : "查看项目文件"}
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
          onClick={onToggle}
          title={`在文件面板打开 ${candidate.path}`}
        >
          <FolderOpen size={11} />
          {open ? "关闭项目目录" : "打开项目目录"}
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
