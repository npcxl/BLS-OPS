/**
 * 未实现引擎的"能力与实现状态"面板。
 *
 * 这里的原则只有一条：**不伪装**。
 * 配置能存、能列出、能编辑，但驱动没写就是没写 —— 界面必须说清
 * "保存了什么 / 缺什么 / 验证到哪一步"，而不是给一个点了必失败的"连接"按钮。
 *
 * 数据全部来自 `db_engines_catalog`（Rust 注册表），前端不做任何引擎判断。
 */
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "@/components/icons";
import type {
  CapabilitySet,
  DatabaseProfile,
  EngineDescriptor,
} from "@/api/types/database";
import { cn } from "@/lib/cn";

/** 与 Rust `capability.rs` 的 11 个字段一一对应，顺序按操作流程排。 */
const CAPABILITY_ORDER: (keyof CapabilitySet)[] = [
  "query",
  "multiple_result_sets",
  "cancel",
  "transaction",
  "read_only_enforcement",
  "table_browse",
  "keyset_pagination",
  "table_edit",
  "schema_edit",
  "view_edit",
  "export",
  "export_sql",
];

const CAPABILITY_LABEL: Record<keyof CapabilitySet, string> = {
  query: "执行查询",
  multiple_result_sets: "多结果集",
  cancel: "取消查询",
  transaction: "事务",
  read_only_enforcement: "只读强制",
  table_browse: "浏览表数据",
  keyset_pagination: "键集分页",
  table_edit: "编辑表数据",
  schema_edit: "修改表结构",
  view_edit: "编辑视图",
  export: "按表导出",
  export_sql: "导出自定义 SQL",
};

const STATE_LABEL = {
  supported: "支持",
  limited: "受限",
  unsupported: "未支持",
} as const;

export function EngineImplementationPanel({
  profile,
  descriptor,
}: {
  profile: DatabaseProfile;
  descriptor: EngineDescriptor | null;
}) {
  const { t } = useTranslation();
  const capabilities = descriptor?.capabilities;
  const verified = descriptor?.verified?.[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-content px-5 py-4">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <header className="flex items-start gap-3">
          <TriangleAlert size={20} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h2 className="text-14 font-medium text-fg">
              {t("{{engine}} 的驱动尚未实现", {
                engine: descriptor?.product ?? profile.engine,
              })}
            </h2>
            <p className="mt-1 text-12 leading-relaxed text-fg-muted">
              {t(
                "连接配置已经保存，可以随时编辑；但当前版本没有该引擎的真实驱动，因此不会建立连接、也不会执行任何 SQL。配置不会被删除。",
              )}
            </p>
          </div>
        </header>

        <section className="rounded-[10px] border border-divider/80 bg-inspector">
          <div className="border-b border-divider/60 px-3 py-2 text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
            {t("已保存的配置")}
          </div>
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 py-2.5 text-12">
            <dt className="text-fg-subtle">{t("主机")}</dt>
            <dd className="min-w-0 truncate text-fg">
              {profile.host ? `${profile.host}:${profile.port}` : t("（文件型 / 无主机）")}
            </dd>
            <dt className="text-fg-subtle">{t("数据库")}</dt>
            <dd className="min-w-0 truncate text-fg">
              {profile.default_database || t("未指定")}
            </dd>
            <dt className="text-fg-subtle">{t("用户名")}</dt>
            <dd className="min-w-0 truncate text-fg">{profile.username || t("未指定")}</dd>
            <dt className="text-fg-subtle">{t("实现状态")}</dt>
            <dd className="text-fg">
              {descriptor?.implementation === "implemented"
                ? t("已实现")
                : t("仅配置（无驱动）")}
            </dd>
            <dt className="text-fg-subtle">{t("验证等级")}</dt>
            <dd className="text-fg">
              {verified
                ? `${verified.level} · ${verified.notes || verified.versions}`
                : t("未验证")}
            </dd>
          </dl>
        </section>

        <section className="rounded-[10px] border border-divider/80 bg-inspector">
          <div className="flex items-center justify-between border-b border-divider/60 px-3 py-2">
            <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
              {t("能力矩阵")}
            </span>
            <span className="text-10 text-fg-subtle">
              {t("来自引擎注册表，前端不做引擎判断")}
            </span>
          </div>
          <ul className="divide-y divide-divider/50">
            {CAPABILITY_ORDER.map((key) => {
              const entry = capabilities?.[key];
              const state = entry?.state ?? "unsupported";
              return (
                <li key={key} className="flex items-start gap-3 px-3 py-1.5 text-12">
                  <span className="w-[110px] shrink-0 text-fg-muted">
                    {t(CAPABILITY_LABEL[key])}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-[4px] px-1.5 text-10 leading-4",
                      state === "supported"
                        ? "bg-success/15 text-success"
                        : state === "limited"
                          ? "bg-warning/15 text-warning"
                          : "bg-surface-2 text-fg-subtle",
                    )}
                  >
                    {t(STATE_LABEL[state])}
                  </span>
                  <span className="min-w-0 flex-1 text-11 leading-relaxed text-fg-subtle">
                    {entry && entry.state !== "supported" ? entry.reason : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {descriptor?.note && (
          <p className="text-11 leading-relaxed text-fg-subtle">{descriptor.note}</p>
        )}

        {/* 被移出新建列表的产品（SQL Server / MongoDB 等）在这里说清"为什么
            列表里没有它"，否则老用户会以为是产品被删了。 */}
        {descriptor?.entry.state === "hidden" && (
          <p className="text-11 leading-relaxed text-fg-subtle">
            {t("该类型已移出新建连接列表：{{reason}}", {
              reason: t(descriptor.entry.reason),
            })}
          </p>
        )}

        <p className="text-11 leading-relaxed text-fg-subtle">
          {t(
            "后续计划：补齐该引擎的真实驱动后，这张表会逐项变为「支持」，届时才开放连接与查询。",
          )}
        </p>
      </div>
    </div>
  );
}
