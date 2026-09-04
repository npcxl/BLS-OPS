import { useState } from "react";
import { Check, Copy, FileCode2, FileText, FileJson, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { JsonView } from "@/workbench/views/command-result/views/JsonView";
import { RawStreamView } from "@/workbench/views/command-result/views/RawStreamView";
import type { CapturedResult } from "./TerminalCommandCoordinator";

/**
 * 终端结果视图 —— **xterm 终端快照方案**（不是结构化表格）。
 *
 * Tab 固定为 `[终端输出] [JSON?] [原始流]`：
 * - `终端输出` = 已渲染文本，按软换行（`line.isWrapped`）还原的终端快照，
 *   **默认**展示 —— 用户看到什么，这里就是什么；
 * - `JSON` = 仅在 `result.json`（**严格**检测：整段合法 JSON / JSONL 每行都
 *   合法，坏行即整体失败）非空时才出现；展示为可折叠 JSON 树，绝不再猜表格；
 * - `原始流` = 去掉受控标记后的原始 SSH 流（含 ESC 序列），字节级调试视图。
 *
 * - 渲染输出用 `<pre>` + `w-max whitespace-pre`：长行不折行，靠横向滚动看全
 *   （PTY 软换行已在提取时合并，这里不会再二次断行）；
 * - 空输出是有效结果：显示为空（绝不回落 / 绝不假装有内容）；
 * - 快照不可用（`renderedDegraded`）时显示可见的"已降级"提示 —— 降级文本
 *   是对原始流的清洗，不是真正的终端快照，绝不伪装。
 */
export function TerminalSnapshotView({ result }: { result: CapturedResult }) {
  const [view, setView] = useState<"rendered" | "json" | "raw">("rendered");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(result.renderedText ?? "")) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  const { boundary, json } = result;
  const exitCode = boundary.exitCode;
  const degraded = result.renderedDegraded;
  const meta: string[] = [];
  if (exitCode !== null) meta.push(`退出码 ${exitCode}`);
  meta.push(`${boundary.durationMs} ms`);
  meta.push(boundary.endedBy === "marker" ? "受控标记收尾" : "无标记兜底收尾");

  return (
    <div
      data-testid="terminal-snapshot-view"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-10 text-fg-subtle" title={meta.join(" · ")}>
          {meta.join(" · ")}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 rounded-[7px] bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setView("rendered")}
            className={cn(
              "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10 transition-colors",
              view === "rendered" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <FileText size={11} />
            终端输出
          </button>
          {json !== null && (
            <button
              type="button"
              onClick={() => setView("json")}
              className={cn(
                "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10 transition-colors",
                view === "json" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              <FileJson size={11} />
              JSON
            </button>
          )}
          <button
            type="button"
            onClick={() => setView("raw")}
            className={cn(
              "flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-10 transition-colors",
              view === "raw" ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
            )}
          >
            <FileCode2 size={11} />
            原始流
          </button>
        </div>
      </div>

      {degraded && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-10 text-warning">
          <TriangleAlert size={12} />
          <span className="min-w-0 flex-1">
            渲染快照不可用（起始行被回滚淘汰或无标记兜底），已从原始输出降级 —— 长行软换行无法还原
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {view === "rendered" ? (
          <div className="relative h-full min-w-0 bg-surface-1">
            <button
              type="button"
              onClick={() => void copy()}
              className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-[6px] border border-line bg-surface-1 px-1.5 py-0.5 text-10 text-fg-subtle hover:text-fg"
              title="复制渲染输出"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? "已复制" : "复制"}
            </button>
            <div className="h-full overflow-auto">
              <pre className="w-max whitespace-pre px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted">
                {result.renderedText ?? ""}
              </pre>
            </div>
          </div>
        ) : view === "json" && json !== null ? (
          <JsonView value={json.value} />
        ) : (
          <RawStreamView stdout={result.stdout} stderr={result.stderr} />
        )}
      </div>
    </div>
  );
}
