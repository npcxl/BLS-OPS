import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Box,
  Check,
  ChevronDown,
  CircleAlert,
  FolderSearch,
  Globe,
  Loader2,
  Pause,
  Server,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  opsApi,
  toErrorMessage,
  type AdapterReadiness,
  type DeploymentInstance,
  type ProjectCandidate,
  type ProjectScanResult,
  type ProjectScanStatus,
  type ServerCapabilityProfile,
} from "@/api/ops-api";
import { useCommandSession } from "@/hooks/use-command-session";
import {
  ModuleEmpty,
  ModuleFrame,
  RefreshButton,
} from "@/workbench/views/module-frame";
import type { WorkspaceTab } from "@/workbench/types";

/** P3 is intentionally discovery-only. Deployment records remain available to P5, but are not exposed here. */
export function ProjectView({ tab }: { tab: WorkspaceTab }) {
  const session = useCommandSession(tab);
  const [scan, setScan] = useState<ProjectScanStatus | null>(null);
  const [result, setResult] = useState<ProjectScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "deployed" | "source_only" | "high">("all");
  const timerRef = useRef<number | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const discover = useCallback(
    async (incremental = false) => {
      console.log("[ProjectView] 开始发现项目", {
        incremental,
        sessionReady: session.ready,
        sessionId: session.sessionId,
        serverId: tab.serverId,
        tabId: tab.id,
      });
      if (!session.ready || !tab.serverId) {
        console.warn("[ProjectView] 无法开始发现：SSH 会话未连接或缺少服务器", {
          sessionReady: session.ready,
          sessionId: session.sessionId,
          serverId: tab.serverId,
        });
        setError("SSH 会话未连接，请先连接服务器");
        return;
      }
      setLoading(true);
      setError(null);
      setResult(null);
      try {
        console.log("[ProjectView] 调用 project_scan_start", {
          sessionId: session.sessionId,
          serverId: tab.serverId,
          incremental,
        });
        const started = await opsApi.projectScanStart(
          session.sessionId,
          tab.serverId,
          incremental,
        );
        console.log("[ProjectView] project_scan_start 返回", started);
        setScan(started);
        console.log("[ProjectView] 监听扫描结果事件", {
          eventName: `project-scan-result-${started.id}`,
        });
        const unlisten = await listen<ProjectScanResult>(
          `project-scan-result-${started.id}`,
          (event) => {
            console.log("[ProjectView] 收到扫描结果事件", event.payload);
            unlistenRef.current = null;
            setResult(event.payload);
            setScan((current) =>
              current
                ? {
                    ...current,
                    state: "completed",
                    progress: { ...current.progress, progress: 100 },
                  }
                : current,
            );
            setLoading(false);
            unlisten();
          },
        );
        unlistenRef.current = unlisten;
        const poll = window.setInterval(async () => {
          timerRef.current = poll;
          try {
            const status = await opsApi.projectScanStatus(started.id);
            console.log("[ProjectView] project_scan_status 返回", status);
            if (status) setScan(status);
            if (
              status &&
              ["completed", "cancelled", "failed"].includes(status.state)
            ) {
              console.log("[ProjectView] 扫描已结束", {
                state: status.state,
                error: status.error,
                progress: status.progress,
              });
              if (status.error) {
                console.error("[ProjectView] 后端扫描错误", status.error);
                setError(status.error);
              }
              window.clearInterval(poll);
              const found = await opsApi.projectScanResult(started.id);
              console.log("[ProjectView] project_scan_result 返回", found);
              if (found) setResult(found);
              setLoading(false);
              unlisten();
            }
          } catch (cause) {
            console.error("[ProjectView] 查询扫描状态失败", cause);
            window.clearInterval(poll);
            setError(toErrorMessage(cause));
            setLoading(false);
            unlisten();
          }
        }, 700);
      } catch (cause) {
        console.error("[ProjectView] 启动项目发现失败", cause);
        setError(toErrorMessage(cause));
        setLoading(false);
      }
    },
    [session.ready, session.sessionId, tab.serverId],
  );

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      unlistenRef.current?.();
      if (scan && ["running", "queued"].includes(scan.state))
        void opsApi.projectScanCancel(scan.id);
    },
    [scan],
  );

  const cancel = async () => {
    if (scan) await opsApi.projectScanCancel(scan.id);
  };
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

