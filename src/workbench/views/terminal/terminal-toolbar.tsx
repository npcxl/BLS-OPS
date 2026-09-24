import { Columns2, Eraser, FolderOpen, History, PlugZap, RefreshCw, Rows2, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ToolbarIcon } from "./ToolbarIcon";
import type { Phase } from "./terminal-phase";

export interface TerminalToolbarProps {
  phase: Phase;
  historyOpen: boolean;
  filesOpen: boolean;
  onSplit: (direction: "horizontal" | "vertical") => void;
  onClear: () => void;
  onToggleHistory: () => void;
  onToggleFiles: () => void;
  onRefreshEnvironment: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
}

/**
 * 终端顶部工具条（纯展示）：所有动作由 `TerminalView` 传入。
 *
 * 与终端画布上的**右键菜单是同一组动作**（见 `use-terminal-menu.ts`），
 * 这里只负责把它们画成一排图标。
 */
export function TerminalToolbar({
  phase,
  historyOpen,
  filesOpen,
  onSplit,
  onClear,
  onToggleHistory,
  onToggleFiles,
  onRefreshEnvironment,
  onDisconnect,
  onReconnect,
}: TerminalToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-1  border-line bg-transparent px-2">
      <ToolbarIcon label={t("Split Vertically")} icon={Columns2} onClick={() => onSplit("horizontal")} />
      <ToolbarIcon label={t("Split Horizontally")} icon={Rows2} onClick={() => onSplit("vertical")} />
      <ToolbarIcon label={t("Clear Screen")} icon={Eraser} onClick={onClear} />
      <ToolbarIcon label={t("Command History")} icon={History} active={historyOpen} onClick={onToggleHistory} />
      <ToolbarIcon label={t("Remote Files")} icon={FolderOpen} active={filesOpen} onClick={onToggleFiles} />
      {/* 刷新环境：目录 / Docker / 服务 / 进程缓存一起失效并重新探测。
          只有点这里才会重新跑 `docker ps`，敲字符时一律用缓存。 */}
      <ToolbarIcon
        label={t("Refresh Environment")}
        icon={RefreshCw}
        disabled={phase !== "connected"}
        onClick={onRefreshEnvironment}
      />
      <div className="mx-1 h-4 w-px bg-line" />
      {phase === "connected" ? (
        <ToolbarIcon label={t("Disconnect")} icon={Unplug} onClick={onDisconnect} />
      ) : (
        <ToolbarIcon label={t("Reconnect")} icon={PlugZap} disabled={phase === "connecting"} onClick={onReconnect} />
      )}

    </div>
  );
}
