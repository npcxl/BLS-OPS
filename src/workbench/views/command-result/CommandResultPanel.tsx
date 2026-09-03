import { useState } from "react";
import { cn } from "@/lib/cn";
import { RISK_META, type CommandExecutionResult, type RiskLevel } from "@/api/ops-api";
import { parseStructuredResult, VIEW_LABELS } from "./model";
import { CommandResultRenderer } from "./CommandResultRenderer";
import { RawView } from "./views/RawView";

/**
 * 统一结果面板 —— 结构化视图 | 原始输出 双 Tab。
 *
 * 数据不删减、不伪造：结构化只是第二种视图，原始 stdout、实际执行命令、
 * 耗时永久保留在"原始输出"Tab。后端负载经 `parseStructuredResult` 校验，
 * **解析不出统一协议就整块按原始输出渲染**（命令绝不因协议问题失效）。
 */
export function CommandResultPanel({ result }: { result: CommandExecutionResult }) {
  const structured = parseStructuredResult(result.structured);
  const [tab, setTab] = useState<"structured" | "raw">("structured");
  const risk = RISK_META[result.risk as RiskLevel] ?? RISK_META.read_only;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <strong className="text-12 text-fg">{result.title}</strong>
        <span className={cn("rounded px-1.5 py-0.5 text-10", risk.tone)}>{risk.label}</span>
        {structured && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">
            {VIEW_LABELS[structured.view]}
          </span>
        )}
        <code
          className="min-w-0 flex-1 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted"
          title={`实际执行：${result.raw.command_executed}`}
        >
          {result.raw.command_executed}
        </code>
        <span className="text-10 tabular-nums text-fg-subtle">{result.raw.duration_ms} ms</span>
        <div className="flex items-center gap-0.5 rounded-[7px] bg-surface-2 p-0.5">
          {structured && structured.view !== "raw" && (
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

      {structured?.warnings && structured.warnings.length > 0 && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1 text-10 text-warning">
          {structured.warnings.join("；")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {structured && structured.view !== "raw" && tab === "structured" ? (
          <CommandResultRenderer result={structured} />
        ) : (
          <RawView {...result.raw} />
        )}
      </div>
    </div>
  );
}
