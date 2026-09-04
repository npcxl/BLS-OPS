import { useRef } from "react";
import { ChevronDown, Copy, History, RotateCw, X } from "lucide-react";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { RISK_META, type RiskLevel } from "@/api/ops-api";
import { CommandResultPanel } from "@/workbench/views/command-result/CommandResultPanel";
import type { CapturedResult } from "./TerminalCommandCoordinator";

/**
 * 终端下方的结构化结果抽屉 —— 结果是**真正可管理的 Tab**。
 *
 * 每个 Tab：
 * - 左键：查看并展开；
 * - `×` / 中键：关闭；
 * - 右键菜单：查看 / 重新运行（按真实风险门控）/ 复制命令 / 关闭 /
 *   关闭其他 / 关闭全部。
 *
 * 关闭当前结果后优先选择右侧相邻，没有则选左侧；全部关闭则隐藏抽屉。
 * **未识别命令不产出结果 → 抽屉不渲染**。原始终端内容永远保留。
 */
export function TerminalResultDrawer({
  results,
  activeId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onClose,
  onCloseTab,
  onCloseOthers,
  onCloseAll,
  onRerun,
}: {
  results: CapturedResult[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** 关闭单个结果（selection 沉降规则由父层处理）。 */
  onCloseTab: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseAll: () => void;
  /** 重新运行：父层按真实风险门控（只读直接跑，修改型先确认）。 */
  onRerun: (item: CapturedResult) => void;
}) {
  const active = results.find((item) => item.id === activeId) ?? results[results.length - 1];
  const menu = useContextMenu();
  const activeRef = useRef<CapturedResult | null>(null);
  activeRef.current = active ?? null;

  if (!active) return null;

  const tabMenu = (item: CapturedResult) =>
    menu.onContextMenu(() => [
      { id: "view", label: "查看", onSelect: () => onSelect(item.id) },
      {
        id: "rerun",
        label: "重新运行",
        icon: RotateCw,
        // 无执行能力（知识层条目）不提供重运行。
        disabled: !item.canExecute,
        onSelect: () => onRerun(item),
      },
      {
        id: "copy",
        label: "复制命令",
        icon: Copy,
        onSelect: () => void navigator.clipboard.writeText(item.command),
      },
      { id: "sep1", separator: true },
      { id: "close", label: "关闭", onSelect: () => onCloseTab(item.id) },
      {
        id: "close-others",
        label: "关闭其他",
        disabled: results.length <= 1,
        onSelect: () => onCloseOthers(item.id),
      },
      {
        id: "close-all",
        label: "关闭全部",
        onSelect: () => onCloseAll(),
      },
    ]);

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-surface-1">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex shrink-0 items-center rounded-[6px] px-1 py-0.5 hover:bg-surface-hover"
          title={collapsed ? "展开结果面板" : "折叠结果面板"}
        >
          <ChevronDown
            size={12}
            className={cn("text-fg-subtle transition-transform", collapsed && "-rotate-90")}
          />
        </button>

        {/* 结果 Tab 条：左键查看 · × 关闭 · 中键关闭 · 右键菜单 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {results.length > 1 && (
            <History size={11} className="shrink-0 text-fg-subtle" />
          )}
          {results.map((item) => {
            const isActive = item.id === active.id;
            const risk = RISK_META[item.risk as RiskLevel] ?? RISK_META.read_only;
            return (
              <div
                key={item.id}
                className={cn(
                  "group flex h-[24px] max-w-[190px] shrink-0 cursor-default items-center gap-1 rounded-[6px] px-1.5 text-11 transition-colors",
                  isActive ? "bg-surface-active text-fg" : "text-fg-muted hover:bg-surface-hover",
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1"
                  title={`${item.command} · ${risk.label}`}
                  onClick={() => onSelect(item.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onCloseTab(item.id);
                  }}
                  onContextMenu={(event) => {
                    onSelect(item.id);
                    tabMenu(item)(event);
                  }}
                >
                  <span className="truncate">{item.command}</span>
                  {item.risk !== "read_only" && (
                    <span className={cn("shrink-0 rounded px-1 text-9", risk.tone)}>
                      {risk.label}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`关闭 ${item.command} 的结果`}
                  className={cn(
                    "shrink-0 rounded-[4px] p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg",
                    isActive ? "opacity-70" : "opacity-0 group-hover:opacity-100",
                  )}
                  onClick={() => onCloseTab(item.id)}
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded-[6px] px-1 py-0.5 text-10 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          title="关闭结果面板（结果保留在历史中）"
        >
          <X size={11} />
        </button>
      </div>

      {!collapsed && (
        <div className="h-[38vh] min-h-[180px] px-2 pb-2">
          {/* key = 结果 id：切换结果时视图状态（结构化/原始）重置为默认 */}
          <CommandResultPanel
            key={active.id}
            result={{
              knowledge_id: active.knowledgeId,
              title: active.result.title,
              // **真实风险**（知识库返回），禁止伪装成只读。
              risk: active.risk,
              raw: {
                command_executed: active.command,
                stdout: active.result.raw.stdout,
                stderr: active.result.raw.stderr,
                duration_ms: active.result.meta.duration_ms,
              },
              structured: active.result as unknown as never,
            }}
          />
        </div>
      )}
      <ContextMenu {...menu.props} title={activeRef.current?.command} />
    </div>
  );
}