function ScanProgress({
  scan,
  onCancel,
}: {
  scan: ProjectScanStatus;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-[10px] border border-line bg-surface-1 p-4">
      <div className="flex items-center gap-2 text-12 font-medium">
        <Loader2 size={14} className="animate-spin text-accent" />
        正在扫描服务器
      </div>
      <div className="mt-2 flex justify-between text-11 text-fg-muted">
        <span>当前阶段：{scan.progress.phase}</span>
        <span>{scan.progress.progress}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${scan.progress.progress}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-10 text-fg-subtle">
        <span>
          已检查 {scan.progress.checked_directories} 个目录 · 已发现{" "}
          {scan.progress.discovered_candidates} 个候选 · 警告{" "}
          {scan.progress.warnings} 个
        </span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <Pause size={11} />
          取消扫描
        </Button>
      </div>
      {scan.progress.current_path && (
        <div
          className="mt-2 truncate font-mono text-10 text-fg-subtle"
          title={scan.progress.current_path}
        >
          {scan.progress.current_path}
        </div>
      )}
    </div>
  );
}

/** 部署方式 → 图标与展示名。 */
const KIND_META: Record<string, { icon: typeof Box; label: string }> = {
  docker: { icon: Box, label: "Docker" },
  systemd: { icon: Server, label: "systemd" },
  nginx: { icon: Globe, label: "Nginx" },
};

/**
 * 第一轮部署实例清单：真实容器 / 服务 / 站点。`source_known === false` 的
 * 实例明确标为"源码未知"，绝不猜测路径。
 */
