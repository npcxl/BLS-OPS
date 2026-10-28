/**
 * 关闭工作项前的统一协调：草稿、待提交修改、运行中的查询、未提交事务。
 *
 * 这里的动作是**明确的**：
 * - 丢弃并关闭 / 取消查询并关闭；
 * - 提交事务并关闭 / 回滚事务并关闭（事务属于会话，不是工作项）；
 * - 取消关闭。
 *
 * 绝不在关闭时"顺手"提交事务或应用表格修改。
 */
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useDatabaseStore } from "@/stores/database-store";
import {
  useDatabaseWorkspaceStore,
  type WorkItem,
} from "@/stores/database-workspace-store";

export type CloseAction =
  | "discard"
  | "cancel-query"
  | "commit"
  | "rollback";

export function CloseWorkItemDialog({
  item,
  onCancel,
  onConfirm,
}: {
  item: WorkItem | null;
  onCancel: () => void;
  onConfirm: (action: CloseAction) => void;
}) {
  const { t } = useTranslation();
  const session = useDatabaseStore((state) =>
    item ? state.sessions[item.profileId] : undefined,
  );
  const tab = useDatabaseWorkspaceStore((state) =>
    item ? state.items.find((entry) => entry.id === item.id) : undefined,
  );

  const running = tab?.running ?? false;
  const pending = tab?.pendingCount ?? 0;
  const dirty = tab?.dirty ?? false;
  const transaction = session?.transaction;
  const inTransaction =
    transaction === "in_transaction" || transaction === "in_transaction_read_only";

  return (
    <Modal
      open={item !== null}
      title={t("关闭「{{name}}」", { name: item?.title ?? "" })}
      description={t("关闭前会检查未保存的草稿、待提交修改、运行中的查询和未提交事务。")}
      width={460}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("取消关闭")}
          </Button>
          {inTransaction && (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onConfirm("rollback")}
              >
                {t("回滚事务并关闭")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onConfirm("commit")}
              >
                {t("提交事务并关闭")}
              </Button>
            </>
          )}
          {!inTransaction && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => onConfirm(running ? "cancel-query" : "discard")}
            >
              {running ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  {t("取消查询并关闭")}
                </>
              ) : dirty ? (
                t("丢弃草稿并关闭")
              ) : (
                t("丢弃修改并关闭")
              )}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2 text-12 text-fg-muted">
        {running && (
          <p className="flex items-start gap-2 rounded-[6px] border border-accent/30 bg-accent/5 px-2 py-1.5">
            <Loader2 size={13} className="mt-0.5 shrink-0 animate-spin text-accent" />
            {t("这个工作项里的查询仍在执行。关闭会先发送取消请求。")}
          </p>
        )}
        {pending > 0 && (
          <p className="flex items-start gap-2 rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t("有 {{count}} 项修改尚未执行到数据库，关闭会丢弃它们。", {
              count: pending,
            })}
          </p>
        )}
        {dirty && (
          <p className="flex items-start gap-2 rounded-[6px] border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t("SQL 草稿尚未保存，关闭会丢弃这份草稿。")}
          </p>
        )}
        {inTransaction && (
          <p className="flex items-start gap-2 rounded-[6px] border border-danger/30 bg-danger/5 px-2 py-1.5 text-danger">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t(
              "当前连接还有未提交事务。事务属于连接而不是工作项：关闭工作项不会自动提交，必须明确选择提交或回滚。",
            )}
          </p>
        )}
        {!running && pending === 0 && !dirty && !inTransaction && (
          <p className="flex items-center gap-2 text-fg-subtle">
            <X size={12} />
            {t("没有未保存内容，可以安全关闭。")}
          </p>
        )}
      </div>
    </Modal>
  );
}
