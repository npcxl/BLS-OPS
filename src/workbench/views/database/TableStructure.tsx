/** 表结构：字段（类型 / NULL / 默认值 / 主键 / 自增）、索引、表定义。 */
import { useTranslation } from "react-i18next";
import { KeyRound, Loader2 } from "lucide-react";
import type { DbTableDetail } from "@/api/types/database";
import { cn } from "@/lib/cn";

export function TableStructure({
  detail,
  loading,
}: {
  detail: DbTableDetail | null;
  loading: boolean;
}) {
  const { t } = useTranslation();

  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-12 text-fg-subtle">
        <Loader2 size={14} className="animate-spin" />
        {t("加载表结构…")}
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center text-12 text-fg-subtle">
        {t("没有表结构信息")}
      </div>
    );
  }

  return (
    <div className="ops-scroll h-full overflow-y-auto p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-11 text-fg-muted">
        <span>
          {t("类型")}: {detail.kind === "view" ? t("视图") : t("表")}
        </span>
        <span>
          {t("引擎")}: {detail.engine ?? "—"}
        </span>
        <span>
          {t("估算行数")}:{" "}
          {detail.estimated_rows !== null
            ? `${detail.estimated_rows.toLocaleString()}（information_schema 估算）`
            : t("未知")}
        </span>
        <span>
          {t("可安全定位")}: {detail.reliable_key ? detail.reliable_key.join(", ") : t("否")}
        </span>
      </div>

      <section className="mb-4">
        <h3 className="mb-1 text-12 font-medium text-fg">
          {t("字段（{{count}}）", { count: detail.columns.length })}
        </h3>
        <div className="overflow-hidden rounded-[8px] border border-line">
          <table className="w-full border-collapse text-11">
            <thead className="bg-surface-2 text-fg-subtle">
              <tr>
                <th className="px-2 py-1 text-left font-medium">#</th>
                <th className="px-2 py-1 text-left font-medium">{t("名称")}</th>
                <th className="px-2 py-1 text-left font-medium">{t("类型")}</th>
                <th className="px-2 py-1 text-left font-medium">NULL</th>
                <th className="px-2 py-1 text-left font-medium">{t("默认值")}</th>
                <th className="px-2 py-1 text-left font-medium">{t("键")}</th>
                <th className="px-2 py-1 text-left font-medium">{t("注释")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.columns.map((column) => (
                <tr key={column.name} className="border-t border-line/60">
                  <td className="px-2 py-1 text-fg-subtle">{column.ordinal}</td>
                  <td className="px-2 py-1 font-mono text-fg">
                    <span className="inline-flex items-center gap-1">
                      {column.primary_key && <KeyRound size={9} className="text-accent" />}
                      {column.name}
                    </span>
                  </td>
                  <td className="px-2 py-1 font-mono text-fg-muted">{column.column_type}</td>
                  <td className="px-2 py-1 text-fg-muted">{column.nullable ? "YES" : "NO"}</td>
                  <td className="max-w-[220px] truncate px-2 py-1 font-mono text-fg-muted" title={column.default_value ?? ""}>
                    {column.default_expression
                      ? `${column.default_expression} (表达式)`
                      : column.default_value === null
                        ? "NULL"
                        : column.default_value === ""
                          ? "\"\""
                          : column.default_value}
                  </td>
                  <td className="px-2 py-1 text-fg-muted">
                    {[
                      column.primary_key ? "PK" : null,
                      column.auto_increment ? "AUTO" : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || "—"}
                  </td>
                  <td className="max-w-[260px] truncate px-2 py-1 text-fg-subtle" title={column.comment}>
                    {column.comment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-4">
        <h3 className="mb-1 text-12 font-medium text-fg">{t("索引")}</h3>
        {detail.indexes.length === 0 ? (
          <p className="text-11 text-fg-subtle">{t("没有索引")}</p>
        ) : (
          <div className="flex flex-col gap-1">
            {detail.indexes.map((index) => (
              <div
                key={index.name}
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-[6px] border border-line px-2 py-1 text-11",
                  index.primary && "border-accent/30 bg-accent/5",
                )}
              >
                <span className="font-mono text-fg">{index.name}</span>
                {index.primary && (
                  <span className="rounded bg-accent/15 px-1 text-[9px] text-accent">PRIMARY</span>
                )}
                {index.unique && !index.primary && (
                  <span className="rounded bg-surface-2 px-1 text-[9px] text-fg-subtle">UNIQUE</span>
                )}
                <span className="text-[10px] text-fg-subtle">{index.kind}</span>
                <span className="font-mono text-[10px] text-fg-muted">
                  ({index.columns
                    .map(
                      (column) =>
                        `${column.name}${column.sub_part ? `(${column.sub_part})` : ""}${
                          column.direction === "desc" ? " DESC" : ""
                        }`,
                    )
                    .join(", ")})
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {detail.create_sql && (
        <section>
          <h3 className="mb-1 text-12 font-medium text-fg">{t("表定义")}</h3>
          <pre className="ops-scroll max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-[8px] border border-line bg-surface-2/50 p-2 font-mono text-[10px] text-fg-muted">
            {detail.create_sql}
          </pre>
        </section>
      )}
    </div>
  );
}
