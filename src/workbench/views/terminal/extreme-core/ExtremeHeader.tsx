import { useTranslation } from "react-i18next";
import { ChevronLeft, History, PanelRight } from "@/components/icons";
import { cn } from "@/lib/cn";
import { PageToolbar, PageToolbarDivider } from "@/workbench/page-layout";
import { WindowControls } from "@/workbench/window-controls";
import { ToolbarIcon } from "@/workbench/views/terminal/ToolbarIcon";

export interface ExtremeHeaderProps {
  server: string | null;
  serverHost: string | null;
  /** Windows 用三个窗口按钮贴右边缘；macOS 让开原生红绿灯。 */
  mac: boolean;
  /** 回退到普通终端（SSH 会话与草稿都保留）。 */
  onBack: () => void;
  /** 右栏收起时，标题栏提供恢复入口。 */
  paneShown: boolean;
  onOpenPane: () => void;
  /** 任务历史浮层。 */
  onOpenHistory: () => void;
}

/**
 * 超能顶栏。
 *
 * 与其他页面共用 `PageToolbar` 的尺寸 token；差别只有右侧要放窗口按钮
 * （超能盖住了应用标题栏）。
 */
export function ExtremeHeader({
  server,
  serverHost,
  mac,
  onBack,
  paneShown,
  onOpenPane,
  onOpenHistory,
}: ExtremeHeaderProps) {
  const { t } = useTranslation();

  return (
    <PageToolbar
      data-tauri-drag-region
      className={cn("extreme-core-header extreme-core-frosted relative z-20", mac ? "pl-[76px] pr-0" : "pr-0")}
    >
      <div className="page-toolbar-summary flex min-w-0 items-center gap-2 text-12" data-tauri-drag-region>
        {/* 与应用标题栏同一枚 Logo；点击穿透给整条拖拽栏，不额外抢焦点。 */}
        <img
          src="/logo.png"
          alt="Ops Workbench"
          data-tauri-drag-region="false"
          draggable={false}
          className="pointer-events-none h-5 w-5 shrink-0 rounded-[4px]"
        />
        <span className="truncate font-medium" title={server ?? undefined}>
          {server ?? t("未绑定服务器")}
        </span>
        {serverHost && serverHost !== server && (
          <span className="truncate font-mono text-11 text-fg-subtle" title={serverHost}>
            {serverHost}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1" data-tauri-drag-region="false">
        {!paneShown && (
          <ToolbarIcon label={t("远程工作区")} icon={PanelRight} onClick={onOpenPane} />
        )}
        <ToolbarIcon label={t("任务历史")} icon={History} onClick={onOpenHistory} />
        <PageToolbarDivider />
        <ToolbarIcon label={t("返回普通终端，会话与任务都保留")} icon={ChevronLeft} onClick={onBack} />
        {!mac && <WindowControls />}
      </div>
    </PageToolbar>
  );
}
