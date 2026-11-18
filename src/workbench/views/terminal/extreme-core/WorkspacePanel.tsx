import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsLeft, FileUp, FolderOpen, ListOrdered, Maximize2, SquareTerminal, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PaneTabBar, type PaneTab } from "@/components/ui/pane-tab-bar";
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
 * 四个固定标签（远程文件｜终端｜附件｜计划），切标签只换内容；顶部固定着
 * 服务器名、展开视图 / 返回分栏、收起。标签外观与数据库标签条一致（共用
 * `PaneTabBar`），但**不引入数据库的任何状态**。
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
  terminalTab,
  onTabChange,
  onTerminalTabChange,
  onWidthChange,
  onCollapse,
  onExpand,
  onRestore,
  files,
  output,
  manual,
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
  terminalTab: TerminalPane;
  onTabChange: (tab: WorkspacePane) => void;
  onTerminalTabChange: (tab: TerminalPane) => void;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  onExpand: () => void;
  onRestore: () => void;
  files: ReactNode;
  output: ReactNode;
  manual: ReactNode;
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
  logCount?: number;
}) {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const toggle = (id: string) =>
    onSelectedChange(
      selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id],
    );

  const tabs: PaneTab[] = [
    { id: "files", label: t("远程文件"), icon: FolderOpen },
    {
      id: "terminal",
      label: t("终端"),
      icon: SquareTerminal,
      badge:
        outputCount > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {outputCount}
          </span>
        ) : undefined,
    },
    {
      id: "attachments",
      label: t("附件"),
      icon: FileUp,
      badge:
        attachments.length > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {attachments.length}
          </span>
        ) : undefined,
    },
    {
      id: "plan",
      label: t("计划"),
      icon: ListOrdered,
      badge:
        steps.length > 0 ? (
          <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
            {steps.length}
          </span>
        ) : undefined,
    },
  ];

  /** 拖动左边缘调宽度：向左拖 = 变宽。 */
  const onHandleDown = (event: React.PointerEvent) => {
    if (view === "expanded") return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    const move = (moveEvent: PointerEvent) => {
      const start = dragRef.current;
      if (!start) return;
      onWidthChange(start.startWidth - (moveEvent.clientX - start.startX));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
         * 展开视图：不再让面板铺满整个内容区，而是**中间一块 960 的宽面板**，
         * 四周是压暗的聊天（聊天仍挂载、状态不丢）。窗口窄于 960 时自然铺满。
         */
        view === "expanded"
          ? "absolute inset-0 z-30 bg-black/25 backdrop-blur-[2px]"
          : overlay
            ? "absolute inset-y-0 right-0 z-20 border-l border-line/70 bg-surface-1 shadow-2xl"
            : "shrink-0 border-l border-line/70",
      )}
      style={view === "expanded" ? undefined : { width }}
    >
      {view === "split" && !overlay && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("拖动调整右栏宽度")}
          onPointerDown={onHandleDown}
          className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-accent/40"
        />
      )}

      {/*
       * 展开时这里是真正的面板（限宽 960）；分栏 / 浮层时 `contents`，
       * 让原有子节点继续直接参与 aside 的 flex 布局，结构不变。
       */}
      <div
        className={cn(
          view === "expanded"
            ? "mx-auto flex h-full w-full max-w-[960px] flex-col border-x border-line/70 bg-surface-1 shadow-[0_10px_40px_rgb(0_0_0/0.18)]"
            : "contents",
        )}
      >
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

      <div className="px-2">
        <PaneTabBar
          tabs={tabs}
          value={tab}
          onChange={(id) => onTabChange(id as WorkspacePane)}
          ariaLabel={t("会话工作区标签")}
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
      {tab === "files" && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{files}</div>
      )}

      {tab === "terminal" && (
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
          <div className="flex min-h-0 flex-1 flex-col pt-1">
            {terminalTab === "output" && output}
            {terminalTab === "manual" && manual}
          </div>
        </div>
      )}

      {tab === "attachments" && (
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

      {tab === "plan" && plan && (
        <RunPlanPanel record={plan} onFocusStep={(step) => onFocusStep(step as PaneStep)} />
      )}

      {tab === "plan" && !plan && (
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
