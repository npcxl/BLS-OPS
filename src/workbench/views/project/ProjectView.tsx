import { useCallback, useEffect, useMemo, useState } from "react";
import { Boxes, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommandSession } from "@/hooks/use-command-session";
import { useScanTask } from "@/hooks/use-scan-task";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import { ModuleEmpty, ModuleFrame } from "@/workbench/views/module-frame";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import type {
  ConfirmedProject,
  ConfirmedScanState,
  ProjectCandidate,
  ReviewState,
} from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";

/** 渲染用候选：在 ProjectCandidate 之上附加"已确认项目"的持久化状态。 */
export type DisplayCandidate = ProjectCandidate & {
  /** 该已确认项目本次扫描的态度：active / missing / inaccessible / changed。 */
  scanState?: ConfirmedScanState;
  /** 系统重新将其分类为基础设施，但用户曾确认是业务项目 → 需复核。 */
  kindChanged?: boolean;
  /** 本次扫描未再发现该路径（快照仍在，仅供展示）。 */
  confirmedMissing?: boolean;
};
import { ScanProgress } from "./ScanProgress";
import { TabApplications } from "./tabs/TabApplications";
import { TabNeedsConfirm } from "./tabs/TabNeedsConfirm";
import { TabRuntime } from "./tabs/TabRuntime";
import { TabInfrastructure } from "./tabs/TabInfrastructure";
import { TabBasicInfo } from "./tabs/TabBasicInfo";
import { findDuplicateIds, partitionInstances } from "./classify";

/** 项目视图里没有配对的终端，文件面板不需要跟随 `cd`。引用必须稳定。 */
const NO_FOLLOW = { nonce: 0, arg: "" };

type TabId = "applications" | "needs_confirm" | "runtime" | "infrastructure" | "basic_info";

const TABS: { id: TabId; label: string }[] = [
  { id: "applications", label: "项目" },
  { id: "needs_confirm", label: "待确认" },
  { id: "runtime", label: "应用服务" },
  { id: "infrastructure", label: "基础设施" },
  { id: "basic_info", label: "基本信息" },
];

