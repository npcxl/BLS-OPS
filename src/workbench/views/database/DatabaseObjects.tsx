/**
 * 数据库对象列表：点击左侧数据库时打开，列出该库全部表/视图。
 *
 * 表可能上千个，所以：
 * - 过滤走 `useDeferredValue`，输入不阻塞；
 * - 列表只渲染视口内的行（固定行高虚拟化），不为每个表建 DOM；
 * - 高亮只计算可见行，不在每次按键时给全部结果套 `<mark>`。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  Database as DatabaseIcon,
  FilePlus2,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenu, useContextMenu } from "@/components/ui/context-menu";
import { LoadingState } from "@/components/ui/loading";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import type { DbTable } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

const ROW_HEIGHT = 30;
/** 稳定空数组：selector 每次返回新 `[]` 会触发无限重渲染。 */
const EMPTY_TABLES: DbTable[] = [];

function highlight(name: string, needle: string) {
  const query = needle.trim().toLowerCase();
  if (!query) return name;
  const index = name.toLowerCase().indexOf(query);
  if (index < 0) return name;
  return (
    <>
      {name.slice(0, index)}
      <mark className="rounded bg-warning/30 px-0.5 text-fg">
        {name.slice(index, index + query.length)}
      </mark>
      {name.slice(index + query.length)}
    </>
  );
}

