import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronsLeft,
  FileDiff,
  FileText,
  FileUp,
  FolderOpen,
  Globe,
  ListOrdered,
  Maximize2,
  SquareTerminal,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import type { IconComponent } from "@/components/icons";
import { PaneTabBar, type PaneTab } from "@/components/ui/pane-tab-bar";
import { ToolbarIcon } from "@/workbench/views/terminal/ToolbarIcon";
import { RunPlanPanel } from "./RunPlanPanel";
import { attachmentReadState } from "./attachments";
import type { RunRecord } from "./run-plan";
import { cn } from "@/lib/cn";
import { formatSize } from "@/lib/format";
/**
 * 计划里的一步。
 *
 * 结构化：`title` 是人话，`detail` 是目标/命令，`state` 是执行器给的结论
 * （不是模型自己说的"已完成"）。
 */
export interface PaneStep {
  title: string;
  state: string;
  detail?: string | null;
  command?: string | null;
}
import type {
  ExtremeAttachment,
  TerminalPane,
  WorkspacePane,
  WorkspacePaneView,
} from "@/stores/extreme-store";

/**
 * 右栏：**跟随当前会话的工作区**。
 *
 * 第一行是服务器与视图控制，第二行用 `PaneTabBar` 容纳可关闭的标签和固定快捷入口。
 *
 * 文件与终端内容由页面注入（它们需要 SSH、任务与预览状态）；附件与计划在
 * 这里渲染，因为它们只用会话里的数据。
 */
