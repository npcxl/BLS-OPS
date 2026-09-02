import { useState } from "react";
import { FolderSearch, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCommandSession } from "@/hooks/use-command-session";
import { useScanTask } from "@/hooks/use-scan-task";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
} from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";
import { ScanProgress } from "./ScanProgress";
import { InstanceList } from "./InstanceList";
import { CandidateCard } from "./CandidateCard";
import { CapabilityGraph, ReadinessGraph } from "./graphs";

/** P3 is intentionally discovery-only. Deployment records remain available to P5, but are not exposed here. */
export function ProjectView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [filter, setFilter] = useState<"all" | "deployed" | "source_only" | "high">("all");
  // Start/poll/cancel/cleanup of a discovery run lives in the hook (阶段 D).
  const { scan, result, loading, error, discover, cancel } = useScanTask(
    tab.serverId,
    session.sessionId,
    session.ready,
  );
  const candidates =
    result?.candidates.filter(
      (candidate) =>
        filter === "all" ||
        (filter === "high" && candidate.confidence === "high") ||
        (filter === "deployed" && candidate.category === "deployed") ||
        (filter === "source_only" && candidate.category === "source_only"),
    ) ?? [];

  return (
    <ModuleFrame
      tab={tab}
      session={session}
      icon={FolderSearch}
      toolbar={
        <>
          <RefreshButton busy={loading} onClick={() => void discover(true)} />
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
            发现服务器项目
          </Button>

        </>
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-1.5 rounded-[9px] border border-line bg-surface-1 px-3 py-2 text-10 text-fg-subtle shadow-sm">
          <span className="rounded bg-accent/12 px-2 py-1 text-accent">
            1 发现项目
          </span>
          <span>→</span>
          <span>2 确认项目与模块</span>
          <span>→</span>
          <span>3 检查部署环境</span>
          <span>→</span>
          <span>4 生成部署方案（P4）</span>
        </div>
        {error && (
          <div className="rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-12 text-danger">
            {error}
          </div>
        )}
        {!result && !loading && (
          <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
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
        {loading && scan && (
          <ScanProgress scan={scan} onCancel={() => void cancel()} />
        )}
        {result && (
          <>
            {result.capability && (
              <CapabilityGraph profile={result.capability} />
            )}
            <div className="flex items-center gap-1 border-b border-line pb-2">
              <span className="text-11 font-medium text-fg">项目证据图谱</span>
              <div className="flex-1" />
              <Button
                variant={filter === "all" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setFilter("all")}
              >
                全部
              </Button>
              <Button
                variant={filter === "deployed" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setFilter("deployed")}
              >
                已部署项目
              </Button>
              <Button
                variant={filter === "source_only" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setFilter("source_only")}
              >
                未部署源码
              </Button>
              <Button
                variant={filter === "high" ? "secondary" : "ghost"}
                size="xs"
                onClick={() => setFilter("high")}
              >
                高置信度
              </Button>
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
                  <CandidateCard key={candidate.id} candidate={candidate} />
                ))}
              </div>
            )}
            {result.deployment_readiness.length > 0 && (
              <ReadinessGraph items={result.deployment_readiness} />
            )}
            {result.warnings.length > 0 && (
              <div className="text-11 text-warning">
                扫描警告：{result.warnings.join("；")}
              </div>
            )}
          </>
        )}
      </div>
    </ModuleFrame>
  );
}
