import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, History, Loader2, Trash2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { ExtremeIconButton } from "./ExtremeIconButton";
import { useOverlayLayer } from "@/components/ui/overlay";
import { useOverlayFocusTrap } from "@/hooks/use-overlay-focus-trap";
import { opsApi } from "@/api/ops-api";
import type { ExtremeTaskRecord } from "@/api/types/extreme";
import { cn } from "@/lib/cn";
import { useExtremeStore } from "@/stores/extreme-store";
import { Select } from "@/components/ui/select";
import { TaskCardView } from "./TaskCardView";
import type { TaskArtifact } from "./task-view";
import { cardFromRecord, filterHistory, mergeHistory } from "./task-view";

const KINDS = ["all", "deploy", "query", "probe", "build", "automation"] as const;
const STATUSES = ["all", "running", "waiting", "success", "failed", "cancelled"] as const;

const KIND_LABEL: Record<string, string> = {
  all: "全部",
  deploy: "部署",
  query: "查询",
  probe: "检测",
  build: "构建",
  automation: "自动化",
};

const STATUS_LABEL: Record<string, string> = {
  all: "全部",
  running: "执行中",
  waiting: "等待用户",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const RISK_LABEL: Record<string, string> = {
  read: "只读",
  write: "写入",
  danger: "危险",
};

/**
 * 统一任务历史。
 *
 * 数据流是**先合并、后筛选**：数据库记录与内存里的实时任务按 taskId 合并，
 * 再用实时状态覆盖，最后才按类型 / 状态 / 服务器过滤。顺序反了就会出现
 * "执行中筛选里躺着已成功的任务""成功筛选里看不到刚完成的任务"。
 *
 * 面板打开期间始终短轮询数据库（不只是有活跃任务时），配合 store 的实时
 * 订阅，新任务与状态变化都能立刻进列表。
 */
export function TaskHistoryPanel({
  open,
  onClose,
  onPreview,
  onOpenWorkspace,
  onOpenTask,
}: {
  open: boolean;
  onClose: () => void;
  onPreview?: (artifact: TaskArtifact, sessionId: string) => void;
  /** 用记录里的 workspaceId 打开原对话（父级负责关面板）。 */
  onOpenWorkspace: (workspaceId: string) => void;
  /** 打开原对话并**跳到发起这条任务的那条消息**（父级负责滚动与右栏定位）。 */
  onOpenTask?: (workspaceId: string, taskId: string) => void;
}) {
  const { t } = useTranslation();
  const layer = useOverlayLayer(open, "history");
  const panelRef = useRef<HTMLDivElement>(null);
  const [records, setRecords] = useState<ExtremeTaskRecord[]>([]);
  const [kind, setKind] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [server, setServer] = useState<string>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  /** 已经成功删除的记录：实时卡片可能还在 store 里，先在本面板隐藏。 */
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  useOverlayFocusTrap({ open, panelRef, layerId: layer.id, onRequestClose: onClose, initialFocus: "panel" });

  /** 只查「全部」：类型 / 状态 / 服务器都在合并之后做，避免筛选与实时状态打架。 */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const list = await opsApi.extremeTaskList({ limit: 200 });
      setRecords(list);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // 打开就拉一次；之后**无条件**轮询，后台新建的任务不用重开面板也能出现。
  useEffect(() => {
    if (!open) return undefined;
    void load();
    const timer = window.setInterval(() => void load(true), 4000);
    return () => window.clearInterval(timer);
  }, [open, load]);

  const liveTasks = useExtremeStore((state) => state.tasks);
  const workspaces = useExtremeStore((state) => state.workspaces);

  const mergedAll = useMemo(
    () => mergeHistory(records, liveTasks).filter((record) => !hiddenIds.has(record.id)),
    [records, liveTasks, hiddenIds],
  );

  const servers = useMemo(
    () => [...new Set(mergedAll.map((record) => record.server).filter(Boolean))].sort(),
    [mergedAll],
  );

  // 选中的服务器不在列表里了（记录被删 / 换了库）：回到「全部」，避免空列表。
  useEffect(() => {
    if (server !== "all" && !servers.includes(server)) setServer("all");
  }, [server, servers]);

  const visible = useMemo(
    () => filterHistory(mergedAll, { kind, status, server }),
    [mergedAll, kind, status, server],
  );

  // 详情不从筛选结果里找：任务完成离开「执行中」时，已打开的详情不该消失。
  const detail = useMemo(
    () => mergedAll.find((item) => item.id === selected) ?? null,
    [mergedAll, selected],
  );
  const live = detail ? liveTasks[detail.id] : undefined;
  const liveActive = live
    ? live.status === "running" || live.status === "confirming" || live.status === "waiting"
    : false;
  const canOpenWorkspace = detail?.workspaceId
    ? workspaces.some((workspace) => workspace.id === detail.workspaceId)
    : false;

  const titleOf = (record: ExtremeTaskRecord) =>
    record.name?.trim() || record.goal?.trim() || record.summary || record.id;

  const remove = (record: ExtremeTaskRecord) => {
    if (liveActive) {
      setNotice(t("任务仍在执行，停止后才能删除。"));
      return;
    }
    void opsApi.extremeTaskDelete(record.id).then((deleted) => {
      if (!deleted) {
        setNotice(t("任务仍在执行，停止后才能删除。"));
        return;
      }
      setNotice(null);
      setHiddenIds((current) => new Set(current).add(record.id));
      if (selected === record.id) setSelected(null);
      void load(true);
    });
  };

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40 px-4 py-6"
      style={{ zIndex: layer.zIndex }}
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("任务历史")}
        tabIndex={-1}
        className="page-overlay-surface flex h-[82vh] max-h-[82vh] w-[min(980px,94vw)] flex-col outline-none"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="page-overlay-header items-center">
          <History size={15} className="text-fg-subtle" />
          <div className="min-w-0 flex-1">
            <h2 className="page-overlay-title">{t("任务历史")}</h2>
            <p className="page-overlay-subtitle">
              {t("部署、查询、检测、构建与传输的每一步与真实输出都保存在这里。")}
            </p>
          </div>
          <ExtremeIconButton
            label={t("关闭")}
            icon={X}
            iconSize={14}
            side="bottom"
            onClick={onClose}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
          {KINDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
              className={cn(
                "rounded-full px-2 py-0.5 text-11",
                kind === id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-hover",
              )}
            >
              {t(KIND_LABEL[id])}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          {STATUSES.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={status === id}
              onClick={() => setStatus(id)}
              className={cn(
                "rounded-full px-2 py-0.5 text-11",
                status === id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-hover",
              )}
            >
              {t(STATUS_LABEL[id])}
            </button>
          ))}
          {servers.length > 0 && (
            <Select
              variant="menu"
              className="ml-auto w-[168px]"
              size="sm"
              value={server}
              ariaLabel={t("服务器")}
              testId="history-server-filter"
              onChange={setServer}
              options={[
                { value: "all", label: t("全部服务器") },
                ...servers.map((item) => ({ value: item, label: item })),
              ]}
            />
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-[300px] shrink-0 overflow-y-auto border-r border-line">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-3 text-11 text-fg-subtle">
                <Loader2 size={12} className="animate-spin" />
                {t("读取中…")}
              </div>
            )}
            {error && <div className="p-2"><ErrorState error={error} onRetry={() => void load()} /></div>}
            {!loading && !error && visible.length === 0 && (
              <EmptyState className="px-3 py-6" title={t("还没有任务记录")} description={t("发起一次部署或检测后，这里会留下每一步的真实输出。")} />
            )}
            <ul>
              {visible.map((record) => (
                <li key={record.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(record.id);
                      setNotice(null);
                    }}
                    className={cn(
                      "w-full border-b border-line px-3 py-2 text-left",
                      selected === record.id ? "bg-surface-2" : "hover:bg-surface-hover",
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-12">
                        {titleOf(record)}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-10",
                          record.status === "failed"
                            ? "text-danger"
                            : record.status === "success"
                              ? "text-success"
                              : "text-fg-subtle",
                        )}
                      >
                        {t(STATUS_LABEL[record.status] ?? record.status)}
                      </span>
                    </span>
                    {/* 最新结果只做摘要：标题固定在用户目标 / 自定义名称上。 */}
                    <span className="mt-0.5 block truncate text-11 text-fg-muted">
                      {record.summary || t("暂无结果")}
                    </span>
                    <span className="mt-0.5 block truncate text-10 text-fg-subtle">
                      {record.server} · {t(KIND_LABEL[record.kind] ?? record.kind)} ·{" "}
                      {t("风险：{{risk}}", {
                        risk: t(RISK_LABEL[record.risk ?? "read"] ?? "只读"),
                      })}{" "}
                      · {new Date(record.createdAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {detail ? (
              <div className="space-y-2">
                {notice && <p className="text-11 text-warning">{notice}</p>}
                <div className="flex flex-wrap items-center gap-1.5 text-11 text-fg-subtle">
                  <span className="min-w-0 flex-1 truncate">
                    {detail.server} · {t(KIND_LABEL[detail.kind] ?? detail.kind)} ·{" "}
                    {t("风险：{{risk}}", {
                      risk: t(RISK_LABEL[detail.risk ?? "read"] ?? "只读"),
                    })}
                  </span>
                  {detail.workspaceId && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="gap-1"
                      disabled={!canOpenWorkspace}
                      title={canOpenWorkspace ? undefined : t("原对话已删除")}
                      onClick={() => {
                        if (onOpenTask) onOpenTask(detail.workspaceId!, detail.id);
                        else onOpenWorkspace(detail.workspaceId!);
                      }}
                    >
                      <ArrowRight size={12} />
                      {t("打开原对话")}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    className="gap-1 text-fg-subtle"
                    disabled={liveActive}
                    title={liveActive ? t("任务仍在执行，停止后才能删除") : undefined}
                    onClick={() => remove(detail)}
                  >
                    <Trash2 size={12} />
                    {t("删除这条记录")}
                  </Button>
                </div>
                {/* 重命名：清空后保存 = 恢复显示用户目标。 */}
                <form
                  key={detail.id}
                  className="flex items-center gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const value = String(new FormData(event.currentTarget).get("name") ?? "");
                    void opsApi.extremeTaskRename(detail.id, value).then(() => {
                      setRecords((current) =>
                        current.map((item) =>
                          item.id === detail.id ? { ...item, name: value.trim() } : item,
                        ),
                      );
                      void load(true);
                    });
                  }}
                >
                  <input
                    name="name"
                    defaultValue={detail.name ?? ""}
                    placeholder={t("给这个任务起个名字")}
                    aria-label={t("任务名称")}
                    maxLength={120}
                    className="min-w-0 flex-1 rounded-[6px] border border-line bg-surface-1 px-2 py-1 text-11"
                  />
                  <button
                    type="submit"
                    className="shrink-0 rounded-[6px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
                  >
                    {t("保存名称")}
                  </button>
                </form>
                <TaskCardView
                  key={detail.id}
                  task={cardFromRecord(detail)}
                  defaultExpanded
                  onPreview={onPreview}
                />
              </div>
            ) : (
              <EmptyState
                className="h-full"
                title={t("选一条任务查看详情")}
                description={t("左侧按类型、状态与服务器筛选；执行中和等待用户的任务会排在前面。")}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