export function DatabaseObjects({
  item,
  profileId,
  connectionName,
  onNewQuery,
  onRequestClose,
}: {
  item: WorkItem;
  profileId: string;
  connectionName: string;
  onNewQuery: () => void;
  onRequestClose: (item: WorkItem) => void;
}) {
  const { t } = useTranslation();
  const database = item.objectName;
  const key = `${profileId}\u0001${database}`;
  const tableList = useDatabaseStore((state) => state.tables[key]);
  const tables = tableList ?? EMPTY_TABLES;
  const loading = useDatabaseStore((state) => state.loading[key] ?? false);
  const error = useDatabaseStore((state) => state.errors[key] ?? null);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  const openTable = useDatabaseWorkspaceStore((state) => state.openTable);
  const openStructure = useDatabaseWorkspaceStore((state) => state.openStructure);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const menu = useContextMenu();

  useEffect(() => {
    // 用 `undefined` 判断"从未加载"；已加载的空数组不能再触发请求，
    // 否则空库会无限刷新。
    if (tableList === undefined && !loading && !error) {
      void refreshTables(profileId, database);
    }
  }, [database, error, loading, profileId, refreshTables, tableList]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 输入即时更新，过滤延后执行：上千张表时不会每个按键都卡一下。
  const deferredQuery = useDeferredValue(query);
  const rows = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const filtered = needle
      ? tables.filter((table) => table.name.toLowerCase().includes(needle))
      : tables;
    // 按名称排序，右侧 A–Z 字母导航的顺序才和列表一致。
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [deferredQuery, tables]);

  const letterTargets = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((table, index) => {
      const first = table.name.trim().charAt(0).toUpperCase();
      const letter = /^[A-Z]$/.test(first) ? first : "…";
      if (!map.has(letter)) map.set(letter, index);
    });
    return [...map.entries()].sort((a, b) =>
      a[0] === "…" ? 1 : b[0] === "…" ? -1 : a[0].localeCompare(b[0]),
    );
  }, [rows]);
  const [activeLetter, setActiveLetter] = useState<string | null>(null);

  const jumpToLetter = (letter: string, index: number) => {
    setActiveLetter(letter);
    viewportRef.current?.scrollTo({
      top: index * ROW_HEIGHT,
      behavior: "smooth",
    });
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 6);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 6,
  );
  const visible = rows.slice(start, end);

  const openTableRow = (name: string) => {
    openTable({ profileId, connectionName, database, table: name });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2">
        <Button variant="primary" size="xs" onClick={onNewQuery}>
          <FilePlus2 size={11} />
          {t("新建查询")}
        </Button>
        <span className="mx-1 h-5 w-px shrink-0 bg-line" />
        <DatabaseIcon size={11} className="shrink-0 text-fg-subtle" />
        <span className="max-w-[220px] shrink-0 truncate text-12 font-medium text-fg">
          {database}
        </span>
        <span className="shrink-0 text-11 text-fg-subtle">
          {t("{{count}} 个对象", { count: tables.length })}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => void refreshTables(profileId, database)}
            title={t("刷新表列表")}
          >
            {loading ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <RefreshCw size={11} />
            )}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onRequestClose(item)}
            title={t("关闭")}
          >
            <X size={11} />
          </Button>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <Search size={11} className="shrink-0 text-fg-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("搜索表 / 视图…")}
          className="h-[24px] min-w-0 flex-1 rounded-[6px] border border-line bg-surface-2 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        />
        {query && (
          <button
            type="button"
            className="shrink-0 text-11 text-fg-subtle hover:text-fg"
            onClick={() => setQuery("")}
          >
            {t("清除")}
          </button>
        )}
        <span className="shrink-0 text-11 text-fg-subtle">
          {t("{{count}} 个匹配", { count: rows.length })}
        </span>
      </div>

      {error && (
        <div className="border-b border-danger/30 bg-danger/10 px-2 py-1 text-11 text-danger">
          {error.message}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div
          ref={viewportRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          {tableList === undefined && !error ? (
            <LoadingState className="h-full" />
          ) : rows.length === 0 ? (
            <p className="px-3 py-3 text-12 text-fg-subtle">
              {tables.length === 0 ? t("没有表或视图") : t("没有匹配的表")}
            </p>
          ) : (
            <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
              {visible.map((table, index) => {
                const rowIndex = start + index;
                const active = selected === table.name;
                return (
                  <div
                    key={table.name}
                    className={cn(
                      "absolute flex w-full cursor-default items-center gap-2 border-b border-line px-3 text-12",
                      active ? "bg-accent/10" : "hover:bg-surface-hover",
                    )}
                    style={{ top: rowIndex * ROW_HEIGHT, height: ROW_HEIGHT }}
                    onClick={() => setSelected(table.name)}
                    onDoubleClick={() => openTableRow(table.name)}
                    onContextMenu={menu.onContextMenu(() => [
                      {
                        id: "data",
                        label: t("打开数据"),
                        onSelect: () => openTableRow(table.name),
                      },
                      {
                        id: "structure",
                        label: t("打开结构"),
                        onSelect: () =>
                          openStructure({
                            profileId,
                            connectionName,
                            database,
                            table: table.name,
                          }),
                      },
                      { separator: true },
                      {
                        id: "copy",
                        label: t("复制表名"),
                        onSelect: () => void copyText(table.name),
                      },
                    ])}
                    title={`${database}.${table.name}`}
                  >
                    {table.kind === "view" ? (
                      <Columns3 size={12} className="shrink-0 text-fg-subtle" />
                    ) : (
                      <Table2 size={12} className="shrink-0 text-fg-subtle" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-fg">
                      {highlight(table.name, deferredQuery)}
                    </span>
                    <span className="shrink-0 text-11 text-fg-subtle">
                      {table.kind === "view" ? t("视图") : table.engine ?? "—"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {letterTargets.length > 0 && (
          <div className="flex w-[18px] shrink-0 flex-col items-center overflow-y-auto border-l border-line bg-surface-1 py-1">
            {letterTargets.map(([letter, index]) => (
              <button
                key={letter}
                type="button"
                onClick={() => jumpToLetter(letter, index)}
                className={cn(
                  "flex h-4 w-full shrink-0 items-center justify-center text-11",
                  activeLetter === letter
                    ? "font-medium text-accent"
                    : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
                )}
                title={`${t("跳到")} ${letter}`}
              >
                {letter}
              </button>
            ))}
          </div>
        )}
      </div>

      <ContextMenu {...menu.props} />
    </div>
  );
}
