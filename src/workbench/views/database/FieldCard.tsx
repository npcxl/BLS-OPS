/**
 * 结构页点击字段后显示的右侧信息卡片。
 *
 * 只读：字段类型、NULL、默认值、主键/自增、注释、字符集，以及包含
 * 该列的索引。宽度由 `DatabaseView` 根据是否全屏决定（全屏浮在
 * "已打开"列表左侧，不压缩中央数据区）。
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Copy, KeyRound, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import {
  useDatabaseWorkspaceStore,
  type FieldCardTarget,
} from "@/stores/database-workspace-store";

export function FieldCard({ target }: { target: FieldCardTarget }) {
  const { t } = useTranslation();
  const detailKey = `${target.profileId}\u0001${target.database}\u0001${target.table}`;
  const detail = useDatabaseStore((state) => state.details[detailKey] ?? null);
  const loading = useDatabaseStore((state) => state.loading[detailKey] ?? false);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const hideFieldCard = useDatabaseWorkspaceStore((state) => state.hideFieldCard);

  useEffect(() => {
    if (!detail) {
      void refreshTableDetail(target.profileId, target.database, target.table);
    }
  }, [detail, refreshTableDetail, target.database, target.profileId, target.table]);

  const column = detail?.columns.find((entry) => entry.name === target.column) ?? null;
  const indexes =
    detail?.indexes.filter((index) =>
      index.columns.some((entry) => entry.name === target.column),
    ) ?? [];

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-line bg-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="min-w-0 flex-1 truncate text-12 font-medium text-fg">
          {target.column}
        </span>
        <Button
          variant="ghost"
          size="xs"
          onClick={() => void copyText(target.column)}
          title={t("复制字段名")}
        >
          <Copy size={11} />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={hideFieldCard}
          title={t("关闭字段信息")}
        >
          <X size={11} />
        </Button>
      </div>
      <div className="shrink-0 border-b border-line px-2 py-1 text-10 text-fg-subtle">
        {target.database}.{target.table}
      </div>

      <div className="ops-scroll min-h-0 flex-1 overflow-y-auto p-2">
        {loading && !column ? (
          <div className="flex items-center gap-2 text-12 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("加载字段信息…")}
          </div>
        ) : !column ? (
          <p className="text-12 text-fg-subtle">{t("字段不存在或已被修改")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-1.5 text-12 text-fg">
              {column.primary_key && <KeyRound size={12} className="text-accent" />}
              <span className="font-mono">{column.name}</span>
              {column.primary_key && (
                <span className="rounded bg-accent/15 px-1 text-10 text-accent">PK</span>
              )}
              {column.auto_increment && (
                <span className="rounded bg-surface-2 px-1 text-10 text-fg-subtle">
                  AUTO
                </span>
              )}
            </div>

            <dl className="grid grid-cols-[72px_1fr] gap-y-1.5 text-11">
              <dt className="text-fg-subtle">{t("类型")}</dt>
              <dd className="break-all font-mono text-fg">{column.column_type}</dd>
              <dt className="text-fg-subtle">NULL</dt>
              <dd className="text-fg">{column.nullable ? t("允许") : t("不允许")}</dd>
              <dt className="text-fg-subtle">{t("默认值")}</dt>
              <dd className="break-all font-mono text-fg">
                {column.default_expression
                  ? `${column.default_expression} (${t("表达式")})`
                  : column.default_value === null
                    ? "NULL"
                    : column.default_value === ""
                      ? '""'
                      : column.default_value}
              </dd>
              <dt className="text-fg-subtle">{t("字符集")}</dt>
              <dd className="break-all text-fg">{column.charset ?? "—"}</dd>
              <dt className="text-fg-subtle">{t("排序规则")}</dt>
              <dd className="break-all text-fg">{column.collation ?? "—"}</dd>
              <dt className="text-fg-subtle">{t("位置")}</dt>
              <dd className="text-fg">#{column.ordinal}</dd>
              <dt className="text-fg-subtle">{t("注释")}</dt>
              <dd className="break-words text-fg">{column.comment || "—"}</dd>
            </dl>

            <div>
              <p className="mb-1 text-11 font-medium text-fg-muted">{t("所在索引")}</p>
              {indexes.length === 0 ? (
                <p className="text-11 text-fg-subtle">{t("没有索引包含该字段")}</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {indexes.map((index) => (
                    <div
                      key={index.name}
                      className="rounded-[6px] border border-line px-2 py-1 text-11"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-fg">{index.name}</span>
                        {index.primary && (
                          <span className="rounded bg-accent/15 px-1 text-10 text-accent">
                            PRIMARY
                          </span>
                        )}
                        {index.unique && !index.primary && (
                          <span className="rounded bg-surface-2 px-1 text-10 text-fg-subtle">
                            UNIQUE
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 font-mono text-10 text-fg-subtle">
                        ({index.columns.map((entry) => entry.name).join(", ")})
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

    </aside>
  );
}
