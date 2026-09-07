import {
  Columns2,
  Eraser,
  FolderOpen,
  History,
  PlugZap,
  RefreshCw,
  Rows2,
  Search,
  Sparkles,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import type { Phase } from "./terminal-phase";

export interface TerminalMenuActions {
  searchOpen: boolean;
  historyOpen: boolean;
  filesOpen: boolean;
  phase: Phase;
  enhancedTerminal: boolean;
  onToggleSearch: () => void;
  onSplit: (direction: "horizontal" | "vertical") => void;
  onClear: () => void;
  onToggleHistory: () => void;
  onToggleFiles: () => void;
  onRefreshEnvironment: () => void;
  onToggleEnhanced: () => void;
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
    {
      label: t("Search"),
      icon: Search,
      hint: actions.searchOpen ? t("Expanded") : undefined,
      onSelect: actions.onToggleSearch,
    },
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
    {
      label: t("Enhanced Terminal"),
      icon: Sparkles,
      hint: actions.enhancedTerminal ? t("Enabled") : undefined,
      onSelect: actions.onToggleEnhanced,
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
    containerRef.current?.querySelector("textarea")?.blur();
    return buildTerminalMenuItems(t, actions);
  });
}
