import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileText,
  Folder,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { PaneTabBar } from "@/components/ui/pane-tab-bar";
import { StatusBadge } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import type {
  DiffHunk,
  FileChangeDetail,
  FileChangeSummary,
} from "@/api/types/agent";
import { opsApi } from "@/api/ops-api";
import { useExtremeStore, type ChangeViewState } from "@/stores/extreme-store";
import {
  backupVerified,
  batchStateLabel,
  batchSummary,
  batchTone,
  buildChangeTree,
  canOpenInRemote,
  changeStatusLabel,
  changeTone,
  countInDir,
  diffSegments,
  fileLabel,
  filterChanges,
  gapLines,
  isPending,
  stageLabel,
  type ChangeDir,
} from "./file-changes";

/**
 * 右栏「文件变更」：统一 Diff + 按服务器目录分组的文件树。
 *
 * 数据分两层：列表（`FileChangeSummary`，随事件更新、只带摘要）与正文
 * （`agent_file_change_detail`，按需加载）。面板切走再回来不会重新拉全量。
 *
 * 归属：所有可见内容都按 `workspaceId` 过滤 —— 切对话时换一份，绝不显示
 * 上一条对话的文件。阅读状态（筛选 / 打开的文件 / 滚动位置）按
 * 「对话 + 变更批次」记在 store 里。
 */