function InstanceList({ instances }: { instances: DeploymentInstance[] }) {
  if (instances.length === 0) return null;
  const unknown = instances.filter((instance) => !instance.source_known).length;
  return (
    <section className="rounded-[10px] border border-line bg-surface-1">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-11 font-medium text-fg">部署实例</span>
        <span className="text-10 text-fg-subtle">
          {instances.length} 个实例 · {unknown} 个源码未知
        </span>
      </div>
      <div className="divide-y divide-line">
        {instances.map((instance) => {
          const meta = KIND_META[instance.kind];
          const Icon = meta?.icon ?? Box;
          return (
            <div key={instance.id} className="flex items-start gap-2.5 px-3 py-2">
              <Icon size={14} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="truncate text-12 text-fg">{instance.name}</strong>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-muted">
                    {meta?.label ?? instance.kind}
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-10",
                      instance.source_known
                        ? "bg-success/12 text-success"
                        : "bg-warning/12 text-warning",
                    )}
                  >
                    {instance.source_known ? "已关联源码" : "源码未知"}
                  </span>
                  <span className="text-10 text-fg-subtle">{instance.status}</span>
                  {instance.ports.length > 0 && (
                    <span className="text-10 text-fg-subtle">
                      端口 {instance.ports.join(", ")}
                    </span>
                  )}
                </div>
                {instance.source_paths.length > 0 && (
                  <div className="mt-0.5 truncate font-mono text-10 text-fg-subtle" title={instance.source_paths.join("\n")}>
                    {instance.source_paths.join("  ·  ")}
                  </div>
                )}
                <div className="mt-0.5 truncate text-10 text-fg-subtle" title={instance.detail}>
                  {instance.detail}
                </div>
              </div>
              {!instance.source_known && (
                <CircleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CandidateCard({ candidate }: { candidate: ProjectCandidate }) {
  const [expanded, setExpanded] = useState(false);
  const running = candidate.runtime_links.length > 0;
  const confidence =
    candidate.confidence === "high"
      ? "高置信度"
      : candidate.confidence === "likely"
        ? "待确认"
        : "可能项目";
  return (
    <article className="rounded-[10px] border border-line bg-surface-1">
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-surface-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        <FolderSearch size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-13 text-fg">
              {candidate.name}
            </strong>
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
          </div>
          <div className="mt-1 truncate font-mono text-11 text-fg-muted">
            {candidate.path}
          </div>
          <div className="mt-1 text-10 text-fg-subtle">
            {candidate.project_type} · {candidate.modules.length} 个模块 ·{" "}
            {candidate.detected_ports.length} 个端口 · 准备度{" "}
            {candidate.readiness.score}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={cn(
            "mt-1 text-fg-subtle transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-line px-3 pb-3 pt-2 text-11">
          <Detail
            title="判定依据"
            items={candidate.evidence.map(
              (item) => `+${item.weight} ${item.summary}（${item.source}）`,
            )}
          />
          <Detail
            title="扣分与风险"
            items={candidate.penalties.map(
              (item) => `-${item.weight} ${item.summary}`,
            )}
          />
          <Detail
            title="运行关联"
            items={candidate.runtime_links.map(
              (item) =>
                `${item.kind}：${item.name}${item.ports.length ? ` · 端口 ${item.ports.join(", ")}` : ""}`,
            )}
          />
          <Detail
            title="环境变量名称"
            items={candidate.required_environment_names}
          />
          <Detail
            title="部署准备"
            items={[
              ...candidate.readiness.blockers.map((item) => `阻塞：${item}`),
              ...candidate.readiness.warnings.map((item) => `警告：${item}`),
              ...candidate.readiness.confirmed_facts,
            ]}
          />
          <div className="mt-3 flex gap-1">
            <Button variant="secondary" size="xs">
              <Check size={11} />
              确认项目
            </Button>
            <Button variant="ghost" size="xs">
              忽略目录
            </Button>
            <Button variant="ghost" size="xs">
              合并 / 拆分
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
function Detail({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center gap-1 font-medium text-fg">
        <ShieldCheck size={12} className="text-fg-subtle" />
        {title}
      </div>
      {items.length ? (
        <ul className="space-y-0.5 text-fg-muted">
          {items.map((item) => (
            <li key={item} className="truncate">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-fg-subtle">暂无</div>
      )}
    </div>
  );
}

function CapabilityGraph({ profile }: { profile: ServerCapabilityProfile }) {
  const sys = profile.system;
  const sysFacts = [
    `操作系统：${sys.os || "未知"}`,
    `架构：${sys.arch || "未知"}`,
    `初始化系统：${sys.init_system || "未知"}`,
    `包管理器：${sys.package_manager || "未知"}`,
    `当前用户：${sys.user || "未知"}`,
    `sudo：${sys.sudo === null ? "无法判定" : sys.sudo ? "可用" : "不可用"}`,
    `安全模块：${sys.security_module || "未知"}`,
    `cgroup：${sys.cgroup_version || "未知"}`,
  ];
  const runtimes = Object.entries(profile.runtimes).filter(([, v]) => v) as [
    string,
    string,
  ][];
  const buildTools = Object.entries(profile.build_tools).filter(
    ([, v]) => v,
  ) as [string, string][];
  const vm = Object.entries(profile.version_managers).filter(([, v]) => v) as [
    string,
    string,
  ][];
  const deployment = Object.entries(profile.deployment) as [
    string,
    boolean | null,
  ][];
  const enabled = deployment.filter(([, v]) => v === true).map(([k]) => k);
  const missing = deployment.filter(([, v]) => v === false).map(([k]) => k);
  return (
    <section className="rounded-[10px] border border-line bg-surface-1 p-3">
      <div className="mb-2 flex items-center gap-1 text-11 font-medium text-fg">
        <span className="rounded bg-accent/12 px-2 py-0.5 text-accent">
          服务器能力图谱
        </span>
        <span className="text-fg-subtle">
          先识别服务器，再决定启用哪些收集器
        </span>
      </div>
      <Detail title="系统档案" items={sysFacts} />
      <Detail title="运行时" items={runtimes.map(([k, v]) => `${k} ${v}`)} />
      {buildTools.length > 0 && (
        <Detail
          title="构建工具"
          items={buildTools.map(([k, v]) => `${k} ${v}`)}
        />
      )}
      {vm.length > 0 && (
        <Detail title="版本管理器" items={vm.map(([k]) => k)} />
      )}
      <Detail
        title="已启用的能力收集器"
        items={enabled.length ? enabled : ["（无）"]}
      />
      {missing.length > 0 && (
        <div className="mt-2 text-10 text-fg-subtle">
          未安装（不启用收集器，避免无意义报错）：{missing.join("、")}
        </div>
      )}
    </section>
  );
}

const READINESS_LABEL: Record<string, string> = {
  ready: "可直接部署",
  needs_install: "需安装",
  conflict: "冲突",
  unconfirmed: "无法确认",
};

function ReadinessGraph({ items }: { items: AdapterReadiness[] }) {
  const verdictClass = (v: string) =>
    v === "ready"
      ? "bg-success/12 text-success"
      : v === "needs_install"
        ? "bg-warning/12 text-warning"
        : v === "conflict"
          ? "bg-danger/12 text-danger"
          : "bg-surface-3 text-fg-subtle";
  return (
    <section className="rounded-[10px] border border-line bg-surface-1 p-3">
      <div className="mb-2 text-11 font-medium text-fg">
        <span className="rounded bg-accent/12 px-2 py-0.5 text-accent">
          部署可行性图谱
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 md:grid-cols-3">
        {items.map((item) => (
          <div
            key={item.adapter}
            className="flex items-center justify-between gap-2 rounded-[6px] border border-line px-2 py-1.5"
          >
            <span className="truncate text-11 text-fg">{item.adapter}</span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 text-10",
                verdictClass(item.verdict),
              )}
            >
              {READINESS_LABEL[item.verdict] ?? item.verdict}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 text-10 text-fg-subtle">
        未确认的部署方式不会猜测为支持；需安装的方式由 P4 决定是否处理。
      </div>
    </section>
  );
}
