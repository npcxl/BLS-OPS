/**
 * 键数据主区：列表 / 分隔符树两种视图 + 虚拟滚动 + 多选。
 *
 * 对齐 Navicat 键数据编辑器的读法：
 * - 表头固定 `键 / 类型 / TTL`，行高紧凑（20px），整行选中；
 * - 树视图按**键名分隔符**分组（默认 `:`，与参考图 `bls → auth → refresh` 一致），
 *   这是"键命名空间树"，不是第二棵数据库连接树；
 * - 虚拟滚动只渲染可视区，10 万行也不会卡；列表/树切换在表头右端。
 *
 * 参考图里的 `值` / `大小` 两列没有复刻：它们要对每个可见键执行 GET 与
 * MEMORY USAGE，既越过后端边界也违反"禁止对所有键执行 MEMORY USAGE"。
 * 大小只在详情面板按需取（`key_info.memory_bytes`）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Loader2 } from "@/components/icons";
import type { RedisKeyBrief } from "@/api/types/database";
import { cn } from "@/lib/cn";
import { formatTtl, kindBadgeClass } from "./redis-shared";

const ROW_HEIGHT = 20;
const OVERSCAN = 12;

export type RedisGridView = "list" | "tree";

/** 树视图的一行：分组或叶子键。 */
interface GridRow {
  id: string;
  depth: number;
  label: string;
  kind: string;
  ttlMs: number;
  /** 叶子行才有键名；分组行是 undefined。 */
  key?: string;
  childCount: number;
  expanded: boolean;
}

function splitKey(key: string, separator: string): string[] {
  if (!separator) return [key];
  return key.split(separator);
}

/**
 * 把键列表按分隔符折叠成树。分组只由**已加载**的键构成，不额外发请求。
 */
function buildRows(
  keys: RedisKeyBrief[],
  view: RedisGridView,
  expandedGroups: Set<string>,
  separator: string,
): GridRow[] {
  if (view === "list") {
    return keys.map((entry) => ({
      id: entry.key,
      depth: 0,
      label: entry.key,
      kind: entry.kind,
      ttlMs: entry.ttl_ms,
      key: entry.key,
      childCount: 0,
      expanded: false,
    }));
  }

  interface Node {
    children: Map<string, Node>;
    keys: RedisKeyBrief[];
  }
  const root: Node = { children: new Map(), keys: [] };
  for (const entry of keys) {
    const parts = splitKey(entry.key, separator).filter((part) => part.length > 0);
    if (parts.length <= 1) {
      root.keys.push(entry);
      continue;
    }
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), keys: [] };
        node.children.set(part, child);
      }
      node = child;
    }
    node.keys.push(entry);
  }

  const rows: GridRow[] = [];
  const walk = (node: Node, depth: number, pathPrefix: string) => {
    for (const entry of node.keys) {
      rows.push({
        id: entry.key,
        depth,
        label: entry.key,
        kind: entry.kind,
        ttlMs: entry.ttl_ms,
        key: entry.key,
        childCount: 0,
        expanded: false,
      });
    }
    const names = [...node.children.keys()].sort();
    for (const name of names) {
      const child = node.children.get(name)!;
      const path = pathPrefix ? `${pathPrefix}${separator}${name}` : name;
      const count = countLeaves(child);
      const expanded = expandedGroups.has(path);
      rows.push({
        id: `group:${path}`,
        depth,
        label: name,
        kind: "group",
        ttlMs: -1,
        childCount: count,
        expanded,
      });
      if (expanded) walk(child, depth + 1, path);
    }
  };
  walk(root, 0, "");
  return rows;
}

function countLeaves(node: { children: Map<string, unknown>; keys: unknown[] }): number {
  let total = node.keys.length;
  for (const child of node.children.values()) {
    total += countLeaves(child as { children: Map<string, unknown>; keys: unknown[] });
  }
  return total;
}

