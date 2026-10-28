import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type { SchemaChange, SchemaPreview } from "@/api/types/database";
import { toDbError, useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

export type SchemaDialogMode =
  | "create_database"
  | "drop_database"
  | "save_view";

export interface SchemaDialogTarget {
  mode: SchemaDialogMode;
  profileId: string;
  database: string | null;
  name?: string;
  /** 编辑视图时预填已有 SELECT；新建视图为空。 */
  selectSql?: string;
  orReplace?: boolean;
}

export function SchemaChangeDialog({
  target,
  sessionId,
  onClose,
  onApplied,
}: {
  target: SchemaDialogTarget | null;
  sessionId: string | null;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [selectSql, setSelectSql] = useState("SELECT 1");
  const [preview, setPreview] = useState<SchemaPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshDatabases = useDatabaseStore((state) => state.refreshDatabases);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);

  useEffect(() => {
    if (!target) return;
    setName(
      target.mode === "drop_database"
        ? (target.name ?? "")
        : (target.name ?? ""),
    );
    setCharset("utf8mb4");
    setSelectSql(target.selectSql ?? "SELECT 1");
    setPreview(null);
    setError(null);

    // 编辑视图时从元数据读取现有定义，避免用空 SELECT 覆盖原视图。
    if (
      target.mode === "save_view" &&
      target.orReplace &&
      !target.selectSql &&
      target.database &&
      target.name
    ) {
      void databaseApi
        .tableDetail(target.profileId, target.database, target.name)
        .then((detail) => {
          const createSql = detail.create_sql ?? "";
          const match = createSql.match(/\sAS\s+([\s\S]+)$/i);
          if (match?.[1]) setSelectSql(match[1].trim());
        })
        .catch((failure) => setError(toDbError(failure).message));
    }
  }, [target]);

  const change = useMemo<SchemaChange | null>(() => {
    if (!target) return null;
    if (target.mode === "create_database") {
      return {
        action: "create_database",
        name: name.trim(),
        charset: charset.trim() || null,
        collation: null,
      };
    }
    if (target.mode === "drop_database") {
      return { action: "drop_database", name: name.trim() };
    }
    if (target.mode === "save_view") {
      return {
        action: "save_view",
        database: target.database ?? "",
        view: name.trim(),
        select_sql: selectSql,
        or_replace: target.orReplace ?? false,
      };
    }
    return null;
  }, [charset, name, selectSql, target]);

  const title =
    target?.mode === "create_database"
      ? t("新建数据库")
      : target?.mode === "drop_database"
        ? t("删除数据库")
        : target?.orReplace
          ? t("编辑视图")
          : t("新建视图");

  const loadPreview = async () => {
    if (!change) return;
    if (!name.trim() && target?.mode !== "drop_database") {
      setError(t("请输入名称"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setPreview(await databaseApi.previewSchemaChange(change));
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!change || !sessionId) {
      setError(t("连接尚未建立，无法执行 schema 修改"));
      return;
    }
    if (!name.trim()) {
      setError(t("请输入名称"));
      return;
    }
    if (!preview) {
      setError(t("请先预览 DDL"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await databaseApi.applySchemaChange(sessionId, change);
      if (target?.mode === "create_database" || target?.mode === "drop_database") {
        if (target.mode === "drop_database") {
          const database = target.database ?? target.name ?? "";
          const workspace = useDatabaseWorkspaceStore.getState();
          const workbench = useDatabaseWorkbenchStore.getState();
          for (const item of workspace.items) {
            if (
              item.profileId === target.profileId &&
              item.database === database
            ) {
              workbench.dispose(item.id, { clearDraft: true });
              workspace.close(item.id);
            }
          }
        }
        await refreshDatabases(target.profileId);
      } else if (target?.database) {
        await refreshTables(target.profileId, target.database);
      }
      onApplied();
      onClose();
    } catch (failure) {
      setError(toDbError(failure).message);
    } finally {
      setBusy(false);
    }
  };

  if (!target) return null;

  return (
    <Modal
      open
      title={title}
      description={t("DDL 由 Rust 后端生成并执行，执行前必须预览。")}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void loadPreview()}
            disabled={busy}
          >
            {t("预览 DDL")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void apply()}
            disabled={busy || !preview}
          >
            {target.mode === "drop_database" ? t("确认删除") : t("执行")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-12 text-fg-muted">
        {target.mode !== "drop_database" && (
          <Field label={target.mode === "save_view" ? t("视图名称") : t("数据库名称")}>
            <input
              autoFocus
              className={fieldClass}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setPreview(null);
              }}
              placeholder={target.mode === "save_view" ? "v_orders" : "analytics"}
            />
          </Field>
        )}
        {target.mode === "create_database" && (
          <Field label={t("字符集")}>
            <input
              className={fieldClass}
              value={charset}
              onChange={(event) => {
                setCharset(event.target.value);
                setPreview(null);
              }}
            />
          </Field>
        )}
        {target.mode === "save_view" && (
          <Field label={t("视图定义（SELECT）")}>
            <textarea
              className={`${fieldClass} min-h-[140px] font-mono`}
              value={selectSql}
              onChange={(event) => {
                setSelectSql(event.target.value);
                setPreview(null);
              }}
            />
          </Field>
        )}
        {preview?.warning && (
          <p className="rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            {preview.warning}
          </p>
        )}
        {preview && (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-[6px] border border-line bg-surface-2 p-2 font-mono text-11 text-fg">
            {preview.sql}
          </pre>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Modal>
  );
}