export function FileChangesPane({
  workspaceId,
  serverName,
  sessionId,
  focus,
  onOpenRemotePath,
}: {
  workspaceId: string | null;
  /** 当前对话绑定的服务器：记录里没有服务器时兜底显示。 */
  serverName: string;
  /** 当前连接：断开时只读（历史仍可看）。 */
  sessionId: string | null;
  /** 从聊天点进来：定位到某次运行 / 某个文件。 */
  focus?: { taskId: string; changeId?: string; nonce: number } | null;
  /** 「在远程文件中打开」：只在文件被确认存在时出现。 */
  onOpenRemotePath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const changesById = useExtremeStore((state) => state.fileChanges);
  const tasks = useExtremeStore((state) => state.tasks);
  const changeViews = useExtremeStore((state) => state.changeViews);
  const setChangeView = useExtremeStore((state) => state.setChangeView);
  const mergeFileChanges = useExtremeStore((state) => state.mergeFileChanges);
  const flushChangeViews = useExtremeStore((state) => state.flushChangeViews);

  const [details, setDetails] = useState<Record<string, FileChangeDetail>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 正文当前滚到哪个文件：文件树的选中项跟着它走（不写回 store 的高频路径）。 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const scrollSave = useRef<number | null>(null);

  /** 这条对话的全部记录：切换对话时不混入别人的。 */
  const mine = useMemo(
    () =>
      Object.values(changesById)
        .filter((change) => change.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt - b.createdAt || a.stepIndex - b.stepIndex),
    [changesById, workspaceId],
  );

  /** 按运行（taskId）分批：新的在前，界面用来做"运行"下拉。 */
  const runs = useMemo(() => {
    const map = new Map<string, { taskId: string; changes: FileChangeSummary[]; at: number }>();
    for (const change of mine) {
      const entry = map.get(change.taskId) ?? { taskId: change.taskId, changes: [], at: 0 };
      entry.changes.push(change);
      entry.at = Math.max(entry.at, change.updatedAt);
      map.set(change.taskId, entry);
    }
    return [...map.values()].sort((a, b) => b.at - a.at);
  }, [mine]);

  const pending = useMemo(() => mine.filter((change) => isPending(change.status)), [mine]);

  const labelOfRun = useCallback(
    (taskId: string) => {
      const task = tasks[taskId];
      const goal = task?.goal?.trim() || task?.title?.trim();
      return goal ? goal.slice(0, 60) : t("运行 {{id}}", { id: taskId.slice(0, 8) });
    },
    [tasks, t],
  );

  /* ---------------- 阅读状态：按对话 + 批次记 ---------------- */

  /**
   * 只有**这条对话里真的有记录**的运行才认：聊天里点开的 focus 来自另一条
   * 对话时（切换对话后残留），必须忽略，不能拿它去筛当前对话的文件。
   */
  const focusTaskId =
    focus && runs.some((run) => run.taskId === focus.taskId) ? focus.taskId : null;

  const viewKey = useMemo(() => {
    if (!workspaceId) return "";
    if (focusTaskId) return `${workspaceId}:${focusTaskId}`;
    return `${workspaceId}:${runs[0]?.taskId ?? ""}`;
  }, [workspaceId, focusTaskId, runs]);

  const view: ChangeViewState = changeViews[viewKey] ?? {
    mode: "run",
    filter: "",
    expanded: [],
    scrollTop: 0,
  };

  /** 没有显式选择时：定位到 focus，其次上次选中的运行，最后最近一次。 */
  const activeTaskId = useMemo(() => {
    if (focusTaskId) return focusTaskId;
    if (view.taskId && runs.some((run) => run.taskId === view.taskId)) return view.taskId;
    return runs[0]?.taskId ?? null;
  }, [focusTaskId, view.taskId, runs]);

  const mode: "pending" | "run" = view.mode;

  const visible = useMemo(() => {
    const base = mode === "pending" ? pending : mine.filter((change) => change.taskId === activeTaskId);
    return filterChanges(base, view.filter);
  }, [mode, pending, mine, activeTaskId, view.filter]);

  const batch = useMemo(
    () => batchSummary(mode === "pending" ? pending : mine.filter((c) => c.taskId === activeTaskId)),
    [mode, pending, mine, activeTaskId],
  );

  const serverLabel = batch.server ?? (batch.files === 0 ? serverName : t("多台服务器"));

  const remember = useCallback(
    (patch: Partial<ChangeViewState>, persist = true) => {
      if (!viewKey) return;
      setChangeView(viewKey, patch, { persist });
    },
    [setChangeView, viewKey],
  );

  /* ---------------- 摘要水合：事件只覆盖"变化过"的那几条 ---------------- */

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void opsApi
      .aiAgentFileChanges(workspaceId, null)
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        mergeFileChanges(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, mergeFileChanges]);

  /* ---------------- 正文按需加载 ---------------- */

  const ensureDetail = useCallback(
    (changeId: string) => {
      if (details[changeId]) return;
      void opsApi
        .aiAgentFileChangeDetail(changeId)
        .then((detail) => {
          setDetails((current) => (current[changeId] ? current : { ...current, [changeId]: detail }));
        })
        .catch((cause: unknown) => {
          setLoadError(
            cause instanceof Error ? cause.message : t("变更内容加载失败（可能已超出保留范围）"),
          );
        });
    },
    [details, t],
  );

  /** 当前批次里的文件都载入正文：文件头要显示增删行数，点开也要能立刻看。 */
  useEffect(() => {
    for (const change of visible) {
      if (change.diffReady) ensureDetail(change.id);
    }
  }, [visible, ensureDetail]);

  // 换了对话 / 运行：旧对话的正文不能留在界面上。
  useEffect(() => {
    setDetails({});
    setLoadError(null);
    setPickerOpen(false);
    setActiveId(null);
  }, [workspaceId, activeTaskId, mode]);

  /* ---------------- 窄面板：文件树收成选择器 ---------------- */

  useEffect(() => {
    const element = rootRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // 正文优先：低于 520 就把树收起来（否则一列行号都放不下）。
      setNarrow(width > 0 && width < 520);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* ---------------- 选中文件 / 滚动同步 ---------------- */

  const selectedId =
    (focus?.changeId && visible.some((change) => change.id === focus.changeId)
      ? focus.changeId
      : undefined) ??
    (activeId && visible.some((change) => change.id === activeId) ? activeId : undefined) ??
    (view.changeId && visible.some((change) => change.id === view.changeId)
      ? view.changeId
      : undefined) ??
    visible[0]?.id ??
    null;
  const selectedChange = visible.find((change) => change.id === selectedId) ?? null;

  const scrollToChange = useCallback((changeId: string) => {
    const element = fileRefs.current.get(changeId);
    if (!element) return;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    setActiveId(changeId);
    setPickerOpen(false);
  }, []);

  /**
   * 从聊天点进来：定位到那个文件（等正文渲染完成再滚）。
   *
   * `appliedFocus` 按 nonce 去重：摘要 / 正文加载引起的重渲染不该反复滚动。
   */
  const appliedFocus = useRef<number | null>(null);
  useEffect(() => {
    if (!focus?.changeId || !focusTaskId) return;
    if (appliedFocus.current === focus.nonce) return;
    appliedFocus.current = focus.nonce;
    const timer = window.setTimeout(() => {
      scrollToChange(focus.changeId!);
      remember({ mode: "run", taskId: focusTaskId, changeId: focus.changeId });
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, focusTaskId]);

  /** 恢复上次的滚动位置（只在切换对话 / 批次时一次）。 */
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = view.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, mode, activeTaskId]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    // 正文滚动 → 文件树选中项跟着走（不反向触发滚动）。
    const top = element.getBoundingClientRect().top;
    let current: string | null = null;
    for (const change of visible) {
      const node = fileRefs.current.get(change.id);
      if (!node) continue;
      if (node.getBoundingClientRect().top - top <= 24) current = change.id;
      else break;
    }
    if (current) setActiveId(current);
    /*
     * 滚动位置只写内存，停下来 200ms 后才落盘：逐帧改 store 会让整棵 Diff
     * 重渲染，滚动会明显发涩。
     */
    if (scrollSave.current !== null) window.clearTimeout(scrollSave.current);
    scrollSave.current = window.setTimeout(() => {
      scrollSave.current = null;
      remember({ scrollTop: element.scrollTop, changeId: current ?? undefined }, false);
      flushChangeViews();
    }, 200);
  };

  useEffect(
    () => () => {
      if (scrollSave.current !== null) window.clearTimeout(scrollSave.current);
      flushChangeViews();
    },
    [flushChangeViews],
  );

  const tree = useMemo(() => buildChangeTree(visible), [visible]);

  if (!workspaceId) {
    return (
      <p className="px-3 py-2 text-11 text-fg-subtle">
        {t("还没有对话：文件变更按对话归属，先开始一条任务。")}
      </p>
    );
  }

  if (mine.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 空态也标明所属服务器：面板永远回答"这是哪台机器上的变更"。 */}
        <p className="px-3 py-1.5 text-11 text-fg-muted">
          {serverName || t("未关联服务器")}
          <span className="text-fg-subtle"> · {t("暂无变更")}</span>
        </p>
        <p className="px-3 py-1 text-11 text-fg-subtle">
          {t("这次对话还没有文件变更：AI 用 write_file 改文件时，这里会显示预览与实际差异。")}
        </p>
        <p className="px-3 text-10 text-fg-subtle">
          {t("普通 shell 命令（sed / tee / 脚本）拿不到明确目标与前后快照，不会生成 Diff。")}
        </p>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 顶部：待确认 / 本次运行 + 运行下拉 + 服务器与范围（始终可见）。 */}
      <div className="extreme-core-pane-tabs shrink-0 px-2">
        <PaneTabBar
          size="sm"
          ariaLabel={t("文件变更视图")}
          value={mode}
          onChange={(id) => {
            if (id === "pending") remember({ mode: "pending", changeId: undefined });
            else remember({ mode: "run", taskId: activeTaskId ?? undefined });
          }}
          tabs={[
            {
              id: "pending",
              label: t("待确认的变更"),
              badge:
                pending.length > 0 ? (
                  <span className="shrink-0 rounded-[4px] bg-surface-3 px-1 text-[10px] leading-4 text-fg-subtle">
                    {pending.length}
                  </span>
                ) : undefined,
            },
            { id: "run", label: t("本次运行") },
          ]}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 text-11">
        <span className="min-w-0 truncate text-fg-muted" title={serverName}>
          {serverLabel || t("未关联服务器")}
        </span>
        <span className="text-fg-subtle">·</span>
        <span className="text-fg-muted">
          {t("{{n}} 个文件", { n: batch.files })}
        </span>
        <span className="font-mono text-10 text-success">+{batch.additions}</span>
        <span className="font-mono text-10 text-danger">-{batch.deletions}</span>
        <StatusBadge tone={batchTone(batch.state)}>{batchStateLabel(batch.state, t)}</StatusBadge>
        <span className="flex-1" />
        {mode === "run" && runs.length > 0 && (
          <select
            aria-label={t("选择运行")}
            value={activeTaskId ?? ""}
            onChange={(event) => remember({ taskId: event.target.value, changeId: undefined })}
            className="h-6 max-w-[190px] min-w-0 shrink rounded-md border border-line/70 bg-surface-2 px-1 text-10 text-fg outline-none"
          >
            {runs.map((run) => (
              <option key={run.taskId} value={run.taskId}>
                {labelOfRun(run.taskId)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 px-3 pb-1.5">
        <input
          value={view.filter}
          onChange={(event) => remember({ filter: event.target.value })}
          placeholder={t("筛选文件…")}
          aria-label={t("按路径筛选文件")}
          className="h-6 min-w-0 flex-1 rounded-md border border-line/70 bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus-visible:border-accent/60"
        />
        {narrow && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
            title={t("选择文件")}
          >
            <FileText size={12} />
            <span className="max-w-[110px] truncate">
              {selectedChange ? fileLabel(selectedChange) : t("选择文件")}
            </span>
            {pickerOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </Button>
        )}
      </div>

      {pickerOpen && narrow && (
        <div className="mx-2 mb-1 max-h-[45%] overflow-y-auto rounded-md border border-line/70 bg-surface-1 p-1">
          <ChangeTree
            dir={tree}
            selectedId={selectedId}
            onSelect={(change) => {
              remember({ changeId: change.id });
              scrollToChange(change.id);
            }}
          />
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 border-t border-line/60">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden pb-4"
          data-testid="file-change-diff"
        >
          {visible.length === 0 ? (
            <p className="px-3 py-3 text-11 text-fg-subtle">
              {view.filter.trim()
                ? t("没有匹配「{{filter}}」的文件。", { filter: view.filter })
                : mode === "pending"
                  ? t("没有待确认的变更。")
                  : t("这次运行没有可展示的文件变更。")}
            </p>
          ) : (
            visible.map((change) => (
              <section
                key={change.id}
                ref={(node) => {
                  if (node) fileRefs.current.set(change.id, node);
                  else fileRefs.current.delete(change.id);
                }}
                data-change-id={change.id}
                className={cn(
                  "scroll-mt-1 border-b border-line/50",
                  selectedId === change.id && "bg-surface-2/40",
                )}
              >
                <FileChangeHeader
                  change={change}
                  detail={details[change.id]}
                  runLabel={mode === "pending" ? labelOfRun(change.taskId) : null}
                  onOpenRemote={() => onOpenRemotePath(change.path)}
                />
                <FileChangeBody
                  change={change}
                  detail={details[change.id]}
                  expanded={view.expanded}
                  onToggleGap={(key) =>
                    remember({
                      expanded: view.expanded.includes(key)
                        ? view.expanded.filter((item) => item !== key)
                        : [...view.expanded, key],
                    })
                  }
                />
              </section>
            ))
          )}
          {loadError && <p className="px-3 py-2 text-11 text-danger">{loadError}</p>}
          {!sessionId && (
            <p className="px-3 py-2 text-10 text-warning">
              {t("服务器未连接：这里展示的是历史快照，可以查看但不能执行。")}
            </p>
          )}
        </div>

        {!narrow && (
          <aside className="w-[196px] shrink-0 overflow-y-auto border-l border-line/60 px-1.5 py-1.5">
            <p className="px-1 pb-1 text-10 text-fg-subtle">{t("已更改的文件")}</p>
            <ChangeTree
              dir={tree}
              selectedId={selectedId}
              onSelect={(change) => {
                remember({ changeId: change.id });
                scrollToChange(change.id);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 文件头                                                              */
/* ------------------------------------------------------------------ */

function FileChangeHeader({
  change,
  detail,
  runLabel,
  onOpenRemote,
}: {
  change: FileChangeSummary;
  detail?: FileChangeDetail;
  /** 「待确认」视图里标明这条属于哪次运行。 */
  runLabel: string | null;
  onOpenRemote: () => void;
}) {
  const { t } = useTranslation();
  const additions = detail?.summary.additions ?? change.additions;
  const deletions = detail?.summary.deletions ?? change.deletions;
  const [copied, setCopied] = useState(false);
  const copy = (value: string) => {
    void copyTextWithFeedback(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="sticky top-0 z-10 border-b border-line/50 bg-surface-1/95 px-2.5 py-1.5 backdrop-blur">
      <div className="flex min-w-0 items-center gap-1.5">
        <FileDiff size={12} className="shrink-0 text-fg-subtle" />
        <button
          type="button"
          onClick={() => copy(change.path || change.tool)}
          title={t("复制路径")}
          className="min-w-0 flex-1 truncate text-left font-mono text-11 text-fg hover:underline"
        >
          {change.path || t("（无文件路径）")}
        </button>
        <span className="shrink-0 font-mono text-10 text-success">+{additions}</span>
        <span className="shrink-0 font-mono text-10 text-danger">-{deletions}</span>
        <StatusBadge tone={changeTone(change.status)}>
          {changeStatusLabel(change.status, t)}
        </StatusBadge>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px] text-10 text-fg-subtle">
        <span>{change.created ? t("新文件") : t("修改已有文件")}</span>
        <span>·</span>
        <span>{stageLabel(detail ?? { summary: change }, t)}</span>
        {runLabel && (
          <>
            <span>·</span>
            <span className="min-w-0 truncate" title={runLabel}>
              {runLabel}
            </span>
          </>
        )}
        {change.backupPath && (
          <>
            <span>·</span>
            {/* 备份路径只给可复制文本：没有验证过就不假装能打开。 */}
            <button
              type="button"
              onClick={() => copy(change.backupPath!)}
              className="inline-flex min-w-0 items-center gap-0.5 text-left hover:text-fg"
              title={t("复制备份路径")}
            >
              <span className="max-w-[220px] truncate font-mono">
                {backupVerified(change) ? t("已备份：{{path}}", { path: change.backupPath }) : t("计划备份：{{path}}", { path: change.backupPath })}
              </span>
              <Copy size={9} />
            </button>
          </>
        )}
        {copied && <span className="text-success">{t("已复制")}</span>}
        {canOpenInRemote(change) && (
          <button
            type="button"
            onClick={onOpenRemote}
            className="text-10 text-accent hover:underline"
          >
            {t("在远程文件中打开")}
          </button>
        )}
      </div>
      {change.note && (
        <p className="mt-0.5 break-words pl-[18px] text-10 text-fg-subtle">{change.note}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 正文                                                                */
/* ------------------------------------------------------------------ */

function FileChangeBody({
  change,
  detail,
  expanded,
  onToggleGap,
}: {
  change: FileChangeSummary;
  detail?: FileChangeDetail;
  expanded: string[];
  onToggleGap: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (!detail) {
    return (
      <p className="px-3 py-2 text-10 text-fg-subtle">
        {change.diffReady ? t("正在加载差异…") : t("没有逐行差异。")}
      </p>
    );
  }

  const limits = detail.limits.length > 0 ? (
    <ul className="space-y-0.5 px-3 py-1.5 text-10 text-fg-subtle">
      {detail.limits.map((item) => (
        <li key={item} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  ) : null;

  if (detail.diff.hunks.length === 0) {
    return (
      <>
        {limits}
        <p className="px-3 py-2 text-11 text-fg-subtle">
          {detail.diff.tooLarge
            ? t("文件过大：没有逐行比较，改动的规模见上方状态。")
            : detail.summary.status === "unchanged"
              ? t("写入完成，但回读内容与写入前完全一致：没有差异。")
              : detail.summary.stage === "none"
                ? t("这次操作没有采集到可比对的正文。")
                : t("没有差异。")}
        </p>
      </>
    );
  }

  const segments = diffSegments(change.id, detail.diff);

  return (
    <div className="py-1">
      {limits}
      {detail.redacted && (
        <p className="px-3 pb-1 text-10 text-warning">
          {t("敏感内容已脱敏：Diff 里的 *** 是真实值的替代，不是原文。")}
        </p>
      )}
      <div className="extreme-core-diff">
        {segments.map((segment) => {
          if (segment.kind === "hunk") {
            return <DiffHunkBlock key={segment.key} hunk={segment.hunk} />;
          }
          const open = expanded.includes(segment.key);
          const lines = open ? gapLines(detail.beforeText, segment) : [];
          return (
            <div key={segment.key}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggleGap(segment.key)}
                className="extreme-core-diff-gap"
              >
                {open ? t("收起未修改的 {{n}} 行", { n: segment.count }) : t("{{n}} 行未修改", { n: segment.count })}
              </button>
              {open &&
                lines.map(([number, text]) => (
                  <DiffRow
                    key={`${segment.key}:${number}`}
                    kind="context"
                    oldNo={number}
                    newNo={segment.newStart + (number - segment.oldStart)}
                    text={text}
                  />
                ))}
            </div>
          );
        })}
      </div>
      <p className="px-3 pt-1 text-10 text-fg-subtle">
        {t("共 {{add}} 行新增、{{del}} 行删除", {
          add: detail.diff.additions,
          del: detail.diff.deletions,
        })}
      </p>
    </div>
  );
}

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  const { t } = useTranslation();
  return (
    <div>
      <div className="extreme-core-diff-hunk" aria-label={t("改动段")}>
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((line, index) => (
        <DiffRow
          key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
          kind={line.kind === "add" ? "add" : line.kind === "del" ? "del" : "context"}
          oldNo={line.oldNo ?? null}
          newNo={line.newNo ?? null}
          text={line.text}
        />
      ))}
    </div>
  );
}

function DiffRow({
  kind,
  oldNo,
  newNo,
  text,
}: {
  kind: "context" | "add" | "del";
  oldNo: number | null | undefined;
  newNo: number | null | undefined;
  text: string;
}) {
  return (
    <div className="extreme-core-diff-row" data-kind={kind}>
      <span className="extreme-core-diff-no">{oldNo ?? ""}</span>
      <span className="extreme-core-diff-no">{newNo ?? ""}</span>
      <span className="extreme-core-diff-sign" aria-hidden="true">
        {kind === "add" ? "+" : kind === "del" ? "-" : ""}
      </span>
      {/* 原文可能含制表符：用 pre-wrap 保留，不重排成一行。 */}
      <span className="extreme-core-diff-text">{text === "" ? "\u00a0" : text}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 文件树                                                              */
/* ------------------------------------------------------------------ */

function ChangeTree({
  dir,
  selectedId,
  onSelect,
  depth = 0,
}: {
  dir: ChangeDir;
  selectedId: string | null;
  onSelect: (change: FileChangeSummary) => void;
  depth?: number;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const total = countInDir(dir);
  const key = dir.path || "/";
  const closed = collapsed.has(key);

  return (
    <div className="min-w-0">
      {depth > 0 && (
        <button
          type="button"
          aria-expanded={!closed}
          onClick={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })
          }
          className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-11 text-fg-muted hover:bg-surface-hover"
          title={dir.path}
        >
          {closed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
          <Folder size={11} className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate">{dir.name}</span>
          <span className="shrink-0 text-10 text-fg-subtle">{total}</span>
        </button>
      )}
      {!closed && (
        <div className={cn(depth > 0 && "ml-2 border-l border-line/40 pl-1")}>
          {dir.dirs.map((child) => (
            <ChangeTree
              key={child.path}
              dir={child}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
          {dir.files.map((change) => (
            <button
              key={change.id}
              type="button"
              onClick={() => onSelect(change)}
              data-selected={selectedId === change.id ? "true" : undefined}
              title={change.path}
              className={cn(
                "flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-11",
                selectedId === change.id
                  ? "bg-accent/12 text-fg"
                  : "text-fg-muted hover:bg-surface-hover",
              )}
            >
              <FileText size={11} className="shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate">{fileLabel(change)}</span>
              {change.diffReady && (
                <span className="shrink-0 font-mono text-10">
                  <span className="text-success">+{change.additions}</span>
                  <span className="text-danger"> -{change.deletions}</span>
                </span>
              )}
              {!change.diffReady && (
                <span className="shrink-0 text-10 text-fg-subtle">
                  {change.uncollected ? t("未采集") : t("无 Diff")}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


