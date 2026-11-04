/**
 * Streaming data export dialog.
 *
 * - 前端只收进度（轮询 `db_export_status`），**从不接收导出数据**；
 * - 明确提示"重新查询导出，数据可能已变化"；
 * - 导出 SQL 必须是只读语句（后端拒绝重执行 INSERT/UPDATE/DELETE）；
 * - 只有 `completed` 才显示最终路径；取消/失败会删除临时文件。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, FolderOpen, Loader2, Square, TriangleAlert } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { MacSwitch } from "@/components/ui/mac-controls";
import { EXPORT_FORMATS, exportFileName } from "./export-formats";
import "./export-dialog.css";
import { pushToast } from "@/components/ui/toast";
import { databaseApi } from "@/api/ops-api";
import type {
  BrowseFilter,
  BrowseSort,
  ExportOutcome,
  ExportProgress,
  ExportFormat,
} from "@/api/types/database";
import { toDbError } from "@/stores/database-store";

export interface ExportTableArgs {
  database: string;
  table: string;
  filters: BrowseFilter[];
  sorts: BrowseSort[];
}

export function ExportDialog({
  open,
  onClose,
  profileId,
  sql,
  table,
  title,
}: {
  open: boolean;
  onClose: () => void;
  profileId: string;
  sql: string;
  table: ExportTableArgs | null;
  title?: string;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [pathAuthorized, setPathAuthorized] = useState(false);
  const [maxRows, setMaxRows] = useState(0);
  const [bom, setBom] = useState(true);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [exportId, setExportId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) {
      stopPolling();
      if (exportId) {
        void databaseApi.exportRemove(exportId).catch(() => undefined);
      }
      setExportId(null);
      setProgress(null);
      setOutcome(null);
      setError(null);
      setBusy(false);
      return;
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace("T", "-")
      .slice(0, 15);
    const base = table ? `${table.table}-${stamp}` : `query-${stamp}`;
    setPath((current) => current || `${base}.csv`);
    // 默认文件名只是提示，真正可写的路径必须由 Rust 侧另存为对话框授权。
    setPathAuthorized(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => stopPolling, []);

  const browse = async () => {
    try {
      const chosen = await databaseApi.pickExportPath(
        path || `export.${format}`, format,
      );
      if (chosen) {
        setPath(chosen);
        setPathAuthorized(true);
      }
    } catch (failure) {
      setError(toDbError(failure).message);
    }
  };

  const start = async () => {
    if (busy) return;
    if (!Number.isSafeInteger(maxRows) || maxRows < 0) {
      setError(t("最多行数必须是有效的非负整数"));
      return;
    }
    if (!path.trim() || !pathAuthorized) {
      setError(t("请选择导出文件路径"));
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    setProgress(null);
    try {
      if (exportId) await databaseApi.exportRemove(exportId);
      const started = await databaseApi.exportStart(profileId, {
        format,
        profile_id: profileId,
        sql: table ? "" : sql,
        database: table?.database ?? null,
        target_path: path.trim(),
        table: table ? { database: table.database, table: table.table } : null,
        filters: table?.filters ?? null,
        sorts: table?.sorts ?? null,
        bom: (format === "csv" || format === "tsv") && bom,
        max_rows: maxRows > 0 ? maxRows : null,
      });
      setExportId(started.export_id);
      setProgress({
        export_id: started.export_id,
        rows: 0,
        bytes: 0,
        state: "running",
        message: null,
        elapsed_ms: 0,
      });

      stopPolling();
      timerRef.current = window.setInterval(() => {
        void (async () => {
          try {
            const current = await databaseApi.exportStatus(started.export_id);
            setProgress(current);
            if (["completed", "cancelled", "failed"].includes(current.state)) {
              stopPolling();
              const final = await databaseApi.exportOutcome(started.export_id);
              setOutcome(final);
              setBusy(false);
              if (final.state === "completed") {
                pushToast(
                  t("导出完成：{{rows}} 行", { rows: final.rows.toLocaleString() }),
                  "success",
                );
              } else if (final.state === "failed") {
                pushToast(final.error?.message ?? t("导出失败"), "error");
              }
            }
          } catch (failure) {
            stopPolling();
            setBusy(false);
            setError(toDbError(failure).message);
          }
        })();
      }, 500);
    } catch (failure) {
      setBusy(false);
      setError(toDbError(failure).message);
    }
  };

  const cancel = async () => {
    if (!exportId) return;
    try {
      await databaseApi.exportCancel(exportId);
    } catch (failure) {
      setError(toDbError(failure).message);
    }
  };

  const terminal = outcome !== null || ["cancelled", "failed"].includes(progress?.state ?? "");

  return (
    <Modal
      open={open}
      title={title ?? t("导出数据")}
      description={table ? `${table.database} / ${table.table}` : t("查询结果")}
      size="lg"
      className="database-export-dialog"
      onClose={busy && !terminal ? undefined : onClose}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy && !terminal}>
            {t("关闭")}
          </Button>
          {progress && !terminal && (
            <Button variant="secondary" size="sm" onClick={() => void cancel()}>
              <Square size={12} />
              {t("取消导出")}
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={busy && !terminal}
            onClick={() => void start()}
          >
            <FileDown size={12} />
            {t("开始导出")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label={t("文件格式")}>
          <Select ariaLabel={t("文件格式")} value={format} disabled={busy}
            options={EXPORT_FORMATS.map(option => ({ ...option, disabled: option.value === "sql" && !table,
              hint: option.value === "sql" && !table ? t("仅表数据") : option.hint }))}
            onChange={value => {
              const next = value as ExportFormat;
              setFormat(next);
              setPath(current => exportFileName(current || "export", next));
              setPathAuthorized(false);
              setOutcome(null);
              setProgress(null);
              setError(null);
            }} />
          <p className="export-format-hint">{t(EXPORT_FORMATS.find(option => option.value === format)!.description)}</p>
        </Field>
        <Field label={t("保存到")}>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              className={fieldClass}
              aria-label={t("保存到")}
              value={path}
              readOnly
              placeholder={t("请选择导出文件路径")}
            />
            <Button variant="secondary" size="md" disabled={busy} onClick={() => void browse()}>
              <FolderOpen size={12} />
              {t("浏览…")}
            </Button>
          </div>
        </Field>

        <section className="export-options" aria-label={t("导出选项")}>
          <Field label={t("最多行数（0 = 不限制）")} hint={t("达到上限会提前结束并提示")}>
            <input
              className={fieldClass}
              type="number"
              min={0}
              step={1}
              disabled={busy}
              value={maxRows}
              onChange={(event) => setMaxRows(Math.max(0, Math.floor(Number(event.target.value) || 0)))}
            />
          </Field>
          {(format === "csv" || format === "tsv") && <div className="export-encoding">
            <div><span>{t("UTF-8 BOM")}</span><p>{t("便于 Excel 识别中文")}</p></div>
            <MacSwitch aria-label={t("UTF-8 BOM")} checked={bom} onChange={setBom} disabled={busy} />
          </div>}
        </section>
        <p className="export-format-hint">{t("按当前筛选与排序重新查询导出，数据可能与页面显示不同。二进制字段以 Base64 保存，SQL 使用数据库二进制字面量。")}</p>

        {error && <ErrorText>{error}</ErrorText>}

        {progress && (
          <div className="rounded-[8px] border border-line px-2 py-2">
            <div className="flex items-center gap-2 text-11 text-fg">
              {!terminal && <Loader2 size={12} className="animate-spin text-accent" />}
              <span>
                {progress.state === "running"
                  ? t("导出中…")
                  : progress.state === "cancelling"
                    ? t("取消中…")
                    : progress.state === "completed"
                      ? t("导出完成")
                      : progress.state === "cancelled"
                        ? t("已取消")
                        : t("导出失败")}
              </span>
              <span className="ml-auto text-11 text-fg-subtle">
                {progress.rows.toLocaleString()} {t("行")} ·{" "}
                {(progress.bytes / 1024 / 1024).toFixed(2)} MiB
              </span>
            </div>
            {progress.message && (
              <p className="mt-1 break-words text-11 text-fg-subtle">
                {progress.message}
              </p>
            )}
            {outcome?.state === "completed" && outcome.path && (
              <p className="mt-1 break-all text-11 text-success">{outcome.path}</p>
            )}
            {outcome?.error && (
              <p className="mt-1 flex items-start gap-1 text-11 text-danger">
                <TriangleAlert size={10} className="mt-0.5 shrink-0" />
                {outcome.error.message}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
