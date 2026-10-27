/**
 * CSV 导出对话框。
 *
 * - 前端只收进度（轮询 `db_export_status`），**从不接收导出数据**；
 * - 明确提示"重新查询导出，数据可能已变化"；
 * - 导出 SQL 必须是只读语句（后端拒绝重执行 INSERT/UPDATE/DELETE）；
 * - 只有 `completed` 才显示最终路径；取消/失败会删除临时文件。
 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, FolderOpen, Loader2, Square, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorText, Field, Modal, fieldClass } from "@/components/ui/modal";
import { databaseApi } from "@/api/ops-api";
import type {
  BrowseFilter,
  BrowseSort,
  ExportOutcome,
  ExportProgress,
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
  const [maxRows, setMaxRows] = useState(0);
  const [bom, setBom] = useState(true);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => stopPolling, []);

  const browse = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({
        title: t("导出 CSV"),
        defaultPath: path || "export.csv",
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (chosen) setPath(chosen);
    } catch {
      // 用户取消或对话框不可用：保留手填路径。
    }
  };

  const start = async () => {
    if (!path.trim()) {
      setError(t("请选择导出文件路径"));
      return;
    }
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const started = await databaseApi.exportStart(profileId, {
        profile_id: profileId,
        sql: table ? "" : sql,
        database: table?.database ?? null,
        target_path: path.trim(),
        table: table ? { database: table.database, table: table.table } : null,
        filters: table?.filters ?? null,
        sorts: table?.sorts ?? null,
        bom,
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
              setBusy(false);
              const final = await databaseApi.exportOutcome(started.export_id);
              setOutcome(final);
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
      title={title ?? t("导出 CSV")}
      description={
        table
          ? t("按当前过滤与排序重新查询整张表并流式写盘。")
          : t("导出会重新执行这条只读 SQL：数据可能已与页面显示不同。")
      }
      width={520}
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
      <div className="flex flex-col gap-3">
        <Field label={t("保存到")}>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input
              className={fieldClass}
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="C:\\exports\\orders.csv"
            />
            <Button variant="ghost" size="sm" onClick={() => void browse()}>
              <FolderOpen size={12} />
              {t("浏览…")}
            </Button>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label={t("最多行数（0 = 不限制）")} hint={t("达到上限会提前结束并提示")}>
            <input
              className={fieldClass}
              type="number"
              min={0}
              value={maxRows}
              onChange={(event) => setMaxRows(Math.max(0, Number(event.target.value) || 0))}
            />
          </Field>
          <label className="mt-5 flex items-center gap-1.5 text-11 text-fg-muted">
            <input
              type="checkbox"
              checked={bom}
              onChange={(event) => setBom(event.target.checked)}
            />
            {t("UTF-8 BOM（Excel 打开中文更稳）")}
          </label>
        </div>

        <div className="rounded-[8px] border border-line bg-surface-2/50 px-2 py-1.5 text-[10px] leading-relaxed text-fg-subtle">
          {t(
            "NULL 导出为空字段，空字符串导出为 \"\"；含逗号/引号/换行的值会被引号包裹。写入临时文件成功后才改名为目标文件。",
          )}
        </div>

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
              <span className="ml-auto text-[10px] text-fg-subtle">
                {progress.rows.toLocaleString()} {t("行")} ·{" "}
                {(progress.bytes / 1024 / 1024).toFixed(2)} MiB
              </span>
            </div>
            {progress.message && (
              <p className="mt-1 break-words text-[10px] text-fg-subtle">
                {progress.message}
              </p>
            )}
            {outcome?.state === "completed" && outcome.path && (
              <p className="mt-1 break-all text-[10px] text-success">{outcome.path}</p>
            )}
            {outcome?.error && (
              <p className="mt-1 flex items-start gap-1 text-[10px] text-danger">
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
