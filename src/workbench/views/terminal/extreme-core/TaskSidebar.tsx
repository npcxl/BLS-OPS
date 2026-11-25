import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContextMenu, useContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { OutputStyle } from "./chat-context";
import { dayTime, previewSnippet } from "./format-time";
import { displayTitle, type ExtremeWorkspace } from "./workspace-history";

/** 左栏收起状态：跨会话记住，重进超能时保持上次的宽度。 */
const RAIL_COLLAPSED_KEY = "bls-ops.extreme-task-rail-collapsed.v1";
/** 「任务」分组的折叠状态：只收列表，不影响新建任务和后台运行。 */
const TASKS_COLLAPSED_KEY = "bls-ops.extreme-task-group-collapsed.v1";

/** 左栏底部三个管理入口。 */
export type RailPage = "settings" | "permissions" | "mcp";

const RAIL_PAGES: { id: RailPage; label: string; icon: typeof Settings }[] = [
  { id: "settings", label: "设置", icon: Settings },
  { id: "permissions", label: "权限", icon: ShieldCheck },
  { id: "mcp", label: "MCP", icon: Plug },
];

const ROW_STATUS = {
  waiting: { label: "待确认", className: "bg-warning" },
  running: {
    label: "运行中",
    className: "border border-accent/35 border-t-accent motion-safe:animate-spin",
  },
  failed: { label: "失败", className: "bg-danger" },
  unread: { label: "有新结果", className: "bg-accent" },
} as const;

