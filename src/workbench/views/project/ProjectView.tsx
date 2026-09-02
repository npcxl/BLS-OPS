import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderSearch, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommandSession } from "@/hooks/use-command-session";
import { useScanTask } from "@/hooks/use-scan-task";
import { cn } from "@/lib/cn";
import { opsApi } from "@/api/ops-api";
import { ModuleEmpty, ModuleFrame } from "@/workbench/views/module-frame";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import type { ProjectCandidate, ReviewState } from "@/api/ops-api";
import type { WorkspaceTab } from "@/workbench/types";
import { ScanProgress } from "./ScanProgress";
import { TabApplications } from "./tabs/TabApplications";
import { TabNeedsConfirm } from "./tabs/TabNeedsConfirm";
import { TabRuntime } from "./tabs/TabRuntime";
import { TabInfrastructure } from "./tabs/TabInfrastructure";
import { TabBasicInfo } from "./tabs/TabBasicInfo";

/** 项目视图里没有配对的终端，文件面板不需要跟随 `cd`。引用必须稳定。 */
const NO_FOLLOW = { nonce: 0, arg: "" };

type TabId = "applications" | "needs_confirm" | "runtime" | "infrastructure" | "basic_info";

const TABS: { id: TabId; label: string }[] = [
  { id: "applications", label: "项目" },
  { id: "needs_confirm", label: "待确认" },
  { id: "runtime", label: "运行服务" },
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

  // 从数据库回填人工复核结论（确认 / 忽略），否则重扫或重进页面后本地
  // `reviews` 被清空、而快照候选里的 review 仍是扫描时的旧值，导致"已确认"
  // 的项目消失。DB 是权威来源，且与用户即时点击一致，挂载/切换服务器时同步一次。
  useEffect(() => {
    if (!tab.serverId) return;
    let alive = true;
    void opsApi.projectReviewList(tab.serverId).then(
      (records) => {
        if (!alive) return;
        setReviews((current) => {
          const next = { ...current };
          for (const r of records) next[r.path] = r.review as ReviewState;
          return next;
        });
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

  // 项目 tab：用户已确认 + 高可信的业务项目（排除基础设施、排除已忽略）。
  // 关键：人工确认覆盖一切证据等级（"我已确认的项目"必须出现在这里，
  // 即使它的自动 status 只是 needs_confirm / possible_dir）。
  const applications = useMemo(
    () =>
      resolved.filter(
        (c) =>
          c.review !== "ignored" &&
          c.project_kind !== "infrastructure" &&
          (c.review === "confirmed" || c.status === "high_confidence"),
      ),
    [resolved],
  );
  // 待确认 tab：用户尚未拍板（非确认、非忽略）的目录。
  const needsConfirm = useMemo(
    () => resolved.filter((c) => c.review !== "confirmed" && c.review !== "ignored"),
    [resolved],
  );
  // 运行服务 tab：全部运行实例（容器 / systemd / PM2 / Pod）。
  const runtimeInstances = useMemo(() => instances, [instances]);
  // 基础设施 tab：被识别成依赖（数据库/缓存/网关…）且非系统自带的实例。
  const infraInstances = useMemo(
    () => instances.filter((i) => !i.system_owned && i.service?.group !== "application"),
    [instances],
  );

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
      icon={FolderSearch}
      toolbar={
        <>
          <Button
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => void discover(true)}
          >
            <RefreshCw size={12} />
            刷新
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!session.ready || loading}
            onClick={() => void discover()}
          >
            {loading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <FolderSearch size={13} />
            )}
            {loading ? "扫描中…" : "发现服务器项目"}
          </Button>
        </>
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

          {/* 5 个 tab：项目 / 待确认 / 运行服务 / 基础设施 / 基本信息 */}
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
                <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                  <ModuleEmpty
                    icon={FolderSearch}
                    title="发现服务器项目"
                    hint="先识别服务器的操作系统与已安装能力，再据此启用对应的收集器（systemd、Docker、Nginx、PM2 等均按需），最后结合 Git、进程、端口与配置线索定位项目。整个过程只读，不会执行部署。"
                  />
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!session.ready}
                    onClick={() => void discover()}
                  >
                    开始发现
                  </Button>
                </div>
              )}

              {result && activeTab === "applications" && (
                <TabApplications
                  candidates={applications}
                  serverId={tab.serverId ?? ""}
                  reviews={reviews}
                  onOpenPath={openPath}
                  onReview={handleReview}
                />
              )}
              {result && activeTab === "needs_confirm" && (
                <TabNeedsConfirm
                  candidates={needsConfirm}
                  serverId={tab.serverId ?? ""}
                  reviews={reviews}
                  onOpenPath={openPath}
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
                <p className="text-11 text-warning">
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
