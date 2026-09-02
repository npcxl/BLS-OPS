import { useCallback, useMemo, useState } from "react";
import { FolderSearch, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommandSession } from "@/hooks/use-command-session";
import { useScanTask } from "@/hooks/use-scan-task";
import { cn } from "@/lib/cn";
import {
  ModuleEmpty,
  ModuleFrame,
} from "@/workbench/views/module-frame";
import { RemoteFilePanel } from "@/workbench/views/remote-file/RemoteFilePanel";
import type { WorkspaceTab } from "@/workbench/types";
import { ScanProgress } from "./ScanProgress";
import { InstanceList } from "./InstanceList";
import { CandidateCard } from "./CandidateCard";
import { CapabilityGraph, ReadinessGraph, RuntimeComposition } from "./graphs";

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "application", label: "业务应用" },
  { id: "infrastructure", label: "基础设施" },
  { id: "deployed", label: "已部署" },
  { id: "source_only", label: "仅源码" },
  { id: "high", label: "高置信度" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

const STEPS = ["发现项目", "确认模块", "检查部署环境", "生成方案（P4）"];

/** 项目视图里没有配对的终端，文件面板不需要跟随 `cd`。引用必须稳定。 */
const NO_FOLLOW = { nonce: 0, arg: "" };

/** P3 is intentionally discovery-only. Deployment records remain available to P5, but are not exposed here. */
export function ProjectView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [filter, setFilter] = useState<FilterId>("all");
  // 右侧文件面板：点"查看项目文件 / Docker 配置 / Nginx 配置"时打开到对应路径。
  // `firstPath` 是面板挂载时的落点（避免与"打开 home 目录"抢导航栈）；
  // `nonce` 每次自增，同一个路径可以被重复请求。
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
  // Start/poll/cancel/cleanup of a discovery run lives in the hook (阶段 D).
  const { scan, result, loading, error, discover, cancel } = useScanTask(
    tab.serverId,
    session.sessionId,
    session.ready,
  );
  const candidates =
    result?.candidates.filter((candidate) => {
      switch (filter) {
        case "high":
          return candidate.confidence === "high";
        case "deployed":
          return candidate.category === "deployed";
        case "source_only":
          return candidate.category === "source_only";
        // MySQL / Redis / Nginx 这类是依赖，单独一屏看，不跟业务项目混排。
        case "infrastructure":
          return candidate.project_kind === "infrastructure";
        case "application":
          return candidate.project_kind !== "infrastructure";
        default:
          return true;
      }
    }) ?? [];

  // 扫描中只保留"主按钮 + 进度卡片"两处动画；刷新按钮在扫描期间禁用，
  // 不再各自转一个 spinner。
  const currentStep = result ? 3 : loading ? 1 : 1;

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
      {/* 主区（候选列表）与右侧文件面板并排：点"查看项目文件 / Docker 配置 /
          Nginx 配置"时面板直接落到对应目录并选中目标文件。 */}
      <div className="flex h-full min-h-0">
        <div className="ops-scroll min-w-0 flex-1 overflow-y-scroll overflow-x-hidden">
          <div className="mx-auto flex w-full max-w-[880px] flex-col gap-5 p-5">
        {/* 流水线标注 — 一行小字加当前步骤，不再是一整条彩色胶囊 */}
        <div className="flex items-center gap-2 text-10 text-fg-subtle">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-1 px-2 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            第 {currentStep} 步 · {STEPS[currentStep - 1]}
          </span>
          <span className="hidden min-w-0 truncate sm:inline">
            {STEPS.join(" → ")}
          </span>
          <span className="ml-auto shrink-0 text-fg-muted">
            只读扫描 · 不修改服务器文件
          </span>
        </div>

        {error && (
          <div className="rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
            {error}
          </div>
        )}

        {/* 空状态：未开始 / 正在发起（scan 尚未返回）都停留在这里，避免闪烁空白 */}
        {!result && (!loading || !scan) && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
            <ModuleEmpty
              icon={FolderSearch}
              title={loading ? "正在准备扫描…" : "发现服务器项目"}
              hint="先识别服务器的操作系统与已安装能力，再据此启用对应的收集器（systemd、Docker、Nginx、PM2 等均按需），最后结合 Git、进程、端口与配置线索定位项目。整个过程只读，不会执行部署。"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={!session.ready || loading}
              onClick={() => void discover()}
            >
              {loading ? "扫描中…" : "开始发现"}
            </Button>
          </div>
        )}

        {loading && scan && (
          <ScanProgress scan={scan} onCancel={() => void cancel()} />
        )}

        {result && (
          <>
            {result.capability && (
              <CapabilityGraph profile={result.capability} />
            )}

            {/* 运行形态：宿主机 / 容器 / k8s 各占多少，避免"装了 docker 就
                以为 Nginx 在宿主机上"这类误判 */}
            <RuntimeComposition instances={result.instances} />

            {/* 证据图谱标题 + 分段筛选（macOS segmented control） */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
                项目证据图谱
                <span className="ml-1.5 text-10 font-normal text-fg-muted normal-case">
                  {candidates.length} 个候选
                </span>
              </span>
              <div className="flex rounded-[8px] bg-surface-2 p-[2px]">
                {FILTERS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setFilter(item.id)}
                    className={cn(
                      "h-[22px] rounded-[6px] px-2.5 text-11 transition-colors",
                      filter === item.id
                        ? "bg-surface-3 text-fg shadow-sm"
                        : "text-fg-muted hover:text-fg",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <InstanceList instances={result.instances} />

            {candidates.length === 0 ? (
              <ModuleEmpty
                icon={FolderSearch}
                title="没有符合筛选条件的候选"
                hint="可以切换筛选条件，或重新执行增量扫描。"
              />
            ) : (
              <div className="flex flex-col gap-2">
                {candidates.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    onOpenPath={openPath}
                  />
                ))}
              </div>
            )}

            {result.deployment_readiness.length > 0 && (
              <ReadinessGraph items={result.deployment_readiness} />
            )}

            {result.warnings.length > 0 && (
              <p className="text-11 text-warning">
                扫描警告：{result.warnings.join("；")}
              </p>
            )}
          </>
        )}
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