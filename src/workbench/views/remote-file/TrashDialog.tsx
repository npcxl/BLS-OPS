/**
 * 回收站：删除默认移动到这里，恢复与永久删除分开。
 *
 * 位置在服务器登录目录下的 `.bls-ops-trash/<时间戳>/`，所以换台机器也能恢复；
 * 反过来，占用的是服务器磁盘 —— 面板上要能清空。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorText, Modal } from "@/components/ui/modal";
import { opsApi, toErrorMessage, type TrashEntry } from "@/api/ops-api";

export function TrashDialog({
  open,
  sessionId,
  onClose,
  onChanged,
}: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
  /** 恢复 / 永久删除之后通知面板刷新列表。 */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<TrashEntry | null>(null);
  const [emptyOpen, setEmptyOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setEntries(await opsApi.trashList(sessionId));
    } catch (cause) {
      setEntries([]);
      setError(toErrorMessage(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const restore = async (entry: TrashEntry) => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.trashRestore(sessionId, entry.id);
      onChanged();
      await load();
    } catch (cause) {
      // 原路径已存在等情况：如实说明，不替用户覆盖。
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const purge = async (entry: TrashEntry) => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.trashPurge(sessionId, entry.id);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
      setPurgeTarget(null);
    }
  };

  const empty = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsApi.trashEmpty(sessionId);
      await load();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
      setEmptyOpen(false);
    }
  };

  return (
    <Modal
      open={open}
      width={560}
      title={t("Recycle bin")}
      description={t(
        "Deleted files are moved to ~/.bls-ops-trash on the server. Restore them here, or delete them permanently.",
      )}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-11 text-fg-subtle">
            {t("{{count}} items", { count: entries?.length ?? 0 })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !entries?.length}
            onClick={() => setEmptyOpen(true)}
          >
            {t("Empty recycle bin")}
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("Close")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {error && <ErrorText>{error}</ErrorText>}
        {entries === null && (
          <div className="flex items-center gap-2 py-6 text-11 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("Reading…")}
          </div>
        )}
        {entries !== null && entries.length === 0 && (
          <p className="py-6 text-11 text-fg-subtle">{t("The recycle bin is empty.")}</p>
        )}
        {entries?.map((entry) => (
          <div
            key={entry.id}
            className="flex items-center gap-2 rounded-[8px] border border-line px-3 py-1.5"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-11 text-fg" title={entry.original_path}>
                {entry.name}
              </div>
              <div className="truncate font-mono text-10 text-fg-subtle" title={entry.original_path}>
                {entry.original_path}
              </div>
            </div>
            <span className="shrink-0 text-10 text-fg-subtle">
              {new Date(entry.deleted_at).toLocaleString()}
            </span>
            <Button
              variant="secondary"
              size="xs"
              disabled={busy}
              onClick={() => void restore(entry)}
            >
              <RotateCcw size={11} />
              {t("Restore")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="hover:text-danger"
              disabled={busy}
              onClick={() => setPurgeTarget(entry)}
            >
              <Trash2 size={11} />
              {t("Delete permanently")}
            </Button>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={purgeTarget !== null}
        danger
        title={t("Delete {{name}} permanently?", { name: purgeTarget?.name ?? "" })}
        description={t("This cannot be undone — the file is removed from the server's recycle bin.")}
        confirmLabel={t("Delete permanently")}
        pending={busy}
        onCancel={() => setPurgeTarget(null)}
        onConfirm={() => {
          if (purgeTarget) void purge(purgeTarget);
        }}
      />

      <ConfirmDialog
        open={emptyOpen}
        danger
        title={t("Empty the recycle bin?")}
        description={t("Every entry is deleted permanently. This cannot be undone.")}
        confirmLabel={t("Empty recycle bin")}
        pending={busy}
        onCancel={() => setEmptyOpen(false)}
        onConfirm={() => void empty()}
      />
    </Modal>
  );
}
