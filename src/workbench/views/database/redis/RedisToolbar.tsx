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
  dbOptions,
  onDbChange,
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
}: {
  dbIndex: number;
  dbOptions: number[];
  onDbChange: (value: number) => void;
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
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2">
      <select
        value={String(dbIndex)}
        aria-label={t("db index")}
        disabled={dbOptions.length <= 1 || !connected}
        onChange={(event) => onDbChange(Number(event.target.value))}
        className="h-[26px] w-[76px] shrink-0 rounded-[6px] border border-line bg-surface-1 px-1 text-11 text-fg outline-none focus:border-accent disabled:opacity-60"
      >
        {dbOptions.map((index) => (
          <option key={index} value={String(index)}>
            db {index}
          </option>
        ))}
      </select>

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

      <span className="shrink-0 text-10 text-fg-subtle">{t("键包含")}</span>
      <input
        ref={patternRef}
        className="h-[26px] min-w-[120px] flex-1 rounded-[6px] border border-line bg-surface-1 px-2 text-11 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        value={pattern}
        onChange={(event) => onPatternChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onScan();
        }}
        placeholder={t("例如 user:*（Ctrl+F）")}
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