export function RedisKeyGrid({
  keys,
  selected,
  activeKey,
  scanning,
  hasMore,
  capped,
  view,
  onViewChange,
  onRowClick,
  onRowOpen,
  onRowContextMenu,
  onLoadMore,
}: {
  keys: RedisKeyBrief[];
  selected: Set<string>;
  activeKey: string | null;
  scanning: boolean;
  hasMore: boolean;
  capped: boolean;
  view: RedisGridView;
  onViewChange: (view: RedisGridView) => void;
  onRowClick: (key: string, index: number, mods: { ctrl: boolean; shift: boolean }) => void;
  onRowOpen: (key: string) => void;
  onRowContextMenu: (event: React.MouseEvent, key: string) => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(
    () => buildRows(keys, view, expandedGroups, ":"),
    [keys, view, expandedGroups],
  );

  const toggleGroup = useCallback((path: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      setScrollTop(event.currentTarget.scrollTop);
      const target = event.currentTarget;
      if (
        hasMore &&
        !scanning &&
        target.scrollHeight - target.scrollTop - target.clientHeight < ROW_HEIGHT * 20
      ) {
        onLoadMore();
      }
    },
    [hasMore, scanning, onLoadMore],
  );

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = rows.slice(start, start + visibleCount);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line bg-surface-2/60 px-2 text-10 font-medium text-fg-subtle">
        <span className="min-w-0 flex-1">{t("键")}</span>
        <span className="w-16 shrink-0">{t("类型")}</span>
        <span className="w-14 shrink-0 text-right">{t("TTL")}</span>
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={t("列表视图")}
            aria-pressed={view === "list"}
            className={cn(
              "rounded px-1 text-10",
              view === "list" ? "bg-accent/15 text-accent" : "text-fg-subtle hover:bg-surface-hover",
            )}
            onClick={() => onViewChange("list")}
          >
            {t("列表")}
          </button>
          <button
            type="button"
            aria-label={t("树视图")}
            aria-pressed={view === "tree"}
            className={cn(
              "rounded px-1 text-10",
              view === "tree" ? "bg-accent/15 text-accent" : "text-fg-subtle hover:bg-surface-hover",
            )}
            onClick={() => onViewChange("tree")}
          >
            {t("树")}
          </button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onScroll={onScroll}
        role="grid"
        tabIndex={0}
        aria-rowcount={rows.length}
        aria-label={t("键列表")}
      >
        {rows.length === 0 && !scanning && (
          <p className="px-3 py-6 text-11 leading-relaxed text-fg-subtle">
            {t("没有匹配的键。调整模式后回车重新扫描。")}
          </p>
        )}
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {slice.map((row, offset) => {
            const index = start + offset;
            const isGroup = row.key === undefined;
            const isSelected = row.key !== undefined && selected.has(row.key);
            return (
              <div
                key={row.id}
                role="row"
                aria-selected={isSelected}
                aria-expanded={isGroup ? row.expanded : undefined}
                className={cn(
                  "absolute left-0 right-0 flex cursor-default items-center gap-2 pr-2 text-11",
                  isSelected
                    ? "bg-accent/20 text-fg"
                    : "text-fg hover:bg-surface-hover",
                  row.key !== undefined && row.key === activeKey && "ring-1 ring-inset ring-accent/40",
                )}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 8 + row.depth * 14 }}
                onClick={(event) => {
                  if (isGroup) {
                    toggleGroup(row.id.slice("group:".length));
                    return;
                  }
                  onRowClick(row.key!, index, {
                    ctrl: event.ctrlKey || event.metaKey,
                    shift: event.shiftKey,
                  });
                }}
                onDoubleClick={() => {
                  if (row.key) onRowOpen(row.key);
                }}
                onContextMenu={(event) => {
                  if (row.key) onRowContextMenu(event, row.key);
                }}
              >
                {isGroup ? (
                  <>
                    <ChevronRight
                      size={11}
                      className={cn(
                        "shrink-0 text-fg-subtle transition-transform",
                        row.expanded && "rotate-90",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-mono" title={row.label}>
                      {row.label}
                    </span>
                    <span className="w-16 shrink-0 text-10 text-fg-subtle">
                      {t("({{count}})", { count: row.childCount })}
                    </span>
                    <span className="w-14 shrink-0 text-right text-10 text-fg-subtle">—</span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate font-mono" title={row.label}>
                      {row.label}
                    </span>
                    <span className="w-16 shrink-0">
                      <span
                        className={cn(
                          "rounded px-1 py-px text-9 font-medium",
                          kindBadgeClass(row.kind),
                        )}
                      >
                        {row.kind}
                      </span>
                    </span>
                    <span className="w-14 shrink-0 text-right text-10 text-fg-subtle">
                      {formatTtl(row.ttlMs)}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {scanning && (
          <div className="flex items-center gap-1.5 px-3 py-2 text-11 text-fg-subtle">
            <Loader2 size={11} className="animate-spin" />
            {t("扫描中…")}
          </div>
        )}
        {capped && (
          <p className="px-3 py-2 text-11 text-warning">
            {t("已加载 20 万键（界面上限）。缩小匹配模式可继续精确查找。")}
          </p>
        )}
      </div>
    </div>
  );
}