function readRailCollapsed(): boolean {
  try {
    return localStorage.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeRailCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

function readTasksCollapsed(): boolean {
  try {
    return localStorage.getItem(TASKS_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeTasksCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(TASKS_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // 存不了就只在本次会话里生效。
  }
}

/** 收起时图标上显示的首字符（中文取第一个字，英文取首字母）。 */
function initialOf(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "·";
  return Array.from(trimmed)[0].toUpperCase();
}

/**
 * 侧栏里经常被省略号截断的文字（标题 / 服务器名）。
 *
 * 悬停预览统一走整行的预览卡（见 `previewOf`），不再给每段文字单独挂
 * Tooltip —— 两层提示会同时冒出来，互相盖住。
 */

/**
 * 左栏：**所有服务器**的对话列表。
 *
 * 每项两行：对话标题（用户改过就用名字，否则取第一条用户消息）+ 服务器名。
 * 服务器同名时补地址 / 账号，否则两台都叫「生产」的机器根本分不清。
 *
 * 右键菜单（复用项目统一组件）：重命名 / 删除对话。删除**不动任务** ——
 * 正在跑或等确认的对话先拦下，避免把用户回看进度的入口删掉。
 */
function TaskSidebarInner({
  entries,
  currentId,
  currentTitle,
  busy,
  onNew,
  onOpen,
  onRename,
  onDelete,
  blockedIds,
  runningIds,
  attentionById,
  unreadIds,
  outputStyle,
  onOutputStyleChange,
  hasContext,
  onClearCurrent,
  activePage,
  onOpenPage,
  onShowChat,
}: {
  entries: ExtremeWorkspace[];
  currentId: string | null;
  /** 当前对话的标题（由页面算好传进来）。 */
  currentTitle: string;
  busy: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  /** 这些对话里还有在跑 / 等确认的任务：不允许删除。 */
  blockedIds?: Set<string>;
  /** 这些对话里有任务正在推进：列表上点一个小状态点。 */
  runningIds?: Set<string>;
  /** 需要关注的状态：待确认 / 失败。只在有值时画标记。 */
  attentionById?: Record<string, "waiting" | "failed">;
  /** 后台对话有新结果：小圆点，点开即清。 */
  unreadIds?: Set<string>;
  /** 当前会话的输出偏好（从底栏移到了会话菜单）。 */
  outputStyle: OutputStyle;
  onOutputStyleChange: (style: OutputStyle) => void;
  /** 当前会话是否有可清空的内容。 */
  hasContext: boolean;
  onClearCurrent?: () => void;
  /** 主内容区当前打开的管理页；null = 聊天。 */
  activePage?: RailPage | null;
  onOpenPage?: (page: RailPage) => void;
  /** 正在管理页时点当前对话：回到聊天，不重新加载会话。 */
  onShowChat?: () => void;
}) {
  const { t } = useTranslation();
  const current = entries.find((entry) => entry.id === currentId);
  const [filter, setFilter] = useState<string>("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<ExtremeWorkspace | null>(null);
  const [clearing, setClearing] = useState(false);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(readRailCollapsed);
  const [tasksCollapsed, setTasksCollapsed] = useState(readTasksCollapsed);
  const inputRef = useRef<HTMLInputElement>(null);
  const menu = useContextMenu();

  /** 收/展左栏。收起时顺带把筛选放回「全部」，否则列表被一个看不见的条件限制着。 */
  const setRailCollapsed = (next: boolean) => {
    writeRailCollapsed(next);
    if (next) setFilter("all");
    setCollapsed(next);
  };

  /** 只折叠任务列表（不动左栏宽度，也不影响运行中的任务）。 */
  const setTasksFolded = (next: boolean) => {
    writeTasksCollapsed(next);
    setTasksCollapsed(next);
  };

  /**
   * 真正需要补地址的是「两台不同机器取了同一个名字」。
   *
   * 以前按**会话条目数**计数：同一台服务器开两条对话就算「重名」，于是那一台
   * 下面的每一条都拖上同一串 `· root@47.94.20…`（完全相同的噪音），而只有一条
   * 对话的服务器反倒不显示 —— 表现就是列表里"有的带地址有的不带"。
   * 现在按 `serverId` 去重后计数：只有同名的不同连接才需要地址消歧。
   */
  const duplicatedNames = useMemo(() => {
    const idsByName = new Map<string, Set<string>>();
    for (const entry of entries) {
      if (!entry.serverId) continue;
      const ids = idsByName.get(entry.server) ?? new Set<string>();
      ids.add(entry.serverId);
      idsByName.set(entry.server, ids);
    }
    return new Set(
      [...idsByName.entries()].filter(([, ids]) => ids.size > 1).map(([name]) => name),
    );
  }, [entries]);

  const options = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const key = entry.serverId ?? "unlinked";
      if (!seen.has(key)) seen.set(key, entry.server || t("未关联服务器"));
    }
    return [...seen.entries()];
  }, [entries, t]);
  // 选中的服务器没有对话了（对话被删 / 服务器断开）：回到「全部」，避免空列表。
  useEffect(() => {
    if (filter !== "all" && !options.some(([key]) => key === filter)) setFilter("all");
  }, [filter, options]);

  /*
   * 分组收起时只留当前对话：列表收起来，但"我在哪、怎么回去"还在；
   * 其余任务继续在后台跑，展开即恢复完整列表。
   */
  const visible = tasksCollapsed
    ? current
      ? [current]
      : []
    : filter === "all"
      ? entries
      : entries.filter((entry) => (entry.serverId ?? "unlinked") === filter);

  const subtitle = (entry: ExtremeWorkspace) => {
    if (!entry.serverId) return t("未关联服务器");
    return duplicatedNames.has(entry.server) && entry.host
      ? `${entry.server} · ${entry.host}`
      : entry.server;
  };

  const titleOf = (entry: ExtremeWorkspace) =>
    (entry.id === currentId ? currentTitle : displayTitle(entry)) || t("新任务");

  /**
   * 悬停预览卡（对齐豆包的会话列表）：标题 + 内容摘要 + 「今天 14:01」。
   *
   * 摘要取 `entry.messages` 的最后一条正文：当前对话的实时镜像可能比落库
   * 略新，但预览只需要"大概聊了什么"的新鲜度，不值得为它引入实时消息流。
   * 旧记录没有 updatedAt（=0）时不显示时间，不拿"现在"冒充。
   */
  const previewOf = (entry: ExtremeWorkspace, statusLabel?: string) => {
    const snippet = previewSnippet(entry.messages);
    const time = dayTime(entry.updatedAt, t);
    return (
      <span className="flex w-[248px] flex-col gap-1">
        <span className="break-words text-12 font-medium leading-4 text-fg">{titleOf(entry)}</span>
        {snippet && (
          <span className="line-clamp-4 break-words text-11 leading-4 text-fg-muted">{snippet}</span>
        )}
        <span className="text-10 leading-4 text-fg-subtle">
          {subtitle(entry)}
          {time ? ` · ${time}` : ""}
          {statusLabel ? ` · ${statusLabel}` : ""}
        </span>
      </span>
    );
  };

  const startRename = (entry: ExtremeWorkspace) => {
    setConfirming(null);
    // 收起状态放不下输入框：先展开再改名。
    setRailCollapsed(false);
    setEditing(entry.id);
    // 当前这条的标题以实时镜像为准（刚发的消息还没写回 entry）。
    setDraft(titleOf(entry));
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commitRename = () => {
    if (!editing) return;
    onRename(editing, draft.trim());
    setEditing(null);
  };

  const askDelete = (entry: ExtremeWorkspace) => {
    if (blockedIds?.has(entry.id)) {
      // 提示要看得见：收起时先展开，否则 48px 里塞不下一句完整的话。
      setRailCollapsed(false);
      setBlocked(entry.id);
      setConfirming(null);
      return;
    }
    setBlocked(null);
    setConfirming(entry);
  };

  /**
   * 会话菜单。
   *
   * 输出偏好与「清空」只对**当前会话**有意义（它们改的是当前镜像），所以
   * 只在这一行出现；删除与重命名对所有会话都可用。
   */
  const items = (entry: ExtremeWorkspace): ContextMenuItem[] => {
    const base: ContextMenuItem[] = [
      {
        id: "rename",
        label: t("重命名"),
        icon: Pencil,
        onSelect: () => startRename(entry),
      },
    ];
    if (entry.id === currentId) {
      base.push({
        id: "output",
        label: t("输出偏好"),
        icon: FileText,
        children: (
          [
            ["auto", t("自动")],
            ["brief", t("简洁结论")],
            ["detailed", t("详细说明")],
            ["structured", t("结构化结果")],
          ] as [OutputStyle, string][]
        ).map(([style, label]) => ({
          id: `output-${style}`,
          label,
          hint: outputStyle === style ? "✓" : undefined,
          onSelect: () => onOutputStyleChange(style),
        })),
      });
      if (hasContext && onClearCurrent) {
        base.push({
          id: "clear",
          label: t("清空对话与附件"),
          icon: X,
          onSelect: () => setClearing(true),
        });
      }
    }
    base.push({
      id: "delete",
      label: t("删除对话"),
      icon: Trash2,
      danger: true,
      onSelect: () => askDelete(entry),
    });
    return base;
  };

  return (
    <aside
      className="extreme-core-task-rail extreme-core-frosted flex shrink-0 flex-col overflow-hidden border-r border-line/70"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={t("任务")}
    >
      {collapsed ? (
        <div className="flex flex-col items-center gap-1 px-1.5 py-2">
          <Tooltip label={t("展开会话列表")} side="right" delay={140}>
            <button
              type="button"
              aria-label={t("展开会话列表")}
              onClick={() => setRailCollapsed(false)}
              className="grid size-6 place-items-center rounded-[6px] text-fg-subtle transition-colors duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ChevronRight size={13} />
            </button>
          </Tooltip>
          <Tooltip label={t("新建任务")} side="right" delay={140}>
            <button
              type="button"
              aria-label={t("新建任务")}
              disabled={busy}
              onClick={onNew}
              className="grid size-7 place-items-center rounded-[7px] text-fg-muted transition-colors duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </Tooltip>
        </div>
      ) : (
        <>
          {/* 顶部只放「新建任务」和整栏收起；任务列表的折叠在下面一行。 */}
          <div className="flex items-center gap-1 px-2 pb-1 pt-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={onNew}
              disabled={busy}
              className="min-w-0 flex-1 justify-start"
            >
              <Plus size={13} /> {t("新建任务")}
            </Button>
            <Tooltip label={t("收起侧栏")}>
              <button
                type="button"
                aria-label={t("收起侧栏")}
                onClick={() => setRailCollapsed(true)}
                className="grid size-5 shrink-0 place-items-center rounded-[4px] text-fg-subtle transition-colors duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
              >
                <ChevronLeft size={13} />
              </button>
            </Tooltip>
          </div>
          <div className="px-2 pb-1">
            <button
              type="button"
              onClick={() => setTasksFolded(!tasksCollapsed)}
              aria-expanded={!tasksCollapsed}
              aria-label={tasksCollapsed ? t("展开任务列表") : t("收起任务列表")}
              data-testid="task-group-toggle"
              className="flex w-full min-w-0 items-center gap-1 rounded-[5px] px-1 py-1 text-left text-fg-subtle transition-colors duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
            >
              <ChevronDown
                size={12}
                className={cn(
                  "shrink-0 transition-transform duration-[140ms] ease-out motion-reduce:transition-none",
                  tasksCollapsed && "-rotate-90",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg">
                {t("任务")}
              </span>
              <span className="shrink-0 text-10 tabular-nums text-fg-subtle">
                {entries.length}
              </span>
            </button>
          </div>
        </>
      )}

      {!collapsed && !tasksCollapsed && options.length > 1 && (
        <div className="px-3 pb-2">
          <Select
            variant="menu"
            ariaLabel={t("按服务器筛选")}
            testId="task-server-filter"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("全部服务器") },
              ...options.map(([key, name]) => ({ value: key, label: name })),
            ]}
          />
        </div>
      )}

      {!collapsed && tasksCollapsed && (
        <p className="px-3 pb-1.5 text-10 leading-4 text-fg-subtle">
          {entries.length > 1
            ? t("任务列表已收起，还有 {{n}} 个任务在后台", {
                n: entries.length - (current ? 1 : 0),
              })
            : t("任务列表已收起")}
        </p>
      )}

      {!collapsed && !tasksCollapsed && current && current.folders.length > 0 && (
        <ul className="max-h-24 overflow-auto border-b border-line/60 px-3 pb-2 text-11 text-fg-muted">
          {current.folders.map((folder) => (
            <li key={folder} title={folder} className="flex items-center gap-1.5 py-0.5">
              <FolderOpen size={12} className="shrink-0" />
              <span className="truncate">
                {/* 不用 `Array.prototype.at`：项目的 TS lib 没到 ES2022。 */}
                {(() => {
                  const parts = folder.split(/[\\/]/).filter(Boolean);
                  return parts[parts.length - 1] ?? folder;
                })()}
              </span>
            </li>
          ))}
        </ul>
      )}

      {confirming && (
        <ConfirmDialog
          open
          title={t("删除对话")}
          description={t("删除「{{title}}」？（{{server}}）", {
            title: titleOf(confirming),
            server: subtitle(confirming) || t("未关联服务器"),
          })}
          confirmLabel={t("删除")}
          cancelLabel={t("取消")}
          risk="irreversible"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const { id } = confirming;
            setConfirming(null);
            if (blockedIds?.has(id)) {
              setBlocked(id);
              return;
            }
            onDelete(id);
          }}
        />
      )}

      {clearing && (
        <ConfirmDialog
          open
          title={t("清空对话")}
          description={t(
            "清空「{{title}}」的消息与附件？服务器上的临时副本也会被清理，无法恢复。",
            { title: currentTitle },
          )}
          confirmLabel={t("清空")}
          cancelLabel={t("取消")}
          risk="irreversible"
          onCancel={() => setClearing(false)}
          onConfirm={() => {
            setClearing(false);
            onClearCurrent?.();
          }}
        />
      )}

      {blocked && (
        <p
          role="status"
          className="mx-2 mb-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-11 text-warning"
        >
          {t("这条对话里还有任务在运行或等确认：先处理它（或点停止），再删除对话。")}
        </p>
      )}

      <ul
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          // 收起时不留左右内边距：48px 减去滚动条后还要放得下 32px 图标。
          collapsed ? "flex flex-col items-center gap-0.5 py-1" : "px-1.5 py-1",
        )}
        role="listbox"
        aria-label={t("任务")}
      >
        {visible.map((entry) => {
          const active = entry.id === currentId;
          const title = titleOf(entry);
          const serverLabel = subtitle(entry);
          const attention = attentionById?.[entry.id];
          const status =
            attention === "waiting" ? "waiting" :
              runningIds?.has(entry.id) ? "running" :
                attention === "failed" ? "failed" :
                  unreadIds?.has(entry.id) ? "unread" : null;
          const indicator = status ? ROW_STATUS[status] : null;
          const statusLabel = indicator ? t(indicator.label) : undefined;
          const rowLabel = [title, serverLabel, statusLabel].filter(Boolean).join(" · ");
          const statusMark = indicator && (
            <span
              aria-hidden="true"
              data-task-status={status}
              className={cn(
                "block shrink-0 rounded-full",
                status === "running" ? "size-2.5" : "size-1.5",
                indicator.className,
              )}
            />
          );
          if (editing === entry.id) {
            return (
              <li key={entry.id} className="px-0.5 py-0.5">
                <input
                  ref={inputRef}
                  autoFocus
                  value={draft}
                  aria-label={t("对话名称")}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditing(null);
                    }
                  }}
                  onBlur={commitRename}
                  className="w-full rounded-md border border-line bg-surface-2 px-1.5 py-1 text-12 text-fg outline-none focus:border-accent"
                />
              </li>
            );
          }
          if (collapsed) {
            return (
              <li key={entry.id} className="flex justify-center">
                <Tooltip
                  side="right"
                  delay={400}
                  label={previewOf(entry, statusLabel)}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    aria-label={rowLabel}
                    onClick={() => {
                      // 点当前这条只是把焦点放回来：不重载，阅读位置保持原样；
                      // 如果正停在管理页，这一步负责切回聊天。
                      if (!active) onOpen(entry.id);
                      else onShowChat?.();
                    }}
                    onContextMenu={menu.onContextMenu(() => items(entry))}
                    className={cn(
                      "relative grid size-8 place-items-center rounded-[8px] text-12 font-medium transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
                      active
                        ? "bg-surface-active/65 text-fg"
                        : "text-fg-muted hover:bg-surface-hover hover:text-fg",
                    )}
                  >
                    <span aria-hidden="true">{initialOf(title)}</span>
                    {statusMark && (
                      <span className="absolute right-0.5 top-0.5 grid size-3 place-items-center">
                        {statusMark}
                      </span>
                    )}
                  </button>
                </Tooltip>
              </li>
            );
          }
          return (
            // 行与行之间留 4px 缝：悬停底色是圆角块，贴着排会连成一片，
            // 分不清悬停的是哪一条（收起态另有 gap，不用这段内边距）。
            <li key={entry.id} className={cn("group relative", !collapsed && "py-0.5")}>
              {/* 整行一张预览卡（豆包式）：标题/摘要/时间都在卡里，行内不再单独挂提示。 */}
              <Tooltip label={previewOf(entry, statusLabel)} side="right" delay={400}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                aria-label={rowLabel}
                onClick={() => {
                  // 点当前这条不改 store：刚滚到一半的位置不该被"重新打开"顶掉；
                  // 从管理页回来时只切视图。
                  if (!active) onOpen(entry.id);
                  else onShowChat?.();
                }}
                onContextMenu={menu.onContextMenu(() => items(entry))}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,1fr)_12px] items-center gap-2 rounded-[7px] py-1.5 pl-2.5 pr-7 text-left transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
                  active ? "bg-surface-active/65" : "hover:bg-surface-hover",
                )}
              >
                <span className="flex min-w-0 flex-col gap-1">
                  <span
                    className={cn("truncate text-12 leading-4", active ? "font-medium text-fg" : "text-fg-muted")}
                  >
                    {title}
                  </span>
                  {/* 第二行只留服务器名：标题 + 服务器 + 状态就是这一行的全部信息。 */}
                  <span className="flex min-w-0 items-center gap-1.5 text-11 leading-4 text-fg-subtle">
                    <span className="min-w-0 flex-1 truncate">{serverLabel}</span>
                  </span>
                </span>
                <span className="grid size-3 place-items-center">{statusMark}</span>
              </button>
              </Tooltip>
              {/* 悬停才出现：行内一直留着右侧留白，菜单按钮浮上去不会挤动文字。 */}
              <Tooltip label={t("会话操作")}>
                <button
                  type="button"
                  aria-label={t("会话操作")}
                  aria-haspopup="menu"
                  onClick={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    // 菜单右对齐到按钮、贴着下沿展开：和工具栏「⋯」一致。
                    menu.openAt(Math.max(8, rect.right - 184), rect.bottom + 4, items(entry));
                  }}
                  className="pointer-events-none absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-[4px] text-fg-subtle opacity-0 transition duration-[120ms] ease-out hover:bg-surface-hover hover:text-fg focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <MoreHorizontal size={13} />
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      {/*
       * 底部三个管理入口固定在最下方：任务列表单独滚动，入口永远可见。
       * 打开的是超能主内容区的页面，不离开当前对话。
       */}
      <nav
        className={cn(
          "shrink-0 border-t border-line/60",
          collapsed ? "flex flex-col items-center gap-1 px-1.5 py-2" : "space-y-0.5 p-1.5",
        )}
        aria-label={t("管理")}
      >
        {RAIL_PAGES.map(({ id, label, icon: Icon }) => {
          const active = activePage === id;
          const button = (
            <button
              key={id}
              type="button"
              data-testid={`rail-${id}`}
              aria-current={active ? "page" : undefined}
              aria-label={t(label)}
              onClick={() => onOpenPage?.(id)}
              className={cn(
                "transition-colors duration-[120ms] ease-out focus-visible:outline-2 focus-visible:outline-accent",
                collapsed
                  ? "grid size-7 place-items-center rounded-[7px]"
                  : "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-12",
                active
                  ? "bg-surface-active/65 text-fg"
                  : "text-fg-muted hover:bg-surface-hover hover:text-fg",
              )}
            >
              <Icon size={collapsed ? 14 : 13} className="shrink-0" />
              {!collapsed && <span className="min-w-0 flex-1 truncate">{t(label)}</span>}
            </button>
          );
          return collapsed ? (
            <Tooltip key={id} label={t(label)} side="right" delay={140}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </nav>

      <ContextMenu {...menu.props} title={t("对话")} />
    </aside>
  );
}

/** 侧栏只在"对话列表 / 当前标题"变化时才需要重渲染（流式回答不该带着它一起转）。 */
export const TaskSidebar = memo(TaskSidebarInner);
