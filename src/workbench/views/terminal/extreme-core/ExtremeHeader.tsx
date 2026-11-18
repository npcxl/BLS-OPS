import { useTranslation } from "react-i18next";
import { ChevronLeft, History, PanelRight, SquareTerminal } from "@/components/icons";
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
  /** 右栏（会话工作区）当前是否展开：切换按钮跟着亮。 */
  paneShown: boolean;
  /** 右栏 › 终端 › 执行输出。 */
  onOpenTerminal: () => void;
  /** 收起 / 展开右栏。 */
  onTogglePane: () => void;
  /** 任务历史浮层。 */
  onOpenHistory: () => void;
}

/**
 * 超能顶栏。
 *
 * 与其他页面共用 `PageToolbar` 的尺寸 token；差别只有右侧要放窗口按钮
 * （超能盖住了应用标题栏）。
 *
 * 右侧从右往左：窗口控制 → 返回普通终端 → 分隔 → 终端 / 右栏 / 任务历史。
 * 三个入口原来塞在输入框右下角那块玻璃里，宽度被挤得只剩图标、还占掉输入
 * 区一行；放到这里与窗口按钮同一排，既不占高度也和"关闭"这类窗口级操作在
 * 一起。
 */
export function ExtremeHeader({
  server,
  serverHost,
  mac,
  onBack,
  paneShown,
  onOpenTerminal,
  onTogglePane,
  onOpenHistory,
}: ExtremeHeaderProps) {
  const { t } = useTranslation();

  return (
    <PageToolbar
      data-tauri-drag-region
      className={cn("extreme-core-header extreme-core-frosted relative z-20", mac ? "pl-[76px] pr-0" : "pr-0")}
    >
      <div className="page-toolbar-summary flex min-w-0 items-center gap-2 text-12" data-tauri-drag-region>
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
        <ToolbarIcon label={t("打开终端")} icon={SquareTerminal} onClick={onOpenTerminal} />
        <ToolbarIcon
          label={paneShown ? t("收起右栏") : t("远程工作区")}
          icon={PanelRight}
          active={paneShown}
          onClick={onTogglePane}
        />
        <ToolbarIcon label={t("任务历史")} icon={History} onClick={onOpenHistory} />
        <PageToolbarDivider />
        <ToolbarIcon label={t("返回普通终端，会话与任务都保留")} icon={ChevronLeft} onClick={onBack} />
        {!mac && <WindowControls />}
      </div>
    </PageToolbar>
  );
}
