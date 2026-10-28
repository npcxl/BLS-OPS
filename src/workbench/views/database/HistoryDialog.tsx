/**
 * SQL 历史。**默认只在用户显式执行后记录**，且可以整体关闭/清空。
 *
 * SQL 文本可能包含密码、token、个人信息，所以：
 * - 后端不自动记录；
 * - 这个开关关闭后，前端不再写历史；
 * - 应用日志从不打印 SQL。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type { QueryHistoryEntry } from "@/api/types/database";
import { toDbError } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";

export function HistoryDialog({
  open,
  onClose,
  profileId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  profileId: string;
  onPick: (statement: string) => void;
}) {
  const { t } = useTranslation();
  const historyEnabled = useDatabaseWorkbenchStore((state) => state.historyEnabled);
  const setHistoryEnabled = useDatabaseWorkbenchStore((state) => state.setHistoryEnabled);

  const [entries, setEntries] = useState<QueryHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await databaseApi.historyList(profileId));
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const clear = async () => {
    try {
      await databaseApi.historyClear(profileId);
      setEntries([]);
    } catch (failure) {
      setError(toDbError(failure).message);
    }
  };

  return (
    <Modal
      open={open}
      title={t("SQL 历史")}
      description={t("只保存在本机；可以通过开关停止记录，或随时清空。")}
      width={620}
      onClose={onClose}
      footer={
        <>
          <label className="mr-auto flex items-center gap-1.5 text-11 text-fg-muted">
            <input
              type="checkbox"
              checked={historyEnabled}
              onChange={(event) => setHistoryEnabled(event.target.checked)}
            />
            {t("记录执行过的 SQL")}
          </label>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={12} className="animate-spin" /> : <History size={12} />}
            {t("刷新")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={entries.length === 0}>
            <Trash2 size={12} />
            {t("清空")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("关闭")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {error && <p className="text-11 text-danger">{error}</p>}
        {!error && entries.length === 0 && !loading && (
          <p className="py-4 text-center text-11 text-fg-subtle">{t("还没有历史记录")}</p>
        )}
        <div className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="flex flex-col gap-1 rounded-[7px] border border-line px-2 py-1.5 text-left hover:bg-surface-hover"
              onClick={() => onPick(entry.sql)}
              title={t("点击填入编辑器")}
            >
              <div className="flex items-center gap-2 text-11 text-fg-subtle">
                <span
                  className={
                    entry.succeeded ? "text-success" : "text-danger"
                  }
                >
                  {entry.succeeded ? t("成功") : t("失败")}
                </span>
                <span>{new Date(entry.created_at).toLocaleString()}</span>
                <span>
                  {entry.rows.toLocaleString()} {t("行")}
                </span>
                <span>{entry.elapsed_ms} ms</span>
              </div>
              <pre className="max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-11 text-fg">
                {entry.sql.length > 400 ? `${entry.sql.slice(0, 400)}…` : entry.sql}
              </pre>
              {entry.error && (
                <span className="truncate text-11 text-danger">{entry.error}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