export function WorkspacePanel({
  sessionId,
  serverName,
  view,
  width,
  overlay = false,
  tab,
  tabs,
  terminalTab,
  onTabChange,
  onCloseTab,
  onTerminalTabChange,
  onWidthChange,
  onOuterDragStart,
  onDraggingChange,
  onCollapse,
  onExpand,
  onRestore,
  onAddTerminalOutput,
  files,
  output,
  manual,
  logs,
  changes,
  pendingChanges = 0,
  browser,
  attachments,
  selectedIds,
  onSelectedChange,
  onPreviewAttachment,
  onRetryAttachment,
  onRemoveAttachment,
  onOpenRemotePath,
  runLabel,
  steps,
  plan,
  onFocusStep,
  outputCount,
  logLive = false,
}: {
  sessionId: string | null;
  serverName: string;
  view: Exclude<WorkspacePaneView, "hidden">;
  width: number;
  /**
   * 窗口太窄：**盖在聊天上**，而不是把聊天挤到只剩一条。
   *
   * 分栏需要「聊天 ≥ 520 + 右栏 ≥ 300」，放不下时宁可让右栏浮起来（带阴影、
   * 可关闭），也不把输入框压成两行都放不下的宽度。
   */
  overlay?: boolean;
  tab: WorkspacePane;
  /** 这条对话**已打开**的标签（浏览器式，可关闭）。 */
  tabs: WorkspacePane[];
  terminalTab: TerminalPane;
  onTabChange: (tab: WorkspacePane) => void;
  /** 关掉一个标签；最后一个由页面收起右栏。 */
  onCloseTab: (tab: WorkspacePane) => void;
  onTerminalTabChange: (tab: TerminalPane) => void;
  /** 拖动中的中间帧先不落盘（`persist: false`），松手时才写一次。 */
  onWidthChange: (width: number, persist?: boolean) => void;
  /** 右缘向外拖：由页面负责扩窗与右栏宽度（见 `pane-outer-drag.ts`）。 */
  onOuterDragStart: (event: React.PointerEvent<HTMLElement>) => void;
  /** 内拖 / 外扩开始或结束：浏览器子视图据此临时隐藏。 */
  onDraggingChange: (dragging: boolean) => void;
  onCollapse: () => void;
  onExpand: () => void;
  onRestore: () => void;
  /**
   * 「加入本次对话」：把真实终端的最近输出加进这次发送的材料。
   *
   * 「仅本条 / 自选」不再自动附带终端输出，想看就自己加。
   */
  onAddTerminalOutput?: () => void;
  files: ReactNode;
  output: ReactNode;
  manual: ReactNode;
  logs: ReactNode;
  /** 文件变更审阅：统一 Diff + 文件树（按当前对话与运行归属）。 */
  changes: ReactNode;
  /** 待确认的变更数量：标签上的角标。 */
  pendingChanges?: number;
  browser: ReactNode;
  attachments: ExtremeAttachment[];
  /** 勾选 = 用于本次发送；状态由页面持有（输入区要显示数量）。 */
  selectedIds: string[];
  onSelectedChange: (ids: string[]) => void;
  onPreviewAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenRemotePath: (path: string) => void;
  runLabel: string;
  steps: PaneStep[];
  /** 运行记录（有它就用新的计划视图，简单任务只显示一行状态）。 */
  plan?: RunRecord | null;
  onFocusStep: (step: PaneStep) => void;
  outputCount: number;
  /** 日志标签是否正在监听（只影响标签上的状态点）。 */
  logLive?: boolean;
}) {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    latest: number;
    frame: number | null;
  } | null>(null);
  /** 当前这段拖拽的解绑函数：卸载 / 重新按下时先清掉。 */
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  /**
   * 展开视图的宽度：和分栏宽度分开记。
   *
   * 展开后默认还是一块宽面板，但左缘可以继续拖 —— 用户不该被 960 卡死。
   * 分栏宽度存 store（跨会话），展开宽度只影响本次展开，切回分栏不受影响。
   */
  const [expandedWidth, setExpandedWidth] = useState(() =>
    Math.min(960, Math.max(560, window.innerWidth - 160)),
  );
  const currentWidth = view === "expanded" ? expandedWidth : width;

  const applyWidth = (next: number, persist: boolean) => {
    if (view === "expanded") {
      const max = Math.max(560, window.innerWidth - 96);
      setExpandedWidth(Math.min(Math.max(next, 560), max));
      return;
    }
    // 分栏只保底 300；上限由页面用“扣除任务栏后的可用宽度 - 聊天下限”
    // 这一套约束统一计算，避免拖动与渲染各算一套。
    onWidthChange(Math.max(300, next), persist);
  };

  const toggle = (id: string) =>
    onSelectedChange(
      selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id],
    );

  /** 标签的固定信息；打开列表由页面按当前对话传入。 */
  const meta: Record<
    WorkspacePane,
    { label: string; icon: IconComponent; badge?: ReactNode }
  > = {
    files: { label: t("远程文件"), icon: FolderOpen },
    terminal: {
      label: t("终端"),
      icon: SquareTerminal,
      badge:
        outputCount > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {outputCount}
          </span>
        ) : undefined,
    },
    logs: {
      label: t("实时日志"),
      icon: FileText,
      // 只在监听中点亮：一眼看出后台还在收。
      badge: logLive ? (
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
      ) : undefined,
    },
    attachments: {
      label: t("附件"),
      icon: FileUp,
      badge:
        attachments.length > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {attachments.length}
          </span>
        ) : undefined,
    },
    plan: {
      label: t("计划"),
      icon: ListOrdered,
      badge:
        steps.length > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {steps.length}
          </span>
        ) : undefined,
    },
    changes: {
      label: t("文件变更"),
      icon: FileDiff,
      // 只有"待确认"才需要计数：已经执行完的不该一直挂着角标。
      badge:
        pendingChanges > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-warning/15 px-1 text-[10px] leading-4 text-warning">
            {pendingChanges}
          </span>
        ) : undefined,
    },
    browser: { label: t("浏览器"), icon: Globe },
  };
  const items: PaneTab[] = tabs.map((id) => ({
    id,
    label: meta[id].label,
    icon: meta[id].icon,
    badge: meta[id].badge,
    onClose: () => onCloseTab(id),
  }));
  // 当前标签可能刚被关掉：渲染时退到第一个已打开的标签。
  const activeTab: WorkspacePane = tabs.includes(tab) ? tab : tabs[0] ?? tab;

  /**
   * 拖动左边缘调宽度：向左拖 = 变宽。
   *
   * 移动期间**按帧**上报（`persist: false`，只改内存里的宽度），松手才落盘
   * 一次 —— 以前每个 `pointermove` 都写一遍 localStorage（序列化整份面板
   * 状态），拖动时的卡顿就来自这里。`pointercancel` 与组件卸载都会解绑监听，
   * 不会留下继续改宽度的野回调。
   */
  const onHandleDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const drag = {
      startX: event.clientX,
      startWidth: currentWidth,
      latest: currentWidth,
      frame: null as number | null,
    };
    dragRef.current = drag;
    // 原生浏览器的子 WebView 会盖住指针 / 不跟随 DOM 重排：拖动期间先收起。
    onDraggingChange(true);
    // 上一段拖拽没收到 pointerup（少见）：先把它的监听解掉。
    dragCleanup.current?.();

    const flush = () => {
      drag.frame = null;
      if (dragRef.current !== drag) return;
      applyWidth(drag.latest, false);
    };
    const move = (moveEvent: PointerEvent) => {
      if (dragRef.current !== drag) return;
      /*
       * 展开面板是居中的：宽度增加 Δ，左右各外扩 Δ/2，手柄才会停在光标下，
       * 所以这里乘 2；分栏是右对齐的，1:1 即可。
       */
      const factor = view === "expanded" ? 2 : 1;
      drag.latest = drag.startWidth - (moveEvent.clientX - drag.startX) * factor;
      // 同一帧里的多次 pointermove 只上报一次。
      if (drag.frame === null) drag.frame = requestAnimationFrame(flush);
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    const finish = () => {
      if (dragRef.current !== drag) return;
      dragRef.current = null;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      detach();
      dragCleanup.current = null;
      // 松手才保存最终值：中间帧只更新界面。
      applyWidth(drag.latest, true);
      onDraggingChange(false);
    };
    dragCleanup.current = () => {
      detach();
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      if (dragRef.current === drag) dragRef.current = null;
      onDraggingChange(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  /** 方向键调宽（分隔线可聚焦）：左 = 变宽，与拖动同一个方向。 */
  const onHandleKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyWidth(currentWidth + step, true);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyWidth(currentWidth - step, true);
    }
  };

  return (
    <aside
      ref={asideRef}
      aria-label={t("会话工作区")}
      data-pane-view={view}
      data-pane-overlay={overlay ? "true" : undefined}
      className={cn(
        "extreme-core-frosted relative flex min-h-0 flex-col overflow-hidden",
        /*
         * 展开视图：中间一块宽面板，四周是压暗的聊天（聊天仍挂载、状态不丢）。
         * 宽度不再写死：左缘手柄可以继续拖，窗口变窄时由 max-w-full 兜底。
         */
        view === "expanded"
          ? "absolute inset-0 z-30 bg-black/25 backdrop-blur-[2px]"
          : overlay
            ? "absolute inset-y-0 right-0 z-20 border-l border-line/70 bg-surface-1 shadow-2xl"
            : "shrink-0 border-l border-line/70",
      )}
      style={view === "expanded" ? undefined : { width }}
    >
      {view === "split" && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("拖动调整右栏宽度")}
          aria-valuenow={Math.round(width)}
          aria-valuemin={300}
          aria-valuemax={Math.max(300, window.innerWidth - 96)}
          tabIndex={0}
          title={t("拖动调整宽度；聚焦后可用左右方向键（Shift 加大步长）")}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          className="group absolute inset-y-0 left-0 z-10 w-3 touch-none cursor-col-resize focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/35 transition-colors duration-150 group-hover:bg-accent/60 group-focus-visible:bg-accent/60"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line/70 bg-surface-1 px-1 py-px text-[10px] leading-3 text-fg-subtle opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            ↔
          </span>
        </div>
      )}
      {view === "split" && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("向外拖宽右栏")}
          aria-valuenow={Math.round(width)}
          aria-valuemin={300}
          aria-valuemax={Math.max(300, window.innerWidth - 96)}
          tabIndex={0}
          title={t("向右拖动：窗口和右栏一起变宽，聊天区保持宽度；最大化时在窗口内加宽")}
          onPointerDown={(event) => {
            event.preventDefault();
            onOuterDragStart(event);
          }}
          className="group absolute inset-y-0 right-0 z-20 w-3 touch-none cursor-ew-resize focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/35 transition-colors duration-150 group-hover:bg-accent/60 group-focus-visible:bg-accent/60"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line/70 bg-surface-1 px-1 py-px text-[10px] leading-3 text-fg-subtle opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            ↔
          </span>
        </div>
      )}

      {/*
       * 展开时这里是真正的面板；分栏 / 浮层时 `contents`，让原有子节点继续
       * 直接参与 aside 的 flex 布局，结构不变。
       */}
      <div
        className={cn(
          view === "expanded"
            ? "relative mx-auto flex h-full w-full max-w-full flex-col border-x border-line/70 bg-surface-1 shadow-[0_10px_40px_rgb(0_0_0/0.18)]"
            : "contents",
        )}
        style={view === "expanded" ? { width: expandedWidth } : undefined}
      >
      {view === "expanded" && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("拖动调整右栏宽度")}
          aria-valuenow={Math.round(expandedWidth)}
          aria-valuemin={560}
          aria-valuemax={Math.max(560, window.innerWidth - 96)}
          tabIndex={0}
          title={t("拖动调整宽度；聚焦后可用左右方向键（Shift 加大步长）")}
          onPointerDown={onHandleDown}
          onKeyDown={onHandleKey}
          className="group absolute inset-y-0 left-0 z-20 w-3 touch-none cursor-col-resize focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line/35 transition-colors duration-150 group-hover:bg-accent/60 group-focus-visible:bg-accent/60"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-line/70 bg-surface-1 px-1 py-px text-[10px] leading-3 text-fg-subtle opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            ↔
          </span>
        </div>
      )}
      {/* 顶部：服务器名 + 展开 / 收起。 */}
      <div className="flex h-[var(--page-toolbar-height)] shrink-0 items-center gap-1.5 px-2">
        <span className="min-w-0 flex-1 truncate text-12 text-fg-muted" title={serverName}>
          {serverName || t("未关联服务器")}
        </span>
        {view === "split" ? (
          <Button variant="ghost" size="xs" onClick={onExpand} title={t("展开视图")}>
            <Maximize2 size={13} /> {t("展开")}
          </Button>
        ) : (
          <Button variant="ghost" size="xs" onClick={onRestore} title={t("返回分栏")}>
            <ChevronsLeft size={13} /> {t("返回分栏")}
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          aria-label={t("收起右栏")}
          title={t("收起右栏")}
          onClick={onCollapse}
        >
          <X size={13} />
        </Button>
      </div>

      <div className="extreme-core-pane-tabs px-2">
        <PaneTabBar
          tabs={items}
          value={activeTab}
          onChange={(id) => onTabChange(id as WorkspacePane)}
          ariaLabel={t("会话工作区标签")}
          trailing={
            <div role="toolbar" aria-label={t("远程工作区")} className="flex shrink-0 items-center border-l border-divider/70 pl-1">
              <ToolbarIcon label={t("远程文件")} icon={FolderOpen} onClick={() => onTabChange("files")} />
              <ToolbarIcon label={t("服务器终端")} icon={SquareTerminal} onClick={() => onTabChange("terminal")} />
              <ToolbarIcon label={t("日志")} icon={FileText} onClick={() => onTabChange("logs")} />
              <ToolbarIcon label={t("文件变更")} icon={FileDiff} onClick={() => onTabChange("changes")} />
            </div>
          }
        />
      </div>

      {!sessionId && (
        <p
          role="status"
          className="border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-11 text-warning"
        >
          {t("服务器未连接：可以查看历史，重新连接后才能继续执行。")}
        </p>
      )}

      {/* `min-w-0 overflow-hidden`：长路径 / 长文件名只能在自己的区域截断，不能撑宽右栏。 */}
      {activeTab === "files" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{files}</div>
      )}

      {activeTab === "terminal" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 pt-1.5">
            <PaneTabBar
              size="sm"
              tabs={[
                { id: "output", label: t("执行输出") },
                { id: "manual", label: t("真实终端") },
              ]}
              value={terminalTab}
              onChange={(id) => onTerminalTabChange(id as TerminalPane)}
              ariaLabel={t("终端内容")}
            />
          </div>
          {/*
           * 真实终端的输出**不自动进请求**（只有「当前会话」范围才会自动带），
           * 想看就点这里加入：加完在输入框上方能看到这条材料。
           */}
          {terminalTab === "manual" && onAddTerminalOutput && (
            <div className="flex justify-end px-2 pt-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={onAddTerminalOutput}
                title={t("把真实终端的最近输出加进这次发送")}
              >
                <FileUp size={12} /> {t("加入本次对话")}
              </Button>
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            {terminalTab === "output" && output}
            {terminalTab === "manual" && manual}
          </div>
        </div>
      )}

      {activeTab === "logs" && (
        <div className="flex min-h-0 flex-1 flex-col">{logs}</div>
      )}

      {/*
       * 文件变更：正文用统一 Diff，右侧是服务器目录树。
       * `min-w-0 overflow-hidden` 保证长路径只在正文里换行，不撑宽右栏。
       */}
      {activeTab === "changes" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{changes}</div>
      )}

      {activeTab === "browser" && (
        // 留出两边手柄的 10px：原生子 WebView 会盖住同位置的主 WebView 元素，
        // 不留缝的话右缘外拖 / 左缘内拖在浏览器标签下点不到。
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-3">{browser}</div>
      )}

      {activeTab === "attachments" && (
        <div className="flex min-h-0 flex-1 flex-col">
          {attachments.length === 0 ? (
            <p className="px-3 py-2 text-11 text-fg-subtle">
              {t("这次会话还没有附件：从输入框的 ＋ 或直接拖进来。")}
            </p>
          ) : (
            <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
              {attachments.map((item) => {
                const remote =
                  item.uploadState === "uploaded" || item.uploadState === "deployed";
                /*
                 * 服务器上的文件：**读没读到正文**要如实标出来。
                 *
                 * 读不到不等于不能用 —— 路径照样有效，工具能自己读；但用户得
                 * 知道这一次是"已经拿到内容"还是"只有一条路径"。
                 */
                const read = attachmentReadState(item);
                const status =
                  item.state === "pending"
                    ? { label: t("读取中…"), tone: "text-fg-subtle" }
                    : item.state === "failed"
                      ? { label: t("读取失败"), tone: "text-danger" }
                      : item.uploadState === "uploading"
                        ? { label: t("上传中…"), tone: "text-accent" }
                        : remote
                          ? read === "failed"
                            ? { label: t("读取失败 · 按路径使用"), tone: "text-warning" }
                            : read === "binary"
                              ? { label: t("二进制 · 按路径使用"), tone: "text-fg-subtle" }
                              : read === "pending"
                                ? { label: t("读取中…"), tone: "text-accent" }
                                : { label: t("已读取 · 在服务器上"), tone: "text-success" }
                          : { label: t("待上传"), tone: "text-fg-subtle" };
                return (
                  <li key={item.id} className="flex items-start gap-1.5 rounded-md px-1 py-1">
                    <input
                      type="checkbox"
                      aria-label={t("选择 {{name}}", { name: item.name })}
                      checked={selectedIds.includes(item.id)}
                      onChange={() => toggle(item.id)}
                      className="mt-0.5 size-3 shrink-0 accent-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onPreviewAttachment(item.id)}
                        className="block w-full truncate text-left text-11 text-fg hover:underline"
                        title={item.path ?? item.name}
                      >
                        {item.name}
                      </button>
                      <p className="truncate text-10 text-fg-subtle">
                        {formatSize(item.size)} · <span className={status.tone}>{status.label}</span>
                      </p>
                      {item.remotePath && (
                        <button
                          type="button"
                          onClick={() => onOpenRemotePath(item.remotePath!)}
                          className="block w-full truncate text-left font-mono text-10 text-accent hover:underline"
                          title={item.remotePath}
                        >
                          {item.remotePath}
                        </button>
                      )}
                    </div>
                    {item.state === "failed" && (
                      <Button variant="ghost" size="xs" onClick={() => onRetryAttachment(item.id)}>
                        {t("重试")}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={t("移除 {{name}}", { name: item.name })}
                      onClick={() => onRemoveAttachment(item.id)}
                    >
                      <X size={12} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          {selectedIds.length > 0 && (
            <div className="flex shrink-0 items-center gap-1 border-t border-line/70 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-10 text-fg-subtle">
                {t("已选 {{n}} 个，用于本次发送", { n: selectedIds.length })}
              </span>
              <Button variant="ghost" size="xs" onClick={() => onSelectedChange([])}>
                {t("清空")}
              </Button>
            </div>
          )}
        </div>
      )}

      {activeTab === "plan" && plan && (
        <RunPlanPanel record={plan} onFocusStep={(step) => onFocusStep(step as PaneStep)} />
      )}

      {activeTab === "plan" && !plan && (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="px-3 py-1.5 text-11 text-fg-muted">{runLabel}</p>
          {steps.length === 0 ? (
            <p className="px-3 text-11 text-fg-subtle">
              {t("这次运行还没有步骤：简单查询不会展开计划，结果直接回到对话。")}
            </p>
          ) : (
            <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2">
              {steps.map((step, index) => {
                const tone =
                  step.state === "done"
                    ? "bg-success"
                    : step.state === "running"
                      ? "bg-accent animate-pulse"
                      : step.state === "failed"
                        ? "bg-danger"
                        : "bg-fg-subtle/40";
                return (
                  <li key={`${index}-${step.title}`}>
                    <button
                      type="button"
                      onClick={() => onFocusStep(step)}
                      className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-surface-hover"
                    >
                      <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", tone)} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-11 text-fg" title={step.title}>
                          {index + 1}. {step.title}
                        </span>
                        {(step.detail || step.command) && (
                          <span className="block truncate font-mono text-10 text-fg-subtle">
                            {step.detail || step.command}
                          </span>
                        )}
                      </span>
                      {step.state === "failed" && (
                        <span className="shrink-0 text-10 text-danger">{t("失败")}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      </div>
    </aside>
  );
}
