/**
 * 底部状态栏：真实连接状态 / 当前 DB / 已加载键数 / DBSIZE。
 *
 * 这一条是"命门"——用户在网格里滚动时，唯一能确认"我看到的是哪台机器、
 * 哪个 db、扫了多少"的地方。状态一律来自 Rust 运行时（statuses），不看会话。
 */
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

export function RedisStatusBar({
  connected,
  connecting,
  host,
  port,
  tunnelPort,
  dbIndex,
  loaded,
  dbsize,
  hasMore,
  capped,
  serverVersion,
  selectedCount,
}: {
  connected: boolean;
  connecting: boolean;
  host: string;
  port: number;
  tunnelPort: number | null;
  dbIndex: number;
  loaded: number;
  dbsize: number | null;
  hasMore: boolean;
  capped: boolean;
  serverVersion: string | null;
  /** 参考图底栏的「已选择 N 个键」。 */
  selectedCount: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface-2 px-3 text-10 text-fg-subtle">
      <span className="shrink-0 text-fg-muted">
        {t("已选择 {{count}} 个键", { count: selectedCount })}
      </span>
      <span className="flex items-center gap-1">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            connected ? "bg-success" : connecting ? "bg-warning" : "bg-fg-subtle/40",
          )}
        />
        {connected ? t("已连接") : connecting ? t("连接中…") : t("未连接")}
      </span>
      <span className="truncate">
        {host}:{port}
        {tunnelPort !== null && ` · 隧道 127.0.0.1:${tunnelPort}`}
      </span>
      <span>db {dbIndex}</span>
      <span>
        {t("已加载 {{loaded}}", { loaded: loaded.toLocaleString() })}
        {dbsize !== null && ` / ${dbsize.toLocaleString()}`}
      </span>
      {hasMore && <span className="text-accent">{t("还有更多（滚动加载）")}</span>}
      {capped && <span className="text-warning">{t("已达界面上限")}</span>}
      {serverVersion && <span className="ml-auto">Redis {serverVersion}</span>}
    </div>
  );
}
