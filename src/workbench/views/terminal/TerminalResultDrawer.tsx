import { ChevronDown, History, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { CommandResultPanel } from "@/workbench/views/command-result/CommandResultPanel";
import { VIEW_LABELS } from "@/workbench/views/command-result/model";
import type { CapturedResult } from "./TerminalCommandCoordinator";

/**
 * 终端下方的结构化结果抽屉。
 *
 * 原则：
 * - 原始终端内容**永远保留**（终端本身不受影响，只是下面多一块面板）；
 * - 默认展示结构化视图，可切回原始输出；
 * - 支持折叠 / 关闭 / 重新打开 / 查看本次会话的历史结果；
 * - **未识别命令不弹空面板**（协调器未产出结果时这里根本不渲染）。
 */
export function TerminalResultDrawer({
  results,
  activeId,
  collapsed,
  onToggleCollapse,
  onSelect,
  onClose,
}: {
  results: CapturedResult[];
  activeId: string | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const active = results.find((item) => item.id === activeId) ?? results[results.length - 1];
  if (!active) return null;

  return (
    <div className="flex shrink-0 flex-col border-t border-line bg-surface-1">
      {/* 抽屉头：当前命令 + 历史切换 + 折叠/关闭 */}
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex min-w-0 items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left hover:bg-surface-hover"
          title={collapsed ? "展开结果面板" : "折叠结果面板"}
        >
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-fg-subtle transition-transform", collapsed && "-rotate-90")}
          />
          <span className="truncate font-mono text-11 text-fg" title={active.command}>
            {active.command}
          </span>
          <span className="shrink-0 rounded bg-surface-2 px-1 text-9 text-fg-subtle">
            {VIEW_LABELS[active.result.view]}
          </span>
        </button>

        {results.length > 1 && (
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            <History size={11} className="shrink-0 text-fg-subtle" />
            {results.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                title={item.command}
                className={cn(
                  "shrink-0 max-w-[140px] truncate rounded-full px-1.5 py-0.5 text-9 transition-colors",
                  item.id === active.id
                    ? "bg-accent/12 text-accent"
                    : "text-fg-subtle hover:text-fg",
                )}
              >
                {item.command}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          className="ml-auto flex shrink-0 items-center gap-0.5 rounded-[6px] px-1 py-0.5 text-10 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          title="关闭结果面板"
        >
          <X size={11} />
          关闭
        </button>
      </div>

      {!collapsed && (
        <div className="h-[38vh] min-h-[180px] px-2 pb-2">
          <CommandResultPanel
            result={{
              knowledge_id: active.knowledgeId,
              title: active.result.title,
              risk: "read_only",
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
    </div>
  );
}
