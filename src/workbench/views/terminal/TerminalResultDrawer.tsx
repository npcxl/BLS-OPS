import { useRef } from "react";
import { ChevronDown, Copy, History, RotateCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { RISK_META } from "@/api/ops-api";
import type { CapturedResult } from "./TerminalCommandCoordinator";
import { COMMAND_SOURCE_LABELS } from "./command-plan";
import { TerminalSnapshotView } from "./TerminalSnapshotView";

/**
 * 知识库**没有**命中时的风险展示。
 *
 * 终端里手敲的命令不在知识库里是常态（`ls -l` / 自研脚本…）。此时风险未知，
 * 必须**明确显示"未知"**，绝不能悄悄按只读处理（readonly 会绕过确认）。
 */
const UNKNOWN_RISK = { label: "Unknown risk", tone: "bg-surface-2 text-fg-muted" };

/**
 * 终端下方的命令结果抽屉 —— 结果是**真正可管理的 Tab**。
 *
 * 每个 Tab：
 * - 左键：查看并展开；
 * - `×` / 中键：关闭；
 * - 右键菜单：查看 / 重新运行（按真实风险门控）/ 复制命令 / 关闭 /
 *   关闭其他 / 关闭全部。
 *
 * 内容区是 [TerminalSnapshotView]：默认展示从 xterm buffer 还原的渲染快照，
 * 原始输出作调试视图（不做任何结构化/表格化 —— 那是 Docker/服务/项目模块的事）。
 *
 * 关闭当前结果后优先选择右侧相邻，没有则选左侧；全部关闭则隐藏抽屉。
 * **不可捕获的命令（交互式 / 读 stdin / 未开增强终端）不产出结果 → 抽屉不
 * 渲染**。原始终端内容永远保留。
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
  const { t } = useTranslation();
  const active = results.find((item) => item.id === activeId) ?? results[results.length - 1];
  const menu = useContextMenu();
  const activeRef = useRef<CapturedResult | null>(null);
  activeRef.current = active ?? null;

  if (!active) return null;

  const tabMenu = (item: CapturedResult) =>
    menu.onContextMenu(() => [
      { id: "view", label: t("View"), onSelect: () => onSelect(item.id) },
      {
        id: "rerun",
        label: t("Rerun"),
        icon: RotateCw,
        // 无执行能力（知识层条目）不提供重运行。
        disabled: !item.canExecute,
        onSelect: () => onRerun(item),
      },
      {
        id: "copy",
        label: t("Copy command"),
        icon: Copy,
        onSelect: () => void copyText(item.command),
      },
      { id: "sep1", separator: true },
      { id: "close", label: t("Close"), onSelect: () => onCloseTab(item.id) },
      {
        id: "close-others",
        label: t("Close others"),
        disabled: results.length <= 1,
        onSelect: () => onCloseOthers(item.id),
      },
      {
        id: "close-all",
        label: t("Close all"),
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
          title={collapsed ? t("Expand results panel") : t("Collapse results panel")}
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
            // 未命中知识库 → 未知风险（可见），绝不默认只读。
            // RISK_META 的 label 是知识库数据（Rust catalog），前端不翻译；
            // UNKNOWN_RISK 是前端文案 → 存 key，这里 t()。
            const risk = item.risk ? RISK_META[item.risk] : UNKNOWN_RISK;
            const riskLabel = item.risk ? risk.label : t(risk.label);
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
                  title={`${item.command} · ${riskLabel} · ${
                    t(COMMAND_SOURCE_LABELS[item.source])
                  }`}
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
                  {/* 只读是默认情况，不占位置；未知风险必须显示出来。 */}
                  {item.risk !== "read_only" && (
                    <span className={cn("shrink-0 rounded px-1 text-9", risk.tone)}>
                      {riskLabel}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t("Close result for {{command}}", { command: item.command })}
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
          title={t("Close results panel (results are kept in history)")}
        >
          <X size={11} />
        </button>
      </div>

      {!collapsed && (
        <div className="h-[38vh] min-h-[180px] px-2 pb-2">
          {/* key = 结果 id：切换结果时视图状态（渲染/原始）重置为默认 */}
          <TerminalSnapshotView key={active.id} result={active} />
        </div>
      )}
      <ContextMenu {...menu.props} title={activeRef.current?.command} />
    </div>
  );
}
