/**
 * 键网格：Key / 类型 / TTL 三列，虚拟滚动 + 多选。
 *
 * 为什么是网格而不是原来的按钮列表：
 * - Navicat 式的"一眼扫完"必须能对齐列看类型与 TTL；
 * - 10 万键不可能全量渲染 DOM，这里只渲染可视区（行高固定 26px）；
 * - 单击选中、双击打开、Ctrl/Shift 多选由父级统一处理，网格只上报原始事件。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "@/components/icons";
import type { RedisKeyBrief } from "@/api/types/database";
import { cn } from "@/lib/cn";
import { formatTtl, kindBadgeClass } from "./redis-shared";

const ROW_HEIGHT = 26;
const OVERSCAN = 10;

export function RedisKeyGrid({
  keys,
  selected,
  activeKey,
  scanning,
  hasMore,
  capped,
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
  onRowClick: (key: string, index: number, mods: { ctrl: boolean; shift: boolean }) => void;
  onRowOpen: (key: string) => void;
  onRowContextMenu: (event: React.MouseEvent, key: string) => void;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  // 视口高度变化（窗口缩放 / 拖拽分栏）时重算渲染窗口。
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    const target = event.currentTarget;
    // 快到底部时自动续扫一页（等同于"加载更多"，不必再点按钮）。
    if (
      hasMore &&
      !scanning &&
      target.scrollHeight - target.scrollTop - target.clientHeight < ROW_HEIGHT * 20
    ) {
      onLoadMore();
    }
  }, [hasMore, scanning, onLoadMore]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const slice = keys.slice(start, start + visibleCount);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-1">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-10 font-medium text-fg-subtle">
        <span className="min-w-0 flex-1">{t("键名")}</span>
        <span className="w-16 shrink-0">{t("类型")}</span>
        <span className="w-14 shrink-0 text-right">{t("TTL")}</span>
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto outline-none"
        onScroll={onScroll}
        role="grid"
        tabIndex={0}
        aria-rowcount={keys.length}
        aria-label={t("键列表")}
      >
        {keys.length === 0 && !scanning && (
          <p className="px-3 py-6 text-11 leading-relaxed text-fg-subtle">
            {t("没有匹配的键。调整模式后回车重新扫描。")}
          </p>
        )}
        <div style={{ height: keys.length * ROW_HEIGHT, position: "relative" }}>
          {slice.map((entry, offset) => {
            const index = start + offset;
            const isSelected = selected.has(entry.key);
            return (
              <div
                key={entry.key}
                role="row"
                aria-selected={isSelected}
                className={cn(
                  "absolute left-0 right-0 flex cursor-default items-center gap-2 px-2 text-12",
                  isSelected
                    ? "bg-accent/12 text-fg"
                    : index % 2 === 0
                      ? "text-fg"
                      : "bg-surface-2/40 text-fg",
                  entry.key === activeKey && "ring-1 ring-inset ring-accent/40",
                  "hover:bg-surface-hover",
                )}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={(event) =>
                  onRowClick(entry.key, index, {
                    ctrl: event.ctrlKey || event.metaKey,
                    shift: event.shiftKey,
                  })
                }
                onDoubleClick={() => onRowOpen(entry.key)}
                onContextMenu={(event) => onRowContextMenu(event, entry.key)}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-11" title={entry.key}>
                  {entry.key}
                </span>
                <span className="w-16 shrink-0">
                  <span
                    className={cn(
                      "rounded px-1 py-px text-9 font-medium",
                      kindBadgeClass(entry.kind),
                    )}
                  >
                    {entry.kind}
                  </span>
                </span>
                <span className="w-14 shrink-0 text-right text-10 text-fg-subtle">
                  {formatTtl(entry.ttl_ms)}
                </span>
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
