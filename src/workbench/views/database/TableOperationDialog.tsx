import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type {
  DbTable,
  TableOperationKind,
  TableOperationPreview,
} from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

export interface TableOperationTarget {
  profileId: string;
  connectionName: string;
  database: string;
  table: DbTable;
}

export interface TableOperationRequestTarget {
  target: TableOperationTarget;
  kind: TableOperationKind;
}

const COPY_SUFFIX = "_copy";

export function TableOperationDialog({
  pending,
  onClose,
  onApplied,
}: {
  pending: TableOperationRequestTarget | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<TableOperationPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = useDatabaseStore((state) =>
    pending ? state.sessions[pending.target.profileId]?.session_id : undefined,
  );
  const ensureSession = useDatabaseStore((state) => state.ensureSession);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  const invalidate = useDatabaseStore((state) => state.invalidate);

  const kind = pending?.kind;
  const needsName = kind === "rename" || kind === "copy_structure" || kind === "copy_data";

  const title = useMemo(() => {
    const isView = pending?.target.table.kind === "view";
    switch (kind) {
      case "rename":
        return isView ? t("重命名视图") : t("重命名表");
      case "copy_structure":
        return t("复制表结构");
      case "copy_data":
        return t("复制表结构和数据");
      case "drop":
        return isView ? t("删除视图") : t("删除表");
      case "truncate":
        return t("清空表");
      default:
        return t("表操作");
    }
  }, [kind, pending?.target.table.kind, t]);

  useEffect(() => {
    if (!pending) {
      setName("");
      setPreview(null);
      setPreviewKey(null);
      setError(null);
      return;
    }
    setName(`${pending.target.table.name}${COPY_SUFFIX}`);
    setPreview(null);
    setPreviewKey(null);
    setError(null);
    if (!sessionId) {
      void ensureSession(pending.target.profileId);
    }
    // 只在新操作打开时重置；sessionId 到账后不要清掉用户刚输入的 DDL 名称。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureSession, pending]);

  const request = () =>
    pending
      ? {
          kind: pending.kind,
          database: pending.target.database,
          table: pending.target.table.name,
          new_name: needsName ? name.trim() : null,
        }
      : null;

  const loadPreview = async () => {
    if (!pending || !sessionId) {
      setError(t("连接尚未建立，无法预览 DDL"));
      return;
    }
    if (needsName && !name.trim()) {
      setError(t("请输入新名称"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await databaseApi.previewTableOperation(
        sessionId,
        request()!,
      );
      setPreview(result);
      setPreviewKey(needsName ? name.trim() : "__destructive__");
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!pending || !sessionId) {
      setError(t("连接尚未建立，无法执行 DDL"));
      return;
    }
    if (needsName && !name.trim()) {
      setError(t("请输入新名称"));
      return;
    }
    if (!preview || previewKey !== (needsName ? name.trim() : "__destructive__")) {
      setError(t("请先预览 DDL，确认后再执行"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await databaseApi.applyTableOperation(
        sessionId,
        request()!,
        preview.sql,
      );
      const store = useDatabaseWorkspaceStore.getState();
      const workbench = useDatabaseWorkbenchStore.getState();
      if (pending.kind === "rename") {
        store.renameTableItems(
          pending.target.profileId,
          pending.target.database,
          pending.target.table.name,
          name.trim(),
        );
      } else if (pending.kind === "drop" || pending.kind === "truncate") {
        const matching = store.items.filter(
          (item) =>
            item.profileId === pending.target.profileId &&
            item.database === pending.target.database &&
            item.objectName === pending.target.table.name &&
            (item.kind === "table" ||
              (pending.kind === "drop" && item.kind === "structure")),
        );
        for (const item of matching) {
          workbench.dispose(item.id, { clearDraft: true });
          store.close(item.id);
        }
      }
      await refreshTables(pending.target.profileId, pending.target.database);
      void invalidate(pending.target.profileId);
      onApplied();
      onClose();
    } catch (failure) {
      // DDL 可能部分成功/结果未知：刷新树，让界面反映真实对象状态，
      // 不自动关闭任何工作项。
      if (pending) {
        await refreshTables(
          pending.target.profileId,
          pending.target.database,
        ).catch(() => undefined);
        void invalidate(pending.target.profileId);
      }
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  if (!pending) return null;

  return (
    <Modal
      open
      title={title}
      description={t("操作只作用于当前表；执行前会先拿后端生成的 DDL 预览。")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void loadPreview()} disabled={busy}>
            {t("预览 DDL")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void apply()}
            disabled={busy || !preview}
          >
            {kind === "drop"
              ? t("确认删除")
              : kind === "truncate"
                ? t("确认清空")
                : t("执行")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-12 text-fg-muted">
        <p>
          {t("对象")}：{pending.target.database}.{pending.target.table.name}
        </p>
        {needsName && (
          <Field label={t("新名称")}>
            <input
              autoFocus
              className={fieldClass}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setPreview(null);
                setPreviewKey(null);
              }}
              placeholder={t("输入新的表名")}
            />
          </Field>
        )}
        {preview?.warning && (
          <p className="rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            {preview.warning}
          </p>
        )}
        {preview && (
          <div>
            <div className="mb-1 text-11 text-fg-subtle">{t("DDL 预览")}</div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
              {preview.sql}
            </pre>
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Modal>
  );
}
