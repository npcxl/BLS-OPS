import { useState } from "react";
import { Check, Copy, CornerDownLeft, FileCode2, FileText, Table2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { RISK_META, type CommandExecutionResult } from "@/api/ops-api";
import { parseStructuredResult, VIEW_LABELS } from "./model";
import { CommandResultRenderer } from "./CommandResultRenderer";
import { RawView } from "./views/RawView";
import { ReadableOutputView } from "./views/ReadableOutputView";
import { RawStreamView } from "./views/RawStreamView";

/**
 * 风险未知（`null`，知识库未命中）时的展示 —— **绝不默认只读**，
 * 否则修改型命令会绕过确认对话框。
 */
const UNKNOWN_RISK = { label: "未知风险", tone: "bg-surface-2 text-fg-muted" };

type PanelTab = "structured" | "readable" | "raw";

/** 视图切换项（header 分段控件与右键菜单共用同一份 —— 见"右键 = 顶部功能"）。 */
interface ViewOption {
  id: PanelTab;
  label: string;
  icon: LucideIcon;
  /** 结构化视图对 raw/text 输出没有意义 → 隐藏。 */
  visible: boolean;
}

/**
 * 统一结果面板 —— 结构化视图 | 可读输出 | 原始输出。
 *
 * - `readable` 缺省（Docker/服务/项目等模块）：结构化 | 原始输出，与以往一致；
 * - `readable` 提供（终端路径，`normalizeForParsing` 的结果）：默认展示
 *   **可读输出**（用户不该看到 `ESC[?2004l` 这类控制字符）；完整原始流
 *   转义后放在"原始输出"Tab 作高级调试（见 RawStreamView）。
 *
 * 数据不删减、不伪造：结构化只是第二种视图，原始 stdout、实际执行命令、
 * 耗时永久保留。后端负载经 `parseStructuredResult` 校验，**解析不出统一协议
 * 就整块按原始输出渲染**（命令绝不因协议问题失效）。
 */
export function CommandResultPanel({
  result,
  readable,
}: {
  result: CommandExecutionResult;
  /** 终端结果的可读输出（去控制序列/回显/提示符）。缺省 = 非终端模块。 */
  readable?: string;
}) {
  const structured = parseStructuredResult(result.structured);
  const risk = result.risk ? RISK_META[result.risk] : UNKNOWN_RISK;
  const [copied, setCopied] = useState<string | null>(null);
  const menu = useContextMenu();

  /** False when the output has no meaningful structured view to switch to. */
  const canStructure = Boolean(structured) && structured!.view !== "raw" && structured!.view !== "text";
  /** 默认展示：结构化可看 → 结构化；否则终端结果看"可读输出"，再退原始。 */
  const [tab, setTab] = useState<PanelTab>(() =>
    canStructure ? "structured" : readable !== undefined ? "readable" : "raw",
  );

  const viewOptions: ViewOption[] = [
    { id: "structured", label: "结构化视图", icon: Table2, visible: canStructure },
    { id: "readable", label: "可读输出", icon: FileText, visible: readable !== undefined },
    { id: "raw", label: "原始输出", icon: FileCode2, visible: true },
  ];
  const canRenderReadable = readable !== undefined;
  const headerOptions = viewOptions.filter((option) => option.visible);

  const copy = async (id: string, text: string) => {
    if (await copyText(text)) {
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200);
    }
  };

  const items: ContextMenuItem[] = [
    {
      id: "view-structured",
      label: "结构化视图",
      icon: Table2,
      // Header hides the button in the same situation; the menu must not offer
      // an action that does nothing, so the entry stays but is disabled.
      disabled: !canStructure,
      hint: canStructure && tab === "structured" ? "当前" : undefined,
      onSelect: () => setTab("structured"),
    },
    ...(canRenderReadable
      ? [
          {
            id: "view-readable",
            label: "可读输出",
            icon: FileText,
            hint: tab === "readable" ? "当前" : undefined,
            onSelect: () => setTab("readable"),
          } satisfies ContextMenuItem,
        ]
      : []),
    {
      id: "view-raw",
      label: "原始输出",
      icon: FileCode2,
      hint: tab === "raw" || (!canRenderReadable && !canStructure) ? "当前" : undefined,
      onSelect: () => setTab("raw"),
    },
    { id: "sep-copy", separator: true },
    {
      id: "copy-stdout",
      label: copied === "stdout" ? "已复制输出" : "复制原始输出",
      icon: copied === "stdout" ? Check : Copy,
      onSelect: () => void copy("stdout", result.raw.stdout || ""),
    },
    {
      id: "copy-command",
      label: copied === "command" ? "已复制命令" : "复制实际执行命令",
      icon: copied === "command" ? Check : CornerDownLeft,
      onSelect: () => void copy("command", result.raw.command_executed),
    },
    {
      id: "copy-all",
      label: copied === "all" ? "已复制" : "复制完整结果",
      icon: copied === "all" ? Check : Copy,
      onSelect: () =>
        void copy(
          "all",
          [
            `命令：${result.raw.command_executed}`,
            `耗时：${result.raw.duration_ms} ms`,
            "",
            canRenderReadable && readable ? readable : result.raw.stdout || "（无输出）",
            result.raw.stderr ? `\nstderr:\n${result.raw.stderr}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ),
    },
  ];

  return (
    <div
      data-testid="result-panel"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]"
      onContextMenu={menu.onContextMenu(() => items)}
    >
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
          {headerOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setTab(option.id)}
              className={cn(
                "rounded-[5px] px-2 py-0.5 text-10 transition-colors",
                tab === option.id ? "bg-surface-3 text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {structured?.warnings && structured.warnings.length > 0 && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1 text-10 text-warning">
          {structured.warnings.join("；")}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {canStructure && tab === "structured" ? (
          <CommandResultRenderer result={structured!} />
        ) : tab === "readable" && canRenderReadable ? (
          <ReadableOutputView text={readable!} />
        ) : canRenderReadable ? (
          // 终端路径的"原始输出"：完整原始流（含 ESC）转义展示，作高级调试。
          <RawStreamView stdout={result.raw.stdout} stderr={result.raw.stderr} />
        ) : (
          <RawView {...result.raw} />
        )}
      </div>

      <ContextMenu {...menu.props} title={result.title} />
    </div>
  );
}
