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
import { formatBytes } from "@/lib/format";
import { formatTtl, kindBadgeClass } from "./redis-shared";
import type { RedisValuePreview } from "./useRedisValuePreview";

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

/**
 * 列模板：表头与每一行共用同一个字符串，杜绝"表头和内容各写一套宽度"。
 * 顺序与参考图一致：键 / 类型 / 值 / 大小 / TTL。
 */
const GRID_COLS = "minmax(180px, 340px) 110px minmax(140px, 1.6fr) 84px 64px";

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
      const parts = entry.key.split(separator);
      rows.push({
        id: entry.key,
        depth,
        // 树视图叶子只显示当前层名（`bls:auth:token` → `token`），
        // 完整键名在 tooltip 与详情面板里看，避免每行重复长前缀。
        label: parts.length > 1 ? parts[parts.length - 1] : entry.key,
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
  previews,
  onRowClick,
  onRowOpen,
  onRowContextMenu,
  onLoadMore,
  onNavigate,
}: {
  keys: RedisKeyBrief[];
  selected: Set<string>;
  activeKey: string | null;
  scanning: boolean;
  hasMore: boolean;
  capped: boolean;
  view: RedisGridView;
  /** 值 / 大小两列的按需预览（只覆盖可见批次，未取到就留空）。 */
  previews: Record<string, RedisValuePreview>;
  onRowClick: (key: string, index: number, mods: { ctrl: boolean; shift: boolean }) => void;
  onRowOpen: (key: string) => void;
  onRowContextMenu: (event: React.MouseEvent, key: string) => void;
  onLoadMore: () => void;
  /** 上下键移动到某个键（树视图下跳过分组行）。 */
  onNavigate: (key: string) => void;
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

  /**
   * 上下键只在**键行**之间移动：树视图的分组行不是键，不能被导航选中。
   * 索引用当前展开后的 rows（含分组），目标只取 key 行，与画面顺序一致。
   */
  const onViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const keyRows = rows.filter((row) => row.key !== undefined);
    if (keyRows.length === 0) return;
    event.preventDefault();
    const current = keyRows.findIndex((row) => row.key === activeKey);
    const next = Math.max(
      0,
      Math.min(keyRows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)),
    );
    const target = keyRows[next];
    if (target?.key) onNavigate(target.key);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-surface-1">
      {/* 表头与数据行共用同一套 grid 模板，逐列对齐 */}
      <div
        className="grid h-7 shrink-0 items-center border-b border-line text-10 font-medium text-fg-muted"
        style={{ gridTemplateColumns: GRID_COLS }}
      >
        <span className="flex items-center px-2">
          {t("键")} <span className="ml-1 text-fg-subtle">▲</span>
        </span>
        <span className="flex h-full items-center border-l border-line bg-surface-2/70 px-2">
          {t("类型")}
        </span>
        <span className="flex h-full items-center border-l border-line bg-surface-2/70 px-2">
          {t("值")}
        </span>
        <span className="flex h-full items-center justify-end border-l border-line bg-surface-2/70 px-2">
          {t("大小")}
        </span>
        <span className="flex h-full items-center justify-end border-l border-line bg-surface-2/70 px-2">
          {t("TTL")}
        </span>
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onScroll={onScroll}
        onKeyDown={onViewportKeyDown}
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
                  "absolute left-0 right-0 grid cursor-default items-center text-11",
                  isSelected ? "bg-accent/20 text-fg" : "text-fg hover:bg-surface-hover",
                  row.key !== undefined && row.key === activeKey && "ring-1 ring-inset ring-accent/40",
                )}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, gridTemplateColumns: GRID_COLS }}
                onClick={(event) => {
                  if (isGroup) {
                    toggleGroup(row.id.slice("group:".length));
                    return;
                  }
                  // 回传**键列表里的真实索引**：树视图的行号含分组行，
                  // 直接给行号会让 Shift 连选取错范围。
                  onRowClick(
                    row.key!,
                    Math.max(0, keys.findIndex((entry) => entry.key === row.key)),
                    {
                      ctrl: event.ctrlKey || event.metaKey,
                      shift: event.shiftKey,
                    },
                  );
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
                    <span
                      className="flex min-w-0 items-center gap-1 pr-2"
                      style={{ paddingLeft: 8 + row.depth * 14 }}
                    >
                      <ChevronRight
                        size={11}
                        className={cn(
                          "shrink-0 text-fg-subtle transition-transform",
                          row.expanded && "rotate-90",
                        )}
                      />
                      <span className="min-w-0 truncate font-mono" title={row.label}>
                        {row.label}
                        <span className="ml-1 text-10 text-fg-subtle">({row.childCount})</span>
                      </span>
                    </span>
                    <span className="border-l border-line" />
                    <span className="border-l border-line" />
                    <span className="border-l border-line" />
                    <span className="border-l border-line" />
                  </>
                ) : (
                  <>
                    <span
                      className="flex min-w-0 items-center truncate pr-2 font-mono"
                      style={{ paddingLeft: 8 + row.depth * 14 }}
                      title={row.key ?? row.label}
                    >
                      {row.label}
                    </span>
                    <span className="flex items-center border-l border-line px-2">
                      <span
                        className={cn(
                          "rounded px-1 text-9 font-medium",
                          kindBadgeClass(row.kind),
                        )}
                      >
                        {row.kind}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center truncate border-l border-line px-2 text-10 text-fg-muted">
                      {previews[row.key!]?.text ?? ""}
                    </span>
                    <span className="flex items-center justify-end border-l border-line px-2 text-10 text-fg-subtle">
                      {previews[row.key!]?.bytes !== null &&
                      previews[row.key!]?.bytes !== undefined
                        ? formatBytes(previews[row.key!].bytes as number)
                        : ""}
                    </span>
                    <span className="flex items-center justify-end border-l border-line px-2 text-10 text-fg-subtle">
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
        {/* 有下一页就给一个明确的按钮：内容不足一屏时也能点，不必先滚动 */}
        {hasMore && (
          <div className="sticky bottom-0 flex items-center justify-center border-t border-line bg-surface-1 py-1">
            <button
              type="button"
              disabled={scanning}
              className="rounded px-2 py-0.5 text-11 text-accent hover:bg-surface-hover disabled:opacity-60"
              onClick={onLoadMore}
            >
              {scanning ? t("加载中…") : t("加载更多（还有未扫描的键）")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
