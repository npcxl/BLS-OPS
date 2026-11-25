import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileKindIcon } from "./FileKindIcon";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileDiff,
  FileText,
  Search,
  X,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui/status";
import { cn } from "@/lib/cn";
import { copyTextWithFeedback } from "@/lib/clipboard-feedback";
import type {
  DiffHunk,
  FileChangeDetail,
  FileChangeSummary,
  NetChangeSet,
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
  changeReasonLabel,
  changeStatusLabel,
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
  /** 详情（Diff 正文）加载失败：与"列表加载失败"分开，重试范围也不同。 */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 摘要列表加载失败：**不能吞掉**后显示"暂无变更"。 */
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 重试计数：变化时重新拉一次列表。 */
  const [reloadNonce, setReloadNonce] = useState(0);
  /** 一次性提示（比如"文件已不在服务器上"）：不打断阅读，可手动关掉。 */
  const [notice, setNotice] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 正文当前滚到哪个文件：文件树的选中项跟着它走（不写回 store 的高频路径）。 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const scrollSave = useRef<number | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  /** 这条对话的全部记录：切换对话时不混入别人的。 */
  const mine = useMemo(
    () =>
      Object.values(changesById)
        .filter((change) => change.workspaceId === workspaceId)
        .sort((a, b) => a.createdAt - b.createdAt || a.stepIndex - b.stepIndex),
    [changesById, workspaceId],
  );

  /** 按运行（taskId）分批：新的在前，界面用来做「上一轮 / 本次运行」下拉。 */
  const runs = useMemo(() => {
    const map = new Map<
      string,
      { taskId: string; changes: FileChangeSummary[]; at: number; additions: number; deletions: number }
    >();
    for (const change of mine) {
      const entry =
        map.get(change.taskId) ??
        { taskId: change.taskId, changes: [], at: 0, additions: 0, deletions: 0 };
      entry.changes.push(change);
      entry.at = Math.max(entry.at, change.updatedAt);
      entry.additions += change.additions;
      entry.deletions += change.deletions;
      map.set(change.taskId, entry);
    }
    return [...map.values()].sort((a, b) => b.at - a.at);
  }, [mine]);

  const pending = useMemo(() => mine.filter((change) => isPending(change.status)), [mine]);

  const labelOfRun = useCallback(
    (taskId: string) => {
      // 手动编辑不是一次"运行"：单独给个名字，别显示成"运行 editor"。
      if (taskId === "editor") return t("编辑器保存");
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

  /**
   * 本轮**净变化**：同一路径一条，比较首次操作前与最后一次验证后的版本。
   *
   * 后端把"算出来是空的"和"算不出来"分开返回（`available`）：前者显示
   * 「本轮无文件净变化」，后者才回落到逐条历史 —— 空数组不会再让原来的
   * 逐步记录重新冒出来。
   */
  const [netSet, setNetSet] = useState<{ taskId: string; set: NetChangeSet } | null>(null);
  useEffect(() => {
    if (!workspaceId || mode !== "run" || !activeTaskId) {
      setNetSet(null);
      return undefined;
    }
    let cancelled = false;
    void opsApi
      .aiAgentFileChangesNet(workspaceId, activeTaskId)
      .then((set) => {
        if (cancelled || !set || !Array.isArray(set.rows)) return;
        setNetSet({ taskId: activeTaskId, set });
      })
      .catch(() => {
        if (!cancelled) setNetSet(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, activeTaskId, mode, mine]);

  const netReady = Boolean(netSet && netSet.taskId === activeTaskId);
  const netAvailable = netReady && Boolean(netSet?.set.available);

  /**
   * 当前批次要渲染的行。
   *
   * - 有净变化数据：**只**渲染后端算出来的净变化，空就是空（不再回退）；
   * - 没有（重启后看历史）：回落逐条记录，但把"原样保存"的藏起来。
   */
  const runRows = useMemo(() => {
    if (netReady && netSet?.set.available) return netSet.set.rows;
    return mine.filter(
      (change) => change.taskId === activeTaskId && change.status !== "unchanged",
    );
  }, [netReady, netSet, activeTaskId, mine]);

  /** 被隐藏的「无净变化」文件数：空态和页脚要说明它们去哪了。 */
  const hiddenUnchanged = useMemo(() => {
    if (netAvailable) return netSet?.set.unchanged ?? 0;
    return mine.filter(
      (change) => change.taskId === activeTaskId && change.status === "unchanged",
    ).length;
  }, [netAvailable, netSet, activeTaskId, mine]);

  const visible = useMemo(() => {
    const base = mode === "pending" ? pending : runRows;
    return filterChanges(base, view.filter);
  }, [mode, pending, runRows, view.filter]);

  const batch = useMemo(
    () => batchSummary(mode === "pending" ? pending : runRows, mode === "run" && netAvailable),
    [mode, pending, runRows, netAvailable],
  );

  /** 「已确认发生净变化」的文件数；未确认 / 未采集的条目单独标出来。 */
  const confirmedFiles = mode === "pending" ? batch.files : batch.changed;
  const unconfirmedFiles = Math.max(0, batch.files - batch.changed);

  const serverLabel = batch.server ?? (batch.files === 0 ? serverName : t("多台服务器"));

  const remember = useCallback(
    (patch: Partial<ChangeViewState>, persist = true) => {
      if (!viewKey) return;
      setChangeView(viewKey, patch, { persist });
    },
    [setChangeView, viewKey],
  );

  /* ---------------- 摘要水合：事件只覆盖"变化过"的那几条 ---------------- */

  /** 历史回落用的任务 id：重启后内存为空时按它去任务历史里取那份脱敏记录。 */
  const historyTaskId = view.taskId ?? focus?.taskId ?? null;
  /** 旧请求的返回不能覆盖新对话：回来时比对一次归属。 */
  const contextRef = useRef(workspaceId);
  contextRef.current = workspaceId;

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    void (async () => {
      try {
        const list = await opsApi.aiAgentFileChanges(workspaceId, null);
        if (cancelled) return;
        if (Array.isArray(list) && list.length > 0) {
          mergeFileChanges(list);
          return;
        }
        /*
         * 内存里没有记录：多半是重启后打开历史任务 —— 按任务读回落库的那份。
         * 只回落到**当前选中的那次运行**，不做全表扫描。
         */
        if (!historyTaskId) return;
        const stored = await opsApi.aiAgentFileChanges(workspaceId, historyTaskId);
        if (cancelled) return;
        if (Array.isArray(stored) && stored.length > 0) {
          mergeFileChanges(stored);
          return;
        }
        /*
         * 还有一种"面板明明有记录却空白"：那批记录的 `workspaceId` 是空的
         * （旧版本 / 排队发送时归属没带上）。taskId 唯一对应一次运行，按它
         * 单独取回来再归到当前对话，既修好显示也不会串到别的对话。
         */
        const orphan = await opsApi.aiAgentFileChanges(null, historyTaskId);
        if (cancelled || !Array.isArray(orphan)) return;
        mergeFileChanges(
          orphan.map((item) => ({ ...item, workspaceId: item.workspaceId ?? workspaceId })),
        );
      } catch (cause) {
        if (cancelled) return;
        setListError(cause instanceof Error ? cause.message : t("变更列表加载失败"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, historyTaskId, reloadNonce, mergeFileChanges, t]);

  /* ---------------- 正文按需加载 ---------------- */

  /** 已取到的正文对应摘要的哪一版：实际 Diff 到达（updatedAt 变大）后必须重新拉。 */
  const detailStamps = useRef(new Map<string, number>());
  /** 正在飞的请求：effect 重跑时不能把同一条重复拉一遍。 */
  const detailInFlight = useRef(new Set<string>());

  /**
   * 取一条变更的正文。
   *
   * 缓存键是 `id + updatedAt`：确认后 actual Diff 会以新的 `updatedAt` 推过来，
   * 旧预览（proposed）不能继续留在详情里冒充实际结果。
   */
  const ensureDetail = useCallback(
    (change: FileChangeSummary) => {
      if (detailStamps.current.get(change.id) === change.updatedAt && details[change.id]) {
        return;
      }
      const key = `${change.id}:${change.updatedAt}`;
      if (detailInFlight.current.has(key)) return;
      detailInFlight.current.add(key);
      detailStamps.current.set(change.id, change.updatedAt);
      const owner = workspaceId;
      void opsApi
        .aiAgentFileChangeDetail(change.id)
        .then((detail) => {
          if (contextRef.current !== owner) return;
          setDetails((current) => ({ ...current, [change.id]: detail }));
          setLoadError(null);
        })
        .catch((cause: unknown) => {
          // 版本记回去：下次重新进来还能再试一次。
          detailStamps.current.delete(change.id);
          if (contextRef.current !== owner) return;
          setLoadError(
            cause instanceof Error ? cause.message : t("变更内容加载失败（可能已超出保留范围）"),
          );
        })
        .finally(() => {
          detailInFlight.current.delete(key);
        });
    },
    [details, t, workspaceId],
  );

  /** 当前批次里的文件都载入正文：文件头要显示增删行数，点开也要能立刻看。 */
  /*
   * 换了对话 / 运行：旧对话的正文不能留在界面上。
   *
   * 必须排在下面"载入正文"之前：挂载时这项先跑，缓存表是空的，正文只取一次；
   * 反过来会先把刚发出的请求的版本标记清掉，白白多拉一遍。
   */
  useEffect(() => {
    setDetails({});
    detailStamps.current.clear();
    setLoadError(null);
    setPickerOpen(false);
    setActiveId(null);
  }, [workspaceId, activeTaskId, mode]);

  useEffect(() => {
    for (const change of visible) {
      if (change.diffReady) ensureDetail(change);
    }
  }, [visible, ensureDetail]);

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

  /* 点外面关掉下拉：菜单与窄面板选择器共用一套。 */
  useEffect(() => {
    if (!menuOpen && !pickerOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen, pickerOpen]);

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
  const focusTimer = useRef<number | null>(null);
  /** 用户先动手切了视图 / 文件：还没落地的"聊天点进来"跳转就不再覆盖他。 */
  const cancelFocusJump = useCallback(() => {
    if (focusTimer.current === null) return;
    window.clearTimeout(focusTimer.current);
    focusTimer.current = null;
  }, []);
  useEffect(() => {
    if (!focus?.changeId || !focusTaskId) return;
    if (appliedFocus.current === focus.nonce) return;
    appliedFocus.current = focus.nonce;
    const timer = window.setTimeout(() => {
      focusTimer.current = null;
      scrollToChange(focus.changeId!);
      remember({ mode: "run", taskId: focusTaskId, changeId: focus.changeId });
    }, 60);
    focusTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (focusTimer.current === timer) focusTimer.current = null;
    };
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

  /** 复制整批差异：只在正文已加载的文件上拼接（不编造行）。 */
  const copyAll = () => {
    const text = visible
      .map((change) => {
        const detail = details[change.id];
        const head = `--- a${change.path}\n+++ b${change.path}\n`;
        if (!detail) return `${head}(${changeStatusLabel(change.status, t)})`;
        const body = detail.diff.hunks
          .map((hunk) =>
            hunk.lines
              .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
              .join("\n"),
          )
          .join("\n");
        return `${head}${body}`;
      })
      .join("\n\n");
    void copyTextWithFeedback(text);
  };

  const toggleGap = (key: string) =>
    remember({
      expanded: view.expanded.includes(key)
        ? view.expanded.filter((item) => item !== key)
        : [...view.expanded, key],
    });

  const selectChange = (change: FileChangeSummary) => {
    cancelFocusJump();
    remember({ changeId: change.id });
    scrollToChange(change.id);
  };

  /**
   * 「在远程文件中打开」前**重新确认**目标还在。
   *
   * 变更记录是历史的：文件可能已被删除或改名。确认不到时只提示一句，
   * 历史 Diff 与路径都保留 —— 那正是用户此时唯一能看的东西。
   */
  const openRemote = async (path: string) => {
    if (sessionId) {
      try {
        const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
        const probe = await opsApi.sshExec(
          sessionId,
          `test -e ${quoted} && echo yes || echo no`,
          8_000,
        );
        if (probe.stdout.trim() !== "yes") {
          setNotice(t("文件在服务器上已不存在：历史 Diff 与路径仍保留。"));
          return;
        }
      } catch {
        // 探测失败不阻断打开：让远程面板自己报错，比这里静默吞掉强。
      }
    }
    onOpenRemotePath(path);
  };

  if (!workspaceId) {
    return (
      <p className="px-3 py-2 text-11 text-fg-subtle">
        {t("还没有对话：文件变更按对话归属，先开始一条任务。")}
      </p>
    );
  }

  if (mine.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <FileDiff size={20} className="text-fg-subtle" />
        {loading ? (
          <p className="text-11 text-fg-subtle" role="status">
            {t("正在加载变更…")}
          </p>
        ) : listError ? (
          <>
            <p className="text-11 text-fg">
              {serverName || t("未关联服务器")}
              <span className="text-fg-subtle"> · {t("加载失败")}</span>
            </p>
            <p className="max-w-[320px] break-words text-11 text-danger">{listError}</p>
            <button
              type="button"
              className="rounded-md border border-line/70 px-2.5 py-1 text-11 text-fg transition-colors hover:bg-surface-hover"
              onClick={() => setReloadNonce((value) => value + 1)}
            >
              {t("重试")}
            </button>
          </>
        ) : (
          <>
            {/* 空态也标明所属服务器：面板永远回答"这是哪台机器上的变更"。 */}
            <p className="text-11 text-fg">
              {serverName || t("未关联服务器")}
              <span className="text-fg-subtle"> · {t("暂无变更")}</span>
            </p>
            <p className="max-w-[300px] text-11 text-fg-subtle">
              {t("这次对话还没有文件变更：AI 写入、编辑器保存或计划上传后，这里会显示预览与实际差异。")}
            </p>
            <p className="max-w-[300px] text-10 text-fg-subtle">
              {t("能确定目标、读得到前后内容的改动生成逐行 Diff；其余操作只标注路径。")}
            </p>
          </>
        )}
      </div>
    );
  }

  const chipLabel =
    mode === "pending"
      ? t("待确认的变更")
      : activeTaskId && runs[0] && activeTaskId !== runs[0].taskId
        ? t("上一轮")
        : t("本次运行");

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 顶栏：轮次胶囊（切换待确认 / 历史运行）+ 右侧动作。 */}
      <div ref={headerRef} className="relative flex h-9 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((open) => !open);
            setPickerOpen(false);
          }}
          className="flex h-7 max-w-[250px] min-w-0 items-center gap-1.5 rounded-full border border-line/70 bg-surface-2/70 pl-2.5 pr-2 text-11 text-fg transition-colors hover:bg-surface-3"
        >
          <span className="min-w-0 truncate">{chipLabel}</span>
          {mode === "pending" && pending.length > 0 && (
            <span className="shrink-0 rounded-full bg-surface-3 px-1 text-[10px] leading-4 text-fg-muted">
              {pending.length}
            </span>
          )}
          <ChevronDown
            size={11}
            className={cn(
              "shrink-0 text-fg-subtle transition-transform",
              menuOpen && "rotate-180",
            )}
          />
          {/* 只显示非零的增删：0 行不占位置，也不写成 +0 -0。 */}
          {batch.additions > 0 && (
            <span className="shrink-0 font-mono text-10 text-success">+{batch.additions}</span>
          )}
          {batch.deletions > 0 && (
            <span className="shrink-0 font-mono text-10 text-danger">-{batch.deletions}</span>
          )}
        </button>

        {narrow && (
          <button
            type="button"
            aria-expanded={pickerOpen}
            onClick={() => {
              setPickerOpen((open) => !open);
              setMenuOpen(false);
            }}
            className="flex h-7 max-w-[170px] min-w-0 items-center gap-1.5 rounded-full border border-line/70 bg-surface-2/70 px-2 text-11 text-fg-muted transition-colors hover:bg-surface-3"
            title={t("选择文件")}
          >
            {selectedChange ? (
              <FileKindIcon name={fileLabel(selectedChange)} size={12} />
            ) : (
              <FileText size={11} className="shrink-0 text-fg-subtle" />
            )}
            <span className="min-w-0 truncate">
              {selectedChange ? fileLabel(selectedChange) : t("选择文件")}
            </span>
            <ChevronDown size={10} className="shrink-0" />
          </button>
        )}

        <span className="flex-1" />

        <IconAction title={t("复制差异")} onClick={copyAll}>
          <Copy size={13} />
        </IconAction>
        {selectedChange && canOpenInRemote(selectedChange) && (
          <IconAction
            title={t("在远程文件中打开")}
            onClick={() => onOpenRemotePath(selectedChange.path)}
          >
            <ExternalLink size={13} />
          </IconAction>
        )}

        {menuOpen && (
          <div
            role="menu"
            className="absolute left-2 top-[calc(100%-2px)] z-30 w-[288px] overflow-hidden rounded-lg border border-line/70 bg-surface-1 py-1 shadow-xl"
          >
            <MenuRow
              selected={mode === "pending"}
              onClick={() => {
                cancelFocusJump();
                remember({ mode: "pending", changeId: undefined });
                setMenuOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 truncate">{t("待确认的变更")}</span>
              {pending.length > 0 && (
                <span className="shrink-0 rounded-full bg-surface-3 px-1 text-10 leading-4 text-fg-muted">
                  {pending.length}
                </span>
              )}
            </MenuRow>
            <div className="my-1 h-px bg-line/60" />
            <p className="px-2.5 pb-0.5 pt-1 text-10 text-fg-subtle">{t("更改所在运行")}</p>
            {runs.map((run) => {
              const active = mode === "run" && run.taskId === activeTaskId;
              // 当前这一轮用净变化统计（和面板主体同一把尺子），历史轮次沿用记录累计。
              const adds = active && netAvailable ? batch.additions : run.additions;
              const dels = active && netAvailable ? batch.deletions : run.deletions;
              return (
                <MenuRow
                  key={run.taskId}
                  selected={active}
                  onClick={() => {
                    cancelFocusJump();
                    remember({ mode: "run", taskId: run.taskId, changeId: undefined });
                    setMenuOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate" title={labelOfRun(run.taskId)}>
                    {labelOfRun(run.taskId)}
                  </span>
                  {adds > 0 && (
                    <span className="shrink-0 font-mono text-10 text-success">+{adds}</span>
                  )}
                  {dels > 0 && (
                    <span className="shrink-0 font-mono text-10 text-danger">-{dels}</span>
                  )}
                </MenuRow>
              );
            })}
          </div>
        )}

        {pickerOpen && narrow && (
          <div className="absolute left-2 top-[calc(100%-2px)] z-30 flex max-h-[60vh] w-[268px] flex-col overflow-hidden rounded-lg border border-line/70 bg-surface-1 shadow-xl">
            <FilterBox
              value={view.filter}
              onChange={(value) => remember({ filter: value })}
              placeholder={t("筛选文件…")}
              label={t("按路径筛选文件")}
              clearLabel={t("清除筛选")}
            />
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              <ChangeTree dir={tree} selectedId={selectedId} onSelect={selectChange} />
            </div>
          </div>
        )}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 border-t border-line/50">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pb-6"
          data-testid="file-change-diff"
        >
          {visible.length === 0 ? (
            view.filter.trim() ? (
              <p className="px-3 py-4 text-11 text-fg-subtle">
                {t("没有匹配「{{filter}}」的文件。", { filter: view.filter })}
              </p>
            ) : mode === "pending" ? (
              <p className="px-3 py-4 text-11 text-fg-subtle">{t("没有待确认的变更。")}</p>
            ) : netAvailable ? (
              /*
               * 净变化成功但为空：**不能**回落到逐条记录。这里明确说"本轮没变"，
               * 并交代被隐藏的那些文件去哪了（要核对过程就看步骤历史）。
               */
              <div className="px-3 py-4">
                <p className="text-11 text-fg">{t("本轮无文件净变化")}</p>
                <p className="mt-1 max-w-[320px] text-10 leading-4 text-fg-subtle">
                  {hiddenUnchanged > 0
                    ? t(
                        "另有 {{n}} 个文件原样保存或改回原样，已从列表隐藏；需要核对过程请在步骤历史里查看。",
                        { n: hiddenUnchanged },
                      )
                    : t("这次运行没有产生可确认的文件变化。")}
                </p>
              </div>
            ) : (
              <p className="px-3 py-4 text-11 text-fg-subtle">
                {t("这次运行没有可展示的文件变更。")}
              </p>
            )
          ) : (
            visible.map((change) => (
              <section
                key={change.id}
                ref={(node) => {
                  if (node) fileRefs.current.set(change.id, node);
                  else fileRefs.current.delete(change.id);
                }}
                data-change-id={change.id}
                className="border-b border-line/40 last:border-b-0"
              >
                <FileChangeHeader
                  change={change}
                  detail={details[change.id]}
                  runLabel={mode === "pending" ? labelOfRun(change.taskId) : null}
                  onOpenRemote={() => void openRemote(change.path)}
                />
                <FileChangeBody
                  change={change}
                  detail={details[change.id]}
                  expanded={view.expanded}
                  onToggleGap={toggleGap}
                />
              </section>
            ))
          )}
          {notice && (
            <div className="mx-2 mb-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-11 text-warning">
              <span className="min-w-0 flex-1">{notice}</span>
              <button
                type="button"
                className="shrink-0 underline underline-offset-2"
                onClick={() => setNotice(null)}
              >
                {t("知道了")}
              </button>
            </div>
          )}
          {loadError && (
            <div className="flex items-start gap-2 px-3 py-2 text-11 text-danger">
              <span className="min-w-0 break-words">{loadError}</span>
              <button
                type="button"
                className="shrink-0 underline underline-offset-2 hover:text-fg"
                onClick={() => {
                  setDetails({});
                  detailStamps.current.clear();
                  setLoadError(null);
                }}
              >
                {t("重试")}
              </button>
            </div>
          )}
        </div>

        {!narrow && (
          <aside className="flex w-[212px] shrink-0 flex-col border-l border-line/50 bg-surface-1/40">
            <div className="p-2 pb-1">
              <FilterBox
                value={view.filter}
                onChange={(value) => remember({ filter: value })}
                placeholder={t("筛选文件…")}
                label={t("按路径筛选文件")}
                clearLabel={t("清除筛选")}
              />
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-0.5">
              <span className="text-10 text-fg-muted">{t("已更改的文件")}</span>
              {/* 未确认 / 未采集的条目照常列出，但不计入已确认变更。 */}
              <span className="text-10 text-fg-subtle">{confirmedFiles}</span>
              {unconfirmedFiles > 0 && (
                <span className="shrink-0 text-10 text-warning">
                  {t("{{n}} 条未确认", { n: unconfirmedFiles })}
                </span>
              )}
              <span className="flex-1" />
              <span className="size-1.5 rounded-full bg-accent" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
              <ChangeTree dir={tree} selectedId={selectedId} onSelect={selectChange} />
            </div>
          </aside>
        )}
      </div>

      {/* 底栏：始终标明服务器、范围与结论。 */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 overflow-hidden border-t border-line/50 px-2 text-10 text-fg-subtle">
        <span className="min-w-0 truncate" title={serverLabel}>
          {serverLabel || t("未关联服务器")}
        </span>
        <span>·</span>
        <span className="shrink-0">{t("{{n}} 个文件", { n: confirmedFiles })}</span>
        {hiddenUnchanged > 0 && mode === "run" && (
          <span className="shrink-0">· {t("{{n}} 个无净变化", { n: hiddenUnchanged })}</span>
        )}
        <StatusBadge tone={batchTone(batch.state)}>{batchStateLabel(batch.state, t)}</StatusBadge>
        <span className="flex-1" />
        {!sessionId && (
          <span className="shrink-0 text-warning">{t("服务器未连接：只展示历史快照")}</span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 顶栏零件                                                            */
/* ------------------------------------------------------------------ */

function IconAction({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
    >
      {children}
    </button>
  );
}

function MenuRow({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-11 transition-colors",
        selected ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-hover",
      )}
    >
      {children}
      {selected && <Check size={11} className="shrink-0 text-accent" />}
    </button>
  );
}

function FilterBox({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  clearLabel: string;
}) {
  return (
    <label className="flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-line/70 bg-surface-2/60 px-2.5 transition-colors focus-within:border-accent/50">
      <Search size={11} className="shrink-0 text-fg-subtle" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-11 text-fg outline-none placeholder:text-fg-subtle"
      />
      {value && (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={() => onChange("")}
          className="shrink-0 text-fg-subtle hover:text-fg"
        >
          <X size={10} />
        </button>
      )}
    </label>
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
  onOpenBackup,
}: {
  change: FileChangeSummary;
  detail?: FileChangeDetail;
  /** 「待确认」视图里标明这条属于哪次运行。 */
  runLabel: string | null;
  onOpenRemote: () => void;
  /** 已验证存在的备份才给入口（打开的是服务器上的备份文件）。 */
  onOpenBackup?: () => void;
}) {
  const { t } = useTranslation();
  const additions = detail?.summary.additions ?? change.additions;
  const deletions = detail?.summary.deletions ?? change.deletions;
  const reason = detail?.summary.reason ?? change.reason ?? null;
  /** 只有真的能画 `+N / -N` 时才占位置；0 行改成一句状态文字。 */
  const hasCounts = additions > 0 || deletions > 0;
  const [copied, setCopied] = useState(false);
  const copy = (value: string) => {
    void copyTextWithFeedback(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const slash = change.path.lastIndexOf("/");
  const dir = slash > 0 ? change.path.slice(0, slash) : "";
  const name = slash >= 0 ? change.path.slice(slash + 1) : change.path;
  const stage = stageLabel(detail ?? { summary: change }, t);
  // 正常写入 / 删除不额外占用位置：只有"不合预期"的状态才需要在这里点明。
  const abnormal =
    change.status !== "written" && change.status !== "deleted" && change.status !== "proposed"
      ? changeStatusLabel(change.status, t)
      : null;

  return (
    <div className="sticky top-0 z-10 border-b border-line/50 bg-surface-1/95 backdrop-blur">
      <div className="flex h-8 min-w-0 items-center gap-1.5 px-2">
        <FileDiff size={12} className="shrink-0 text-fg-subtle" />
        <span
          className="flex min-w-0 items-baseline font-mono text-11 text-fg"
          title={change.path || change.tool}
        >
          {dir && (
            <>
              <span className="min-w-0 truncate text-fg-subtle">{dir}</span>
              <span className="shrink-0 text-fg-subtle">/</span>
            </>
          )}
          <span className="shrink-0">{name || t("（无文件路径）")}</span>
        </span>
        {additions > 0 && (
          <span className="shrink-0 font-mono text-10 text-success">+{additions}</span>
        )}
        {deletions > 0 && (
          <span className="shrink-0 font-mono text-10 text-danger">-{deletions}</span>
        )}
        <span
          className={cn(
            "shrink-0 rounded border px-1 text-[10px] leading-4",
            change.status === "proposed"
              ? "border-accent/40 bg-accent/8 text-accent"
              : "border-line/60 text-fg-subtle",
          )}
        >
          {stage}
        </span>
        {hasCounts ? (
          abnormal && <span className="shrink-0 text-10 text-fg-subtle">{abnormal}</span>
        ) : (
          <span
            className="min-w-0 truncate text-10 text-fg-subtle"
            title={reason ?? changeReasonLabel(change, t)}
          >
            {reason ?? changeReasonLabel(change, t)}
          </span>
        )}
        <span className="flex-1" />
        {runLabel && (
          <span className="max-w-[96px] min-w-0 shrink truncate text-10 text-fg-subtle" title={runLabel}>
            {runLabel}
          </span>
        )}
        {copied && <span className="shrink-0 text-10 text-success">{t("已复制")}</span>}
        {canOpenInRemote(change) && (
          <button
            type="button"
            onClick={onOpenRemote}
            aria-label={t("在远程文件中打开")}
            title={t("在远程文件中打开")}
            className="flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <ExternalLink size={11} />
          </button>
        )}
        <button
          type="button"
          onClick={() => copy(change.path || change.tool)}
          aria-label={t("复制路径")}
          title={t("复制路径")}
          className="flex size-6 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
        >
          <Copy size={11} />
        </button>
      </div>
      {(change.backupPath || change.note) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pb-1 pl-[22px] text-10 text-fg-subtle">
          {change.backupPath && (
            /*
             * 备份路径可复制；只有 `backup_verified`（服务器上真的 `cp` 成功并
             * 打印了标记）才给"打开备份"入口 —— 计划中的路径不假装存在。
             */
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => copy(change.backupPath!)}
                className="inline-flex min-w-0 items-center gap-0.5 text-left hover:text-fg"
                title={t("复制备份路径")}
              >
                <span className="max-w-[260px] truncate font-mono">
                  {backupVerified(change)
                    ? t("已备份：{{path}}", { path: change.backupPath })
                    : t("计划备份：{{path}}", { path: change.backupPath })}
                </span>
                <Copy size={9} className="shrink-0" />
              </button>
              {onOpenBackup && (
                <button
                  type="button"
                  onClick={onOpenBackup}
                  aria-label={t("打开备份文件")}
                  title={t("打开备份文件")}
                  className="flex size-4 shrink-0 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg"
                >
                  <ExternalLink size={9} />
                </button>
              )}
            </span>
          )}
          {change.note && <span className="min-w-0 break-words">{change.note}</span>}
        </div>
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

  const limits = detail.limits.length > 0 && (
    <ul className="mx-2 mb-1.5 space-y-0.5 rounded-md bg-surface-2/50 px-2 py-1 text-10 text-fg-subtle">
      {detail.limits.map((item) => (
        <li key={item} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );

  if (detail.diff.hunks.length === 0) {
    // 零行变化（新增 / 删除空文件、二进制、脱敏后看不出差异）：正文直接写原因。
    const reason = detail.summary.reason ?? change.reason ?? null;
    return (
      <div className="py-1">
        {limits}
        <p className="px-3 py-1.5 text-11 text-fg-subtle">
          {reason
            ? t(reason)
            : detail.diff.tooLarge
              ? t("文件过大：没有逐行比较，改动的规模见上方状态。")
              : detail.summary.status === "unchanged"
                ? t("写入完成，但回读内容与写入前完全一致：没有差异。")
                : detail.summary.stage === "none"
                  ? t("这次操作没有采集到可比对的正文。")
                  : t("没有差异。")}
        </p>
      </div>
    );
  }

  const segments = diffSegments(change.id, detail.diff);

  return (
    <div className="py-1.5">
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
                {open
                  ? t("收起未修改的 {{n}} 行", { n: segment.count })
                  : t("{{n}} 行未修改", { n: segment.count })}
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
    </div>
  );
}

function DiffHunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
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
      <span className="extreme-core-diff-no" aria-hidden="true">
        {oldNo ?? ""}
      </span>
      <span className="extreme-core-diff-no" aria-hidden="true">
        {newNo ?? ""}
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
          className="flex h-6 w-full min-w-0 items-center gap-1 rounded px-1 text-left text-11 text-fg-muted transition-colors hover:bg-surface-hover"
          title={dir.path}
        >
          {closed ? (
            <ChevronRight size={10} className="shrink-0 text-fg-subtle" />
          ) : (
            <ChevronDown size={10} className="shrink-0 text-fg-subtle" />
          )}
          <span className="min-w-0 flex-1 truncate">{dir.name}</span>
          <span className="shrink-0 text-10 text-fg-subtle">{countInDir(dir)}</span>
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
          {dir.files.map((change) => {
            const selected = selectedId === change.id;
            return (
              <button
                key={change.id}
                type="button"
                onClick={() => onSelect(change)}
                data-selected={selected ? "true" : undefined}
                title={change.path}
                className={cn(
                  "flex h-6 w-full min-w-0 items-center gap-1 rounded-md border px-1 text-left text-11 transition-colors",
                  selected
                    ? "border-accent/45 bg-accent/8 text-fg"
                    : "border-transparent text-fg-muted hover:bg-surface-hover hover:text-fg",
                )}
              >
                {/* 变更树按文件类型给图：nginx.conf / Dockerfile / .log 一眼分得清。 */}
                <FileKindIcon name={fileLabel(change)} size={12} />
                <span className="min-w-0 flex-1 truncate">{fileLabel(change)}</span>
                {change.additions > 0 || change.deletions > 0 ? (
                  <span className="shrink-0 font-mono text-10">
                    {change.additions > 0 && (
                      <span className="text-success">+{change.additions}</span>
                    )}
                    {change.additions > 0 && change.deletions > 0 && " "}
                    {change.deletions > 0 && (
                      <span className="text-danger">-{change.deletions}</span>
                    )}
                  </span>
                ) : (
                  <span
                    className="max-w-[92px] shrink-0 truncate text-10 text-fg-subtle"
                    title={changeReasonLabel(change, t)}
                  >
                    {changeReasonLabel(change, t)}
                  </span>
                )}
                {selected && <span className="mr-0.5 size-1.5 shrink-0 rounded-full bg-accent" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
