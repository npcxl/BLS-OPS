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
  onPick,
}: {
  sessionId: string;
  serverId?: string;
  onPick: (command: string) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<{ id: string; command: string; timestamp: number }[]>([]);

  useEffect(() => {
    void opsApi
      .listHistory(200)
      .then((rows) =>
        setItems(
          rows
            .filter((row) => row.session_id === sessionId || (!!serverId && row.server_id === serverId))
            .map((row) => ({ id: row.id, command: row.command, timestamp: row.timestamp })),
        ),
      )
      .catch(() => setItems([]));
  }, [serverId, sessionId]);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-l border-line bg-surface-1">
      <div className="flex h-7 shrink-0 items-center justify-between px-2.5 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {t("Command History")}
        <span>{items.length}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="px-2.5 py-2 text-11 text-fg-subtle">{t("Commands run in this terminal are recorded here")}</p>
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
