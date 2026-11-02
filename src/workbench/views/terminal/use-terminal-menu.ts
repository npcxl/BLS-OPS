import {
  ClipboardPaste,
  Columns2,
  Copy,
  Eraser,
  FolderOpen,
  History,
  PlugZap,
  RefreshCw,
  Rows2,
  Unplug,
} from "@/components/icons";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import type { Phase } from "./terminal-phase";

export interface TerminalMenuActions {
  historyOpen: boolean;
  filesOpen: boolean;
  phase: Phase;
  /**
   * 有选中时才给"复制"（无选区时 Ctrl+C 是 SIGINT，菜单里不给这个动作）。
   *
   * 必须是**取值的函数**：在终端里选中文字不会触发 React 重渲染，渲染期
   * 算出来的布尔值会一直是旧值 —— 表现就是"明明选了字，右键菜单里只有粘贴"。
   */
  hasSelection: () => boolean;
  onCopySelection: () => void;
  onPaste: () => void;
  onSplit: (direction: "horizontal" | "vertical") => void;
  onClear: () => void;
  onToggleHistory: () => void;
  onToggleFiles: () => void;
  onRefreshEnvironment: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

/**
 * 右键菜单 = 顶部 icon 工具栏的镜像（同样的动作与可见性条件）：
 * 终端画布上右键，可达被滚动/折叠藏起的顶部功能。toggle 类菜单项
 * 用 hint 标注当前展开状态；连接动作按 phase 二选一，与 toolbar 一致。
 */
export function buildTerminalMenuItems(
  t: ReturnType<typeof useTranslation>["t"],
  actions: TerminalMenuActions,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    // 复制/粘贴排在首位：右键菜单最常用的就是这两件事，且与系统的
    // Ctrl+C / Ctrl+V 一一对应。复制只在真有选区时出现 —— 没有选区时
    // Ctrl+C 在终端里的含义是中断（SIGINT），给它配一个"复制"项会误导。
    ...(actions.hasSelection()
      ? [
          {
            label: t("Copy"),
            icon: Copy,
            hint: "Ctrl+C",
            onSelect: actions.onCopySelection,
          } satisfies ContextMenuItem,
        ]
      : []),
    {
      label: t("Paste"),
      icon: ClipboardPaste,
      hint: "Ctrl+V",
      disabled: actions.phase !== "connected",
      onSelect: actions.onPaste,
    },
    { separator: true },
    {
      label: t("Split Vertically"),
      icon: Columns2,
      onSelect: () => actions.onSplit("horizontal"),
    },
    {
      label: t("Split Horizontally"),
      icon: Rows2,
      onSelect: () => actions.onSplit("vertical"),
    },
    { label: t("Clear Screen"), icon: Eraser, onSelect: actions.onClear },
    {
      label: t("Command History"),
      icon: History,
      hint: actions.historyOpen ? t("Expanded") : undefined,
      onSelect: actions.onToggleHistory,
    },
    {
      label: t("Remote Files"),
      icon: FolderOpen,
      hint: actions.filesOpen ? t("Expanded") : undefined,
      onSelect: actions.onToggleFiles,
    },
    {
      label: t("Refresh Environment"),
      icon: RefreshCw,
      hint: t("Re-probe Docker / Nginx"),
      disabled: actions.phase !== "connected",
      onSelect: actions.onRefreshEnvironment,
    },
    { separator: true },
  ];
  if (actions.phase === "connected") {
    items.push({ label: t("Disconnect"), icon: Unplug, danger: true, onSelect: actions.onDisconnect });
  } else {
    items.push({
      label: t("Reconnect"),
      icon: PlugZap,
      disabled: actions.phase === "connecting",
      onSelect: actions.onReconnect,
    });
  }
  return items;
}

/**
 * 终端画布右键菜单。
 *
 * 打开前先让 xterm 的隐藏 textarea 失焦 —— 否则菜单的键盘导航
 * （↑↓ / Enter）会被终端当成 shell 按键吞掉。
 */
export function useTerminalMenu(
  menu: ReturnType<typeof useContextMenu>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  actions: TerminalMenuActions,
) {
  const { t } = useTranslation();
  return menu.onContextMenu(() => {
    // 选区必须在失焦**之前**取：blur 是为了让菜单的键盘导航不被终端吞掉，
    // 但失焦后 xterm 的选区状态不一定还在 —— 先取值再 blur，菜单才不会
    // 只剩一个「粘贴」。
    const hasSelection = actions.hasSelection();
    containerRef.current?.querySelector("textarea")?.blur();
    return buildTerminalMenuItems(t, { ...actions, hasSelection: () => hasSelection });
  });
}