/** P3 is intentionally discovery-only. Deployment records remain available to P5, but are not exposed here. */
export function ProjectView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [activeTab, setActiveTab] = useState<TabId>("applications");
  // 右侧文件面板：点"查看项目文件 / Docker 配置 / Nginx 配置"时打开到对应路径。
  // `firstPath` 是面板挂载时的落点；`nonce` 每次自增，同一个路径可以被重复请求。
  const [panel, setPanel] = useState<{
    nonce: number;
    firstPath: string;
    path: string;
  } | null>(null);
  const openPath = useCallback((path: string) => {
    setPanel((current) =>
      current
        ? { ...current, nonce: current.nonce + 1, path }
        : { nonce: 1, firstPath: path, path },
    );
  }, []);
  const closePanel = useCallback(() => setPanel(null), []);
  const reveal = useMemo(
    () => ({ nonce: panel?.nonce ?? 0, path: panel?.path ?? "" }),
    [panel],
  );
  // Start/poll/cancel/cleanup of a discovery run lives in the hook.
  const { scan, result, loading, error, discover, cancel, loadSnapshot } = useScanTask(
    tab.serverId,
    session.sessionId,
    session.ready,
  );

  // 进入页面立即回填上次扫描快照（确认过的项目立即可见），后台再增量复核。
  useEffect(() => {
    if (session.ready && tab.serverId) void loadSnapshot();
  }, [session.ready, tab.serverId, loadSnapshot]);

  // 用户在卡片上"确认 / 忽略"后，本地覆盖扫描结果里的 review，避免每次都重扫。
  // 后端扫描时也会从数据库读回 review，所以重扫后这里的状态仍一致。
  const [reviews, setReviews] = useState<Record<string, ReviewState>>({});
  const handleReview = useCallback((path: string, state: ReviewState) => {
    setReviews((current) => ({ ...current, [path]: state }));
  }, []);

  // 持久化已确认项目：即使最新扫描没再发现该路径也必须继续存在。挂载/切换
  // 服务器时从 confirmed_projects 表加载完整快照。
  const [confirmedProjects, setConfirmedProjects] = useState<ConfirmedProject[]>([]);
  useEffect(() => {
    if (!tab.serverId) {
      setConfirmedProjects([]);
      return;
    }
    let alive = true;
    void opsApi.projectConfirmedList(tab.serverId).then(
      (records) => {
        if (!alive) return;
        // 解析候选快照，并给每个条目一个稳定的 display 候选。
        const parsed = records.map((r) => {
          try {
            r.candidate = JSON.parse(r.candidate_payload) as ProjectCandidate;
          } catch {
            r.candidate = undefined;
          }
          return r;
        });
        setConfirmedProjects(parsed);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [tab.serverId]);

  // 统一数据源：所有 tab 与数量徽标都从这份"已合并用户复核结论"的候选里取，
  // 避免确认/忽略后某个徽标不同步。
  const resolved = useMemo<ProjectCandidate[]>(() => {
    const list = result?.candidates ?? [];
    return list.map((c) => ({ ...c, review: (reviews[c.path] ?? c.review) ?? "pending" }));
  }, [result, reviews]);

  const instances = result?.instances ?? [];

  // 「项目」列表 = 持久化已确认项目 + 本次扫描的高可信候选，按 canonical_path 合并。
  // 人工确认优先级最高：只要 review === "confirmed" 就进「项目」，即使被算法重新
  // 分类为 infrastructure 也先保留（标记 kindChanged 提示复核），不允许自动消失。
  const applications = useMemo<DisplayCandidate[]>(() => {
    const out: DisplayCandidate[] = [];
    const usedPaths = new Set<string>();

    // 1) 持久化已确认项目：无论本次是否扫到，都先加入。
    for (const cp of confirmedProjects) {
      const scanned = resolved.find((c) => c.path === cp.canonical_path);
      if (scanned) {
        usedPaths.add(scanned.path);
        const kindChanged =
          scanned.project_kind === "infrastructure" &&
          cp.candidate?.project_kind !== "infrastructure";
        out.push({
          ...scanned,
          review: "confirmed",
          scanState: "active",
          kindChanged,
          confirmedMissing: false,
        });
      } else {
        // 本次未扫到：保留快照，状态取 DB 的 scan_state（missing / inaccessible）。
        if (cp.candidate) {
          out.push({
            ...cp.candidate,
            review: "confirmed",
            scanState: cp.scan_state,
            kindChanged: false,
            confirmedMissing: cp.scan_state !== "active",
          });
        }
      }
    }

    // 2) 本次扫描的高可信候选（未被已确认项目占用的路径）。
    for (const c of resolved) {
      if (usedPaths.has(c.path)) continue;
      if (c.review === "ignored") continue;
      if (c.review === "confirmed") {
        out.push({ ...c, scanState: "active" });
        continue;
      }
      if (c.project_kind === "infrastructure") continue;
      if (c.status === "high_confidence") out.push({ ...c });
    }

    return out;
  }, [confirmedProjects, resolved]);

  // 待确认 tab：用户尚未拍板（非确认、非忽略）的目录。
  const needsConfirm = useMemo(
    () => resolved.filter((c) => c.review !== "confirmed" && c.review !== "ignored"),
    [resolved],
  );
  // 顶层互斥划分：应用服务 / 基础设施 / 待归类 / 系统组件。
  // 分类以后端 workload_role 为准；MySQL/Redis/MinIO 只出现在基础设施，
  // 待归类绝不进基础设施。系统组件默认隐藏。
  const partitioned = useMemo(() => partitionInstances(instances), [instances]);
  if (import.meta.env.DEV) {
    const duplicatedIds = findDuplicateIds(partitioned);
    if (duplicatedIds.length > 0) {
      // 从数据模型上保证互斥；这里只是兜底告警，不能替代后端约束。
      console.error("实例分类重复", duplicatedIds);
    }
  }
  // 应用服务 tab：业务应用 + 待归类（待归类作为 tab 内筛选项查看）。
  const runtimeInstances = useMemo(
    () => [...partitioned.applications, ...partitioned.unclassified],
    [partitioned],
  );
  // 基础设施 tab：只收 workload_role === infrastructure 的实例。
  const infraInstances = partitioned.infrastructure;

  const tabBadges: Record<TabId, number> = {
    applications: applications.length,
    needs_confirm: needsConfirm.length,
    runtime: runtimeInstances.length,
    infrastructure: infraInstances.length,
    basic_info: 0,
  };

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      toolbar={
        <Button
          variant="ghost"
          size="xs"
          disabled={loading}
          onClick={() => void discover()}
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          刷新
        </Button>
      }
    >
      <div className="flex h-full min-h-0">
        <div className="ops-scroll flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* 扫描状态横幅：异常 / 断开由 ModuleFrame 统一处理，这里只留进度条 */}
          {error && (
            <div className="mx-5 mt-4 rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
              {error}
            </div>
          )}
          {loading && scan && (
            <div className="mx-5 mt-4">
              <ScanProgress scan={scan} onCancel={() => void cancel()} />
            </div>
          )}

          {/* 显示的是上次扫描缓存、后台仍在复核：明确标注，避免用户误以为这是最终结果。 */}
          {result?.incremental && !loading && (
            <div className="mx-5 mt-4 flex items-center gap-2 rounded-[8px] border border-line bg-surface-2/60 px-3 py-2 text-11 text-fg-subtle">
              <Loader2 size={12} className="animate-spin" />
              已加载上次发现结果，后台复核进行中…
            </div>
          )}

          {/* 5 个 tab：项目 / 待确认 / 应用服务 / 基础设施 / 基本信息 */}
          <div className="flex items-center gap-1 border-b border-line px-4 pt-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  "relative flex items-center gap-1.5 px-3 py-2 text-12 transition-colors",
                  activeTab === item.id
                    ? "font-medium text-fg"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {item.label}
                {tabBadges[item.id] > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-10",
                      activeTab === item.id
                        ? "bg-accent/15 text-accent"
                        : "bg-surface-3 text-fg-subtle",
                    )}
                  >
                    {tabBadges[item.id]}
                  </span>
                )}
                {activeTab === item.id && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent" />
                )}
              </button>
            ))}
          </div>

          <div className="ops-scroll min-h-0 flex-1 overflow-y-scroll overflow-x-hidden">
            <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-5">
              {!result && !loading && (
                <ModuleEmpty
                  icon={Boxes}
                  title="发现服务器项目"
                  hint="先识别服务器的操作系统与已安装能力，再据此启用对应的收集器（systemd、Docker、Nginx、PM2 等均按需），最后结合 Git、进程、端口与配置线索定位项目。整个过程只读，不会执行部署。点击上方「刷新」开始。"
                />
              )}

              {result && activeTab === "applications" && (
                <TabApplications
                  candidates={applications}
                  serverId={tab.serverId ?? ""}
                  reviews={reviews}
                  onOpenPath={openPath}
                  onClosePath={closePanel}
                  onReview={handleReview}
                />
              )}
              {result && activeTab === "needs_confirm" && (
                <TabNeedsConfirm
                  candidates={needsConfirm}
                  serverId={tab.serverId ?? ""}
                  reviews={reviews}
                  onOpenPath={openPath}
                  onClosePath={closePanel}
                  onReview={handleReview}
                />
              )}
              {result && activeTab === "runtime" && (
                <TabRuntime instances={runtimeInstances} onOpenPath={openPath} />
              )}
              {result && activeTab === "infrastructure" && (
                <TabInfrastructure instances={infraInstances} onOpenPath={openPath} />
              )}
              {result && activeTab === "basic_info" && (
                <TabBasicInfo profile={result.capability} />
              )}

              {result && result.warnings.length > 0 && (
                <p className="text-center text-11 text-warning">
                  扫描警告：{result.warnings.join("；")}
                </p>
              )}
            </div>
          </div>
        </div>

        {panel && (
          <RemoteFilePanel
            sessionId={session.sessionId}
            connected={session.ready}
            follow={NO_FOLLOW}
            initialPath={panel.firstPath}
            reveal={reveal}
            onClose={closePanel}
          />
        )}
      </div>
    </ModuleFrame>
  );
}
