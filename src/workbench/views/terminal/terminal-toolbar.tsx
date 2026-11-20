import {
  Columns2,
  Eraser,
  FolderOpen,
  History,
  PlugZap,
  RefreshCw,
  Rows2,
  SquareTerminal,
  Unplug,
} from "@/components/icons";
import { useTranslation } from "react-i18next";
import { PageToolbar, PageToolbarDivider } from "@/workbench/page-layout";
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
  /** 超能模式开关状态（绑定当前 SSH 会话的 AI 工作区）。 */
  extreme?: boolean;
  onToggleExtreme?: () => void;
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
  extreme = false,
  onToggleExtreme,
}: TerminalToolbarProps) {
  const { t } = useTranslation();

  return (
    <PageToolbar>
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
      {/* 超能模式：把当前服务器切到 AI 对话与部署工作区（未连接禁用）。 */}
      <ToolbarIcon
        label={t("超能模式")}
        icon={SquareTerminal}
        active={extreme}
        disabled={phase !== "connected"}
        onClick={() => onToggleExtreme?.()}
      />
      <PageToolbarDivider />
      {/*
       * 连接中也要给一个能点的键：以前这里显示**禁用的**重连键，一次卡住的
       * 握手会让用户既取消不了也重连不了（只能看着转圈）。
       */}
      {phase === "connected" || phase === "connecting" ? (
        <ToolbarIcon label={t("Disconnect")} icon={Unplug} onClick={onDisconnect} />
      ) : (
        <ToolbarIcon label={t("Reconnect")} icon={PlugZap} onClick={onReconnect} />
      )}

    </PageToolbar>
  );
}
