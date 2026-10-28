/**
 * 批量关闭（关闭其他）的协调器。
 *
 * 和单项关闭一样，不能在 store 里直接 filter 掉：
 * 运行中的查询、待提交修改、未保存草稿都必须先汇总再确认。
 */
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { WorkItem } from "@/stores/database-workspace-store";

export function CloseWorkItemsDialog({
  items,
  onCancel,
  onConfirm,
}: {
  items: WorkItem[] | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const list = items ?? [];
  const running = list.filter((item) => item.running).length;
  const pending = list.reduce((sum, item) => sum + item.pendingCount, 0);
  const dirty = list.filter((item) => item.dirty).length;

  return (
    <Modal
      open={list.length > 0}
      title={t("关闭其他工作项")}
      description={t("当前工作项会保留；其余项目在关闭前会检查运行中的查询、待提交修改和未保存草稿。")}
      width={480}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("取消关闭")}
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            {running > 0 ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                {t("取消查询并关闭")}
              </>
            ) : (
              t("丢弃修改并关闭")
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-12 text-fg-muted">
        <p>{t("将关闭 {{count}} 项。", { count: list.length })}</p>
        {running > 0 && (
          <p className="flex items-start gap-2 rounded-[6px] border border-accent/30 bg-accent/5 px-2 py-1.5">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />
            {t("其中 {{count}} 项仍在执行查询，关闭会先发送取消请求。", {
              count: running,
            })}
          </p>
        )}
        {pending > 0 && (
          <p className="flex items-start gap-2 rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t("其中包含 {{count}} 项尚未应用的表格修改，关闭会丢弃它们。", {
              count: pending,
            })}
          </p>
        )}
        {dirty > 0 && (
          <p className="flex items-start gap-2 rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t("其中 {{count}} 项有未保存的 SQL 草稿，关闭会丢弃草稿。", {
              count: dirty,
            })}
          </p>
        )}
        <div className="max-h-40 overflow-y-auto rounded-[6px] border border-line">
          {list.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 border-b border-line/60 px-2 py-1 text-11 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-fg">{item.title}</span>
              {item.running && <span className="text-accent">{t("运行中")}</span>}
              {item.pendingCount > 0 && (
                <span className="text-warning">
                  {t("待修改 {{count}}", { count: item.pendingCount })}
                </span>
              )}
              {item.dirty && <span className="text-warning">{t("草稿未保存")}</span>}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
