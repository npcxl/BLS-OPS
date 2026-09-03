import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";
import { RISK_META, type CommandExecutionResult, type DockerContainerRow } from "@/api/ops-api";
import { ContainerTable } from "./ContainerTable";
import {
  DiskTable,
  JournalViewer,
  ListenerTable,
  NginxSiteTable,
  ProcessTable,
  UnitTable,
} from "./StructuredTables";

/**
 * P4.3 结果面板：**结构化视图 | 原始输出** 双 Tab。
 *
 * 数据不删减、不伪造：结构化展示只是第二种视图；原始 stdout、实际执行命令、
 * 耗时永久保留在这里。
 */
export function ResultPanel({ result }: { result: CommandExecutionResult }) {
  const [tab, setTab] = useState<"structured" | "raw">(
    result.structured ? "structured" : "raw",
  );
  const risk = RISK_META[result.risk];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      {/* 头部：标题 + 实际执行命令 + Tab 切换 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <strong className="text-12 text-fg">{result.title}</strong>
        <span className={cn("rounded px-1.5 py-0.5 text-10", risk.tone)}>{risk.label}</span>
        <code
          className="min-w-0 flex-1 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted"
          title={`实际执行：${result.raw.command_executed}`}
        >
          {result.raw.command_executed}
        </code>
        <span className="text-10 tabular-nums text-fg-subtle">{result.raw.duration_ms} ms</span>
        <div className="flex items-center gap-0.5 rounded-[7px] bg-surface-2 p-0.5">
          {result.structured && (
            <button
              type="button"
              onClick={() => setTab("structured")}
              className={cn(
                "rounded-[5px] px-2 py-0.5 text-10 transition-colors",
                tab === "structured" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              结构化视图
            </button>
          )}
          <button
            type="button"
            onClick={() => setTab("raw")}
            className={cn(
              "rounded-[5px] px-2 py-0.5 text-10 transition-colors",
              tab === "raw" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            原始输出
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "structured" && result.structured ? (
          <StructuredView adapter={result.structured.adapter} data={result.structured} raw={result.raw.stdout} />
        ) : (
          <RawOutputView stdout={result.raw.stdout} />
        )}
      </div>
    </div>
  );
}

/** 结构化视图分发：未识别的适配器回落到原始输出（命令不会因无 UI 而失效）。 */
function StructuredView({
  adapter,
  data,
  raw,
}: {
  adapter: string;
  data: NonNullable<CommandExecutionResult["structured"]>;
  raw: string;
}) {
  if (adapter === "docker-container-table" && data.containers) {
    return <ContainerTable containers={data.containers} />;
  }
  if (adapter === "systemd-unit-table" && data.units) {
    return <UnitTable units={data.units} />;
  }
  if (adapter === "journal-log-viewer" && data.entries) {
    return <JournalViewer entries={data.entries} />;
  }
  if (adapter === "nginx-config-tree" && data.sites) {
    return <NginxSiteTable sites={data.sites} />;
  }
  if (adapter === "process-table" && data.processes) {
    return <ProcessTable processes={data.processes} />;
  }
  if (adapter === "disk-usage-table" && data.filesystems) {
    return <DiskTable filesystems={data.filesystems} />;
  }
  if (adapter === "port-listener-table" && data.listeners) {
    return <ListenerTable listeners={data.listeners} />;
  }
  return <RawOutputView stdout={raw} />;
}

/** 原始输出：原样保留 stdout，一键复制。 */
function RawOutputView({ stdout }: { stdout: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(stdout);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };
  return (
    <div className="relative h-full overflow-auto bg-surface-1">
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-[6px] border border-line bg-surface-1 px-1.5 py-0.5 text-10 text-fg-subtle hover:text-fg"
        title="复制原始输出"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "已复制" : "复制"}
      </button>
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted">
        {stdout || "（无输出）"}
      </pre>
    </div>
  );
}

/** docker ps 摘要。 */
export function containerSummary(containers: DockerContainerRow[]) {
  const running = containers.filter((row) => row.state === "running").length;
  const stopped = containers.filter((row) => row.state === "exited").length;
  const other = containers.length - running - stopped;
  return { total: containers.length, running, stopped, other };
}
