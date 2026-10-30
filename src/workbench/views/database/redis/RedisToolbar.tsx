/**
 * Redis 工作区的唯一一条工具栏（对齐 Navicat 键数据编辑器上方那一行）。
 *
 * 顺序按参考图：库选择 → 类型过滤 → 「键包含」输入 → 刷新 → 新建；
 * 右侧只放连接级/视图级图标（重连、Pub/Sub、编辑器开合），不再单开一条
 * "连接上下文"横栏 —— 连接名由外部标签页标题承担，host/db 由底栏承担。
 */
import { useTranslation } from "react-i18next";
import { Loader2, PlugZap, Plus, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { RedisGridView } from "./RedisKeyGrid";

/** 类型过滤：只对**已加载**的行生效，不触发全库扫描。 */
export const KEY_TYPE_FILTERS = [
  "all",
  "string",
  "hash",
  "list",
  "set",
  "zset",
  "stream",
  "other",
] as const;

export type KeyTypeFilter = (typeof KEY_TYPE_FILTERS)[number];

export function RedisToolbar({
  dbIndex,
  typeFilter,
  onTypeFilterChange,
  pattern,
  onPatternChange,
  onScan,
  scanning,
  connected,
  connecting,
  onReconnect,
  writable,
  onNewKey,
  onTogglePubsub,
  pubsubOpen,
  editorVisible,
  onToggleEditor,
  patternRef,
  view,
  onViewChange,
}: {
  dbIndex: number;
  typeFilter: KeyTypeFilter;
  onTypeFilterChange: (value: KeyTypeFilter) => void;
  pattern: string;
  onPatternChange: (value: string) => void;
  onScan: () => void;
  scanning: boolean;
  connected: boolean;
  connecting: boolean;
  onReconnect: () => void;
  writable: boolean;
  onNewKey: () => void;
  onTogglePubsub: () => void;
  pubsubOpen: boolean;
  editorVisible: boolean;
  onToggleEditor: () => void;
  patternRef: React.RefObject<HTMLInputElement | null>;
  view: RedisGridView;
  onViewChange: (view: RedisGridView) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2">
      {/*
        这里**不再放 db 下拉**：切库是左侧资产树的职责（连接 → db 节点）。
        重复一个下拉只会让"当前库"出现两个真相源；这里只显示上下文。
      */}
      <span
        className="h-[26px] shrink-0 rounded-[6px] border border-line bg-surface-2 px-1.5 text-11 leading-[24px] text-fg-muted"
        title={t("切换数据库请用左侧连接树")}
      >
        db {dbIndex}
      </span>

      {/* 列表 / 树：参考图放在工具栏第一行，默认树视图 */}
      <div className="flex shrink-0 items-center rounded-[6px] border border-line p-px">
        <button
          type="button"
          aria-label={t("列表视图")}
          aria-pressed={view === "list"}
          className={cn(
            "rounded-[4px] px-1.5 text-10 leading-[20px]",
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
            "rounded-[4px] px-1.5 text-10 leading-[20px]",
            view === "tree" ? "bg-accent/15 text-accent" : "text-fg-subtle hover:bg-surface-hover",
          )}
          onClick={() => onViewChange("tree")}
        >
          {t("树")}
        </button>
      </div>

      <select
        value={typeFilter}
        aria-label={t("类型过滤")}
        onChange={(event) => onTypeFilterChange(event.target.value as KeyTypeFilter)}
        className="h-[26px] w-[92px] shrink-0 rounded-[6px] border border-line bg-surface-1 px-1 text-11 text-fg outline-none focus:border-accent"
      >
        {KEY_TYPE_FILTERS.map((value) => (
          <option key={value} value={value}>
            {value === "all" ? t("所有类型") : value}
          </option>
        ))}
      </select>

      <span className="shrink-0 text-10 text-fg-subtle">
        {t("键包含")}
        {typeFilter !== "all" && (
          <span className="ml-1 rounded bg-warning/15 px-1 text-warning" title={t("类型过滤只作用于已加载的行，不是全库过滤")}>
            {t("仅已加载")}
          </span>
        )}
      </span>
      <input
        ref={patternRef}
        className="h-[26px] min-w-[120px] flex-1 rounded-[6px] border border-line bg-surface-1 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        value={pattern}
        onChange={(event) => onPatternChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onScan();
        }}
        placeholder={t("输入片段按包含匹配；支持 * 与 ?（Ctrl+F）")}
        aria-label={t("键名模式")}
      />
      <Button variant="secondary" size="xs" disabled={scanning || !connected} onClick={onScan}>
        {scanning ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        {t("刷新")}
      </Button>
      {writable && connected && (
        <Tooltip label={t("新建 string 键")} side="bottom">
          <Button
            variant="ghost"
            size="xs"
            className="h-[26px] w-6 px-0"
            aria-label={t("新建 string 键")}
            onClick={onNewKey}
          >
            <Plus size={13} />
          </Button>
        </Tooltip>
      )}

      <div className="mx-0.5 h-4 w-px shrink-0 bg-line" />

      {!connected && (
        <Button variant="secondary" size="xs" disabled={connecting} onClick={onReconnect}>
          {connecting ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <RefreshCw size={11} />
          )}
          {t("重新连接")}
        </Button>
      )}
      <Tooltip label={t("发布 / 订阅")} side="bottom">
        <Button
          variant="ghost"
          size="xs"
          className={cn("h-[26px] w-6 px-0", pubsubOpen && "bg-surface-hover")}
          aria-label={t("发布 / 订阅")}
          onClick={onTogglePubsub}
        >
          <PlugZap size={13} />
        </Button>
      </Tooltip>
      <Tooltip label={editorVisible ? t("收起键编辑器") : t("展开键编辑器")} side="bottom">
        <Button
          variant="ghost"
          size="xs"
          className={cn("h-[26px] w-6 px-0 text-11", !editorVisible && "text-fg-subtle")}
          aria-label={t("切换键编辑器")}
          aria-pressed={editorVisible}
          onClick={onToggleEditor}
        >
          ▤
        </Button>
      </Tooltip>
    </div>
  );
}
