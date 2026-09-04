import { useState } from "react";
import { Check, Copy, CornerDownLeft, FileCode2, Table2, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { RISK_META, type CommandExecutionResult } from "@/api/ops-api";
import { parseStructuredResult, RISK_LABEL_KEYS, VIEW_LABELS } from "./model";
import { CommandResultRenderer } from "./CommandResultRenderer";
import { RawView } from "./views/RawView";

/**
 * 风险未知（`null`，知识库未命中）时的展示 —— **绝不默认只读**，
 * 否则修改型命令会绕过确认对话框。label 是英文 key，渲染处 t()。
 */
const UNKNOWN_RISK = { labelKey: "Unknown risk", tone: "bg-surface-2 text-fg-muted" };

type PanelTab = "structured" | "raw";

/** 视图切换项（header 分段控件与右键菜单共用同一份 —— 见"右键 = 顶部功能"）。 */
interface ViewOption {
  id: PanelTab;
  label: string;
  icon: LucideIcon;
  /** 结构化视图对 raw/text 输出没有意义 → 隐藏。 */
  visible: boolean;
}

/**
 * 统一结果面板 —— 结构化视图 | 原始输出。
 *
 * **只服务命令中心 / 模块链路**（`CommandExecutionResult` 结构化协议）：
 * Docker / 服务 / 项目 / 日志等模块执行知识库命令后的结果。终端自由输入的
 * 结果走独立的 `TerminalSnapshotView`（快照 + JSON + 原始流），**不经过这里**。
 *
 * 数据不删减、不伪造：结构化只是第二种视图，原始 stdout、实际执行命令、
 * 耗时永久保留。后端负载经 `parseStructuredResult` 校验，**解析不出统一协议
 * 就整块按原始输出渲染**（命令绝不因协议问题失效）。
 */
export function CommandResultPanel({ result }: { result: CommandExecutionResult }) {
  const { t } = useTranslation();
  const structured = parseStructuredResult(result.structured);
  const risk = result.risk
    ? { ...RISK_META[result.risk], labelKey: RISK_LABEL_KEYS[result.risk] }
    : UNKNOWN_RISK;
  const [copied, setCopied] = useState<string | null>(null);
  const menu = useContextMenu();

  /** False when the output has no meaningful structured view to switch to. */
  const canStructure = Boolean(structured) && structured!.view !== "raw" && structured!.view !== "text";
  /** 默认展示：结构化可看 → 结构化；否则原始输出。 */
  const [tab, setTab] = useState<PanelTab>(() => (canStructure ? "structured" : "raw"));

  const viewOptions: ViewOption[] = [
    { id: "structured", label: t("Structured view"), icon: Table2, visible: canStructure },
    { id: "raw", label: t("Raw output"), icon: FileCode2, visible: true },
  ];
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
      label: t("Structured view"),
      icon: Table2,
      // Header hides the button in the same situation; the menu must not offer
      // an action that does nothing, so the entry stays but is disabled.
      disabled: !canStructure,
      hint: canStructure && tab === "structured" ? t("Current") : undefined,
      onSelect: () => setTab("structured"),
    },
    {
      id: "view-raw",
      label: t("Raw output"),
      icon: FileCode2,
      hint: tab === "raw" ? t("Current") : undefined,
      onSelect: () => setTab("raw"),
    },
    { id: "sep-copy", separator: true },
    {
      id: "copy-stdout",
      label: copied === "stdout" ? t("Output copied") : t("Copy raw output"),
      icon: copied === "stdout" ? Check : Copy,
      onSelect: () => void copy("stdout", result.raw.stdout || ""),
    },
    {
      id: "copy-command",
      label: copied === "command" ? t("Command copied") : t("Copy executed command"),
      icon: copied === "command" ? Check : CornerDownLeft,
      onSelect: () => void copy("command", result.raw.command_executed),
    },
    {
      id: "copy-all",
      label: copied === "all" ? t("Copied") : t("Copy full result"),
      icon: copied === "all" ? Check : Copy,
      onSelect: () =>
        void copy(
          "all",
          [
            t("Command: {{command}}", { command: result.raw.command_executed }),
            t("Duration: {{ms}} ms", { ms: result.raw.duration_ms }),
            "",
            result.raw.stdout || t("(no output)"),
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
        <span className={cn("rounded px-1.5 py-0.5 text-10", risk.tone)}>{t(risk.labelKey)}</span>
        {structured && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-10 text-fg-subtle">
            {t(VIEW_LABELS[structured.view])}
          </span>
        )}
        <code
          className="min-w-0 flex-1 truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-10 text-fg-muted"
          title={t("Executed: {{command}}", { command: result.raw.command_executed })}
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
        ) : (
          <RawView {...result.raw} />
        )}
      </div>

      <ContextMenu {...menu.props} title={result.title} />
    </div>
  );
}
