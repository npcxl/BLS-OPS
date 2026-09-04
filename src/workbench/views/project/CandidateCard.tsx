import { useState } from "react";
import {
  Check,
  ChevronRight,
  EyeOff,
  FileCode2,
  FolderOpen,
  FolderSearch,
  GitMerge,
  Globe,
  Split,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import type {
  ConfirmedScanState,
  DiscoveryStatus,
  GatewayRoute,
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
  { labelKey: string; tone: string }
> = {
  confirmed: { labelKey: "Confirmed", tone: "bg-success/12 text-success" },
  high_confidence: { labelKey: "High confidence", tone: "bg-accent/12 text-accent" },
  needs_confirm: { labelKey: "Needs review", tone: "bg-warning/12 text-warning" },
  possible_dir: { labelKey: "Possible directory", tone: "bg-surface-2 text-fg-subtle" },
  running_service: { labelKey: "Running service", tone: "bg-[#6366f1]/12 text-[#4338ca]" },
  not_project: { labelKey: "Not a project", tone: "bg-surface-3 text-fg-subtle" },
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

/** 已确认项目的持久化状态徽标：覆盖在「已确认」之上，提示跨扫描变化。label 存英文 key。 */
const SCAN_STATE_META: Record<
  ConfirmedScanState,
  { labelKey: string; tone: string }
> = {
  active: { labelKey: "Found this scan", tone: "bg-success/12 text-success" },
  missing: { labelKey: "Not found this scan", tone: "bg-warning/14 text-warning" },
  inaccessible: { labelKey: "Server unreachable", tone: "bg-danger/14 text-danger" },
  changed: { labelKey: "Details changed", tone: "bg-accent/14 text-accent" },
};

export function CandidateCard({
  candidate,
  onOpenPath,
  onClosePath,
  serverId,
  review,
  onReview,
  scanInfo,
  gatewayRoutes = [],
  mergedChildren = [],
  mergeTargets = [],
  onMerge,
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
  /** Nginx 网关路由（后端已按 linked_project_id 关联到项目）。 */
  gatewayRoutes?: GatewayRoute[];
  /** 已人工并入本项目的子目录路径。 */
  mergedChildren?: string[];
  /** 「并入其他项目」的目标列表。 */
  mergeTargets?: { path: string; name: string }[];
  /** 合并 / 拆分回调（parentPath 为 null 表示拆分）。 */
  onMerge?: (childPath: string, parentPath: string | null) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [busy, setBusy] = useState<ReviewState | null>(null);
  const [pickingMerge, setPickingMerge] = useState(false);
  // 该项目关联到的网关路由（后端评分期已把 linked_project_id 写成项目路径）。
  const routes = gatewayRoutes.filter((route) => route.linked_project_id === candidate.path);
  const mergedInto = candidate.merged_into;
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
      ? { labelKey: "Ignored", tone: "bg-surface-3 text-fg-subtle" }
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
              {t(statusMeta.labelKey)}
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
                {t(SCAN_STATE_META[scanInfo.scanState].labelKey)}
              </span>
            )}
            {review === "confirmed" && scanInfo?.kindChanged && (
              <span className="rounded bg-warning/14 px-1.5 py-0.5 text-10 text-warning">
                {t("Details changed")}
              </span>
            )}
            {review === "confirmed" && scanInfo?.confirmedMissing && (
              <span className="rounded bg-warning/14 px-1.5 py-0.5 text-10 text-warning">
                {t("Not found this scan")}
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
              {candidate.category === "deployed" ? t("Deployed") : t("Source only")}
            </span>
            {running && <span className="text-10 text-success">{t("Running")}</span>}
            {mergedChildren.length > 0 && (
              <span className="rounded bg-accent/12 px-1.5 py-0.5 text-10 text-accent">
                {t("{{count}} subdirectories merged in", { count: mergedChildren.length })}
              </span>
            )}
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
              {t("{{type}} · {{count}} modules · readiness {{score}}", {
                type: candidate.project_type,
                count: candidate.modules.length,
                score: candidate.readiness.score,
              })}
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
          {t("Deploy files")}
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
                {expanded ? t("Hide evidence details") : t("Evidence details")}
              </Button>
            </div>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-line px-4 py-3 text-11">
          {/* 访问入口：该项目在共享 Nginx 上的域名 / 端口 / 静态 root / 代理目标 /
              配置文件。路由由后端按 linked_project_id 关联，无路由时不出现在这里。 */}
          {routes.length > 0 && (
            <div className="mb-4 rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
              <div className="mb-2 flex items-center gap-1.5 text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
                <Globe size={11} />
                {t("Access entries (Nginx gateway)")}
              </div>
              <div className="space-y-1.5">
                {routes.map((route) => (
                  <div
                    key={route.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-10"
                  >
                    <span className="font-medium text-fg">
                      {route.server_names.length > 0 ? route.server_names.join(" / ") : route.id}
                    </span>
                    <PortChips ports={route.listen_ports} empty="" />
                    {route.root && (
                      <button
                        type="button"
                        className="truncate font-mono text-fg-muted hover:text-fg"
                        title={t("Open {{path}}", { path: route.root as string })}
                        onClick={() => onOpenPath(route.root as string)}
                      >
                        root {route.root}
                      </button>
                    )}
                    {route.proxy_targets.map((target) => (
                      <span key={target} className="font-mono text-fg-subtle">
                        → {target}
                      </span>
                    ))}
                    {route.config_file && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => onOpenPath(route.config_file as string)}
                        title={t("Open {{path}}", { path: route.config_file as string })}
                      >
                        <FileCode2 size={11} />
                        {configFileLabel(route.config_file)}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 证据 / 评分细节：默认收起，点展开才看，避免卡片一打开就一堆数字 */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Detail
              title={t("Verdict: {{status}} (score {{score}})", {
                status: t(statusMeta.labelKey),
                score: candidate.score,
              })}
              items={[
                t("Project type: {{type}}", { type: candidate.project_type }),
                t("Modules: {{count}}", { count: candidate.modules.length }),
              ]}
            />
            <Detail
              title={t("Decision evidence")}
              items={candidate.evidence.map(
                (item) => `+${item.weight} ${item.summary}（${item.source}）`,
              )}
            />
            <div className="space-y-4">
              <Detail
                title={t("Penalties & risks")}
                items={candidate.penalties.map((item) => `-${item.weight} ${item.summary}`)}
              />
              <Detail
                title={t("Runtime links")}
                items={candidate.runtime_links.map(
                  (item) =>
                    `${item.kind}: ${item.name}${item.ports.length ? t(" · ports {{ports}}", { ports: item.ports.join(", ") }) : ""}${item.service ? ` · ${item.service.label}` : ""}`,
                )}
              />
            </div>
            {mergedChildren.length > 0 && (
              <div className="space-y-4 lg:col-span-2">
                <Detail title={t("Subdirectories merged in (manual merge)")} items={mergedChildren} />
              </div>
            )}
            <div className="space-y-4 lg:col-span-2">
              <Detail title={t("Environment variable names")} items={candidate.required_environment_names} />
              <Detail
                title={t("Deployment readiness")}
                items={[
                  ...candidate.readiness.blockers.map((item) => t("Blocker: {{item}}", { item })),
                  ...candidate.readiness.warnings.map((item) => t("Warning: {{item}}", { item })),
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
                {busy === "confirmed" ? t("Saving") : t("Confirm project")}
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
                {busy === "ignored" ? t("Saving") : t("Ignore directory")}
              </Button>
            )}
            {(review === "confirmed" || review === "ignored") && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                onClick={() => void submitReview("pending")}
              >
                {t("Undo decision")}
              </Button>
            )}
            {/* 人工合并 / 拆分（问题4）：结论持久化，后续扫描不会覆盖。 */}
            {onMerge && mergedInto && (
              <>
                <span className="ml-1 truncate text-10 text-fg-subtle" title={mergedInto}>
                  {t("Merged into {{path}}", { path: mergedInto })}
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => {
                    setPickingMerge(false);
                    onMerge(candidate.path, null);
                  }}
                >
                  <Split size={11} />
                  {t("Split")}
                </Button>
              </>
            )}
            {onMerge && !mergedInto && (
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null || mergeTargets.length <= 1}
                onClick={() => setPickingMerge((value) => !value)}
              >
                <GitMerge size={11} />
                {t("Merge into another project…")}
              </Button>
            )}
          </div>
          {pickingMerge && !mergedInto && (
            <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-line pt-2">
              <span className="text-10 text-fg-subtle">{t("Pick the parent project to merge into:")}</span>
              {mergeTargets
                .filter((target) => target.path !== candidate.path)
                .map((target) => (
                  <Button
                    key={target.path}
                    variant="secondary"
                    size="xs"
                    title={target.path}
                    onClick={() => {
                      setPickingMerge(false);
                      onMerge?.(candidate.path, target.path);
                    }}
                  >
                    {target.name}
                  </Button>
                ))}
            </div>
          )}
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
  const { t } = useTranslation();
  if (instances.length === 0) {
    return (
      <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-11 text-fg-subtle">{t("Source only — not linked to a running instance")}</span>
          <Button
            variant="secondary"
            size="xs"
            onClick={onToggle}
            title={t("Open {{path}} in the file panel", { path: candidate.path })}
          >
            <FolderOpen size={11} />
            {open ? t("Close project folder") : t("View project files")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-10 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
          {t("Deploy files")}
        </span>
        <Button
          variant="secondary"
          size="xs"
          onClick={onToggle}
          title={t("Open {{path}} in the file panel", { path: candidate.path })}
        >
          <FolderOpen size={11} />
          {open ? t("Close project folder") : t("Open project folder")}
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
                    title={t("Open {{path}}", { path: file })}
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
                    ? t("Runs from an image — no config files on the host")
                    : t("No config files available")}
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
