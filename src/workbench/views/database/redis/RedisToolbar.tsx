/**
 * Redis 工作区的两条横栏：
 * - 上：连接上下文（状态点 / 名称 / host:port · db N / 版本）+ 连接级操作
 * - 下：库切换 + pattern 搜索 + 扫描 + 新建键（只影响键列表，不碰连接）
 *
 * 拆出来的原因：这两条栏全是"展示 + 回调"，塞在 600 行的 Workspace 里只会让
 * 布局与状态混在一起；拆开后工作区只剩编排。
 */
import { useTranslation } from "react-i18next";
import { Loader2, PlugZap, Plus, RefreshCw } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import type { DbErrorInfo } from "@/api/types/database";

export function RedisToolbar({
  profileName,
  host,
  port,
  dbIndex,
  dbOptions,
  serverVersion,
  connected,
  connecting,
  sessionError,
  onReconnect,
  onDbChange,
  writable,
  pattern,
  scanning,
  onPatternChange,
  onScan,
  onNewKey,
  onTogglePubsub,
  pubsubOpen,
  detailVisible,
  onToggleDetail,
  patternRef,
}: {
  profileName: string;
  host: string;
  port: number;
  dbIndex: number;
  dbOptions: number[];
  serverVersion: string | null;
  connected: boolean;
  connecting: boolean;
  sessionError: DbErrorInfo | null;
  onReconnect: () => void;
  onDbChange: (value: number) => void;
  writable: boolean;
  pattern: string;
  scanning: boolean;
  onPatternChange: (value: string) => void;
  onScan: () => void;
  onNewKey: () => void;
  onTogglePubsub: () => void;
  pubsubOpen: boolean;
  detailVisible: boolean;
  onToggleDetail: () => void;
  patternRef: React.RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();

  return (
    <>
      {/* 连接上下文：始终显示"我在哪台机器、哪个库" */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected
              ? "bg-success"
              : sessionError
                ? "bg-danger"
                : connecting
                  ? "bg-warning"
                  : "bg-fg-subtle/40",
          )}
        />
        <span className="min-w-0 truncate text-12 font-medium text-fg">{profileName}</span>
        <span className="hidden shrink-0 text-11 text-fg-subtle sm:inline">
          {host}:{port} · db {dbIndex}
        </span>
        {connected && serverVersion && (
          <span className="hidden shrink-0 text-11 text-fg-subtle md:inline">
            Redis {serverVersion}
          </span>
        )}
        <div className="flex-1" />
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
            className={cn("h-5 w-5 px-0", pubsubOpen && "bg-surface-hover")}
            aria-label={t("发布 / 订阅")}
            onClick={onTogglePubsub}
          >
            <PlugZap size={13} />
          </Button>
        </Tooltip>
        <Tooltip label={detailVisible ? t("收起详情") : t("展开详情")} side="bottom">
          <Button
            variant="ghost"
            size="xs"
            className={cn("h-5 w-5 px-0 text-11", !detailVisible && "text-fg-subtle")}
            aria-label={t("切换详情面板")}
            aria-pressed={detailVisible}
            onClick={onToggleDetail}
          >
            ▥
          </Button>
        </Tooltip>
      </div>

      {/* 键列表操作区 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <select
          value={String(dbIndex)}
          aria-label={t("db index")}
          disabled={dbOptions.length <= 1}
          onChange={(event) => onDbChange(Number(event.target.value))}
          className="h-[26px] w-20 shrink-0 rounded-[6px] border border-line bg-surface-1 px-1 text-12 text-fg outline-none focus:border-accent disabled:opacity-60"
        >
          {dbOptions.map((index) => (
            <option key={index} value={String(index)}>
              db {index}
            </option>
          ))}
        </select>
        <input
          ref={patternRef}
          className="h-[26px] min-w-[120px] flex-1 rounded-[6px] border border-line bg-surface-1 px-2 text-12 text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
          value={pattern}
          onChange={(event) => onPatternChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onScan();
          }}
          placeholder={t("键名模式，例如 user:* 或 session:*（Ctrl+F）")}
          aria-label={t("键名模式")}
        />
        <Button
          variant="secondary"
          size="xs"
          disabled={scanning || !connected}
          onClick={onScan}
        >
          {scanning ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          {t("扫描")}
        </Button>
        {writable && connected && (
          <Tooltip label={t("新建 string 键")} side="bottom">
            <Button
              variant="ghost"
              size="xs"
              className="h-5 w-5 px-0"
              aria-label={t("新建 string 键")}
              onClick={onNewKey}
            >
              <Plus size={13} />
            </Button>
          </Tooltip>
        )}
      </div>
    </>
  );
}
