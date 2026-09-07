import { ChevronDown, Columns2, Eraser, FolderOpen, History, PlugZap, RefreshCw, Rows2, Search, Sparkles, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ToolbarIcon } from "./ToolbarIcon";
import { TERMINAL_FONTS } from "./terminal-font";
import type { Phase } from "./terminal-phase";

export interface TerminalToolbarProps {
  phase: Phase;
  searchOpen: boolean;
  searchQuery: string;
  searchState: { index: number; total: number } | null;
  historyOpen: boolean;
  filesOpen: boolean;
  enhancedTerminal: boolean;
  fontId: string;
  onToggleSearch: () => void;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onSplit: (direction: "horizontal" | "vertical") => void;
  onClear: () => void;
  onToggleHistory: () => void;
  onToggleFiles: () => void;
  onRefreshEnvironment: () => void;
  onToggleEnhanced: () => void;
  onFontChange: (id: string) => void;
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
  searchOpen,
  searchQuery,
  searchState,
  historyOpen,
  filesOpen,
  enhancedTerminal,
  fontId,
  onToggleSearch,
  onSearchQueryChange,
  onSearch,
  onSplit,
  onClear,
  onToggleHistory,
  onToggleFiles,
  onRefreshEnvironment,
  onToggleEnhanced,
  onFontChange,
  onDisconnect,
  onReconnect,
}: TerminalToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-10 shrink-0 items-center gap-1  border-line bg-transparent px-2">
      <ToolbarIcon label={t("Search")} icon={Search} active={searchOpen} onClick={onToggleSearch} />
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
      {/* 增强终端：关着时终端就是纯终端（不注入标记、无结果面板）；
          打开后命令才会生成结果面板（不另设开关：开了就有、关了就什么都没有）。 */}
      <ToolbarIcon
        label={t("Enhanced Terminal")}
        icon={Sparkles}
        active={enhancedTerminal}
        onClick={onToggleEnhanced}
      />
      <div className="mx-1 h-4 w-px bg-line" />
      {/* 字体：终端与命令输出共用一套栈（不打包字体，没装则回退）。 */}
      <label className="flex items-center gap-1 text-11 text-fg-muted">
        {t("Font")}
        <span className="relative inline-flex items-center">
          <select
            value={fontId}
            onChange={(event) => onFontChange(event.target.value)}
            className="h-[26px] w-[132px] appearance-none rounded-[7px] border border-line bg-surface-2 pl-2 pr-5 text-11 text-fg outline-none focus:border-accent"
          >
            {TERMINAL_FONTS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
          <ChevronDown size={12} className="pointer-events-none absolute right-1.5 text-fg-subtle" />
        </span>
      </label>
      <div className="mx-1 h-4 w-px bg-line" />
      {phase === "connected" ? (
        <ToolbarIcon label={t("Disconnect")} icon={Unplug} onClick={onDisconnect} />
      ) : (
        <ToolbarIcon label={t("Reconnect")} icon={PlugZap} disabled={phase === "connecting"} onClick={onReconnect} />
      )}

      {searchOpen && (
        <div className="ml-2 flex items-center gap-1">
          <input
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSearch();
            }}
            placeholder={t("Search in scrollback")}
            spellCheck={false}
            className="h-[26px] w-48 rounded-[7px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          />
          <Button variant="ghost" size="xs" className="rounded-[7px]" onClick={onSearch}>
            {t("Search")}
          </Button>
          {searchState && (
            <span className="text-11 text-fg-subtle">
              {searchState.total === 0 ? t("No matches") : `${searchState.index + 1}/${searchState.total}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
