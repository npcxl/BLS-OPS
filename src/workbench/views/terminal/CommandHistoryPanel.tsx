import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { opsApi } from "@/api/ops-api";

/**
 * Commands recorded for this session, falling back to earlier sessions on the
 * same server. Clicking one sends it to the shell.
 */
export function CommandHistoryPanel({
  sessionId,
  serverId,
  quickTarget,
  revision = 0,
  onPick,
}: {
  sessionId: string;
  serverId?: string;
  /** 快速连接的完整目标：用户名、主机和端口。 */
  quickTarget?: string;
  /** 每记录一条新命令就 +1，让面板重新加载（否则刚敲的命令要重开面板才出现）。 */
  revision?: number;
  onPick: (command: string) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<{ id: string; command: string; timestamp: number }[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void opsApi.listHistory(500, { sessionId, serverId, quickTarget, query }).then(
        (rows) => {
          if (active) setItems(rows);
        },
        () => {
          if (active) setItems([]);
        },
      );
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [quickTarget, query, revision, serverId, sessionId]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface-1">
      <div className="flex h-7 shrink-0 items-center justify-between px-2.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {t("Command History")}
        <span>{items.length}</span>
      </div>
      <div className="shrink-0 px-2.5 py-2">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t("Search command history")}
          placeholder={t("Search command history")}
          className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-11 text-fg"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">
            {t(query.trim() ? "No matching commands." : "Commands run in this terminal are recorded here")}
          </p>
        ) : (
          items.map((item) => (
            <button
              key={item.id}
              type="button"
              title={`${item.command}\n${new Date(item.timestamp).toLocaleString()}`}
              className="block w-full truncate px-2.5 py-1 text-left text-11 text-fg-muted hover:bg-surface-hover hover:text-fg"
              onClick={() => onPick(item.command)}
            >
              {item.command}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
