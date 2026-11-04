/**
 * 工作项的一行 —— 顶部标签条、已打开的标签浮窗、右侧列表共用同一套图标、
 * 徽标和右键菜单。
 *
 * 三处显示同一份 `items`：图标、来源库、待提交/执行中/未保存这些标记必须一致，
 * 否则同一个标签在两个入口里看起来像两个不同的东西。
 */
import {
  Check,
  Columns3,
  Copy,
  Database as DatabaseIcon,
  Loader2,
  PanelRightClose,
  Pin,
  PinOff,
  SquareMinus,
  SquareTerminal,
  Table2,
  X,
  type IconComponent,
} from "@/components/icons";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import { copyTextWithFeedback as copyText } from "@/lib/clipboard-feedback";
import { cn } from "@/lib/cn";
import { i18n } from "@/i18n";
import type { WorkItem, WorkItemKind } from "@/stores/database-workspace-store";

const KIND_ICON: Record<WorkItemKind, IconComponent> = {
  table: Table2,
  structure: Columns3,
  query: SquareTerminal,
  objects: DatabaseIcon,
};

export function WorkItemKindIcon({
  item,
  active,
  size = 12,
}: {
  item: WorkItem;
  active: boolean;
  size?: number;
}) {
  const Icon = KIND_ICON[item.kind];
  return (
    <Icon
      size={size}
      className={cn("shrink-0", active ? "text-accent" : "text-fg-subtle")}
    />
  );
}

/** 与标签条保持同一套标记：固定 / 执行中 / 待提交 / 未保存。 */
export function WorkItemBadges({ item }: { item: WorkItem }) {
  return (
    <>
      {item.pinned && <Pin size={9} className="shrink-0 text-accent" />}
      {item.running && (
        <Loader2
          size={10}
          className="shrink-0 animate-spin text-accent"
          aria-label={i18n.t("执行中")}
        />
      )}
      {item.pendingCount > 0 && (
        <span className="shrink-0 rounded-[4px] bg-warning/20 px-1 text-[9px] leading-4 text-warning">
          {item.pendingCount}
        </span>
      )}
      {item.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
    </>
  );
}

/**
 * 列表行：单击切换标签；给了 `onClose` 才有行尾关闭按钮（右侧列表用，
 * 浮窗里点一下就是"切过去"，不需要再多一个按钮）。
 */
export function WorkItemRow({
  item,
  active,
  highlighted = false,
  onSelect,
  onClose,
  onContextMenu,
  showDatabase = true,
}: {
  item: WorkItem;
  active: boolean;
  /** 键盘光标所在行（浮窗里 ↑↓ 移动的那个），与"当前标签"是两件事。 */
  highlighted?: boolean;
  onSelect: () => void;
  onClose?: () => void;
  onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  showDatabase?: boolean;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      title={`${item.database ?? "—"} › ${item.objectName}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={cn(
        "page-tree-row group w-full cursor-default text-left text-12",
        active ? "text-fg" : "text-fg-muted hover:bg-surface-hover",
        // 当前标签已经有 accent 底色，别再被"键盘光标"的灰色盖掉。
        active ? "bg-accent/10" : highlighted && "bg-surface-hover",
      )}
    >
      <WorkItemKindIcon item={item} active={active} />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      {showDatabase && item.database && (
        <span className="max-w-[88px] shrink-0 truncate text-10 text-fg-subtle">
          {item.database}
        </span>
      )}
      <WorkItemBadges item={item} />
      {onClose ? (
        <button
          type="button"
          aria-label={i18n.t("关闭标签")}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-fg-subtle opacity-0 transition-colors hover:bg-surface-active hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={11} strokeWidth={2} />
        </button>
      ) : (
        active && <Check size={11} className="shrink-0 text-accent" />
      )}
    </div>
  );
}

/**
 * 标签的右键菜单。关闭动作一律回调给 `DatabaseView`：只有它知道运行中的查询、
 * 待提交修改和未提交事务该怎么收尾，这里不能直接调 `close()`。
 */
export function workItemMenuItems(
  item: WorkItem,
  actions: {
    close: (item: WorkItem) => void;
    closeOthers: (item: WorkItem) => void;
    closeRight: (item: WorkItem) => void;
    togglePin: (id: string) => void;
  },
): ContextMenuItem[] {
  const t = i18n.t.bind(i18n);
  return [
    {
      id: "close",
      label: t("关闭"),
      icon: X,
      hint: "Ctrl+W",
      onSelect: () => actions.close(item),
    },
    {
      id: "close-others",
      label: t("关闭其他"),
      icon: SquareMinus,
      onSelect: () => actions.closeOthers(item),
    },
    {
      id: "close-right",
      label: t("关闭右侧"),
      icon: PanelRightClose,
      onSelect: () => actions.closeRight(item),
    },
    { id: "sep-1", separator: true },
    {
      id: "pin",
      label: item.pinned ? t("取消固定") : t("固定到最左"),
      hint: item.pinned ? undefined : t("固定项不参与预览替换"),
      icon: item.pinned ? PinOff : Pin,
      onSelect: () => actions.togglePin(item.id),
    },
    {
      id: "copy",
      label: t("复制名称"),
      icon: Copy,
      disabled: item.kind === "query",
      onSelect: () => void copyText(item.objectName),
    },
  ];
}
