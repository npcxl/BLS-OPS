/**
 * 表 / 视图的公共右键动作。
 *
 * 左侧资产树和中央对象列表必须调用同一份定义，否则同一个表在两个位置
 * 会出现不同的操作。这里只放"打开/复制/刷新"这类无副作用动作，
 * 破坏性操作统一交给 `onTableOperation`（确认弹窗留在来源窗口）。
 *
 * # 能力判定
 *
 * **不用 `schema_edit` 一个开关代表所有 DDL**：同一个引擎常常"能建表、
 * 不能复制表"（SQLite）。每一项读 `ddl_operations` 里的独立声明，禁用原因
 * 直接取同一份 `reason` —— 与主窗口横幅、后端 `table_ops` 校验完全一致。
 *
 * # SQL 生成
 *
 * 「复制 SELECT」按连接的 `dialect_rules` 引用标识符，不再硬编码反引号：
 * PostgreSQL / SQLite 上用反引号会复制出一段非法 SQL。
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  Copy,
  CopyPlus,
  Eraser,
  FileCode2,
  FileText,
  Pencil,
  RefreshCw,
  ScrollText,
  Table2,
  Trash2,
} from "@/components/icons";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import type {
  Capability,
  DbTable,
  DdlCapabilities,
  EngineDescriptor,
  TableOperationKind,
} from "@/api/types/database";
import { copyTextWithFeedback as copyText } from "@/lib/clipboard-feedback";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { capabilityAllows, engineMeta } from "./db-engines";
import { quoteIdentifierWith, type SqlQuoteRules } from "./grid/copy-format";

export interface ObjectMenuContext {
  profileId: string;
  connectionName: string;
  database: string;
}

/** 拿不到注册表时的兜底：MySQL 反引号，与改造前行为一致。 */
const FALLBACK_QUOTE: SqlQuoteRules = { identifier_quote: "backtick", backslash_escapes: true };

export type ObjectTableOperation = Extract<
  TableOperationKind,
  "rename" | "copy_structure" | "copy_data" | "drop" | "truncate"
>;

/** 「复制 SELECT」：按方言引用库名与表名。 */
export function buildSelectSql(
  context: Pick<ObjectMenuContext, "database">,
  table: Pick<DbTable, "name">,
  rules: SqlQuoteRules = FALLBACK_QUOTE,
): string {
  const quote = (name: string) => quoteIdentifierWith(name, rules);
  return `SELECT * FROM ${quote(context.database)}.${quote(table.name)} LIMIT 200;`;
}

function quoteRulesOf(descriptor: EngineDescriptor | null): SqlQuoteRules {
  const rules = descriptor?.dialect_rules;
  if (!rules) return FALLBACK_QUOTE;
  return {
    identifier_quote: rules.identifier_quote,
    backslash_escapes: rules.backslash_escapes,
  };
}

/** 一项 DDL 能力 → 菜单项的 `disabled` / `reason`。 */
export function ddlOperationState(capability: Capability | undefined): {
  blocked: boolean;
  reason: string | undefined;
} {
  if (!capability) return { blocked: true, reason: undefined };
  if (capability.state === "supported") return { blocked: false, reason: undefined };
  // limited 仍然可用，但把边界写出来（和主窗口横幅读的是同一句）。
  return { blocked: capability.state === "unsupported", reason: capability.reason };
}

export function useObjectMenuBuilder(
  onTableOperation?: (
    context: ObjectMenuContext,
    table: DbTable,
    kind: ObjectTableOperation,
  ) => void,
  onEditView?: (context: ObjectMenuContext, table: DbTable) => void,
) {
  const { t } = useTranslation();
  const openTable = useDatabaseWorkspaceStore((state) => state.openTable);
  const openStructure = useDatabaseWorkspaceStore((state) => state.openStructure);
  const showDdl = useDatabaseWorkspaceStore((state) => state.showDdl);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const refreshTables = useDatabaseStore((state) => state.refreshTables);
  // 引擎能力从注册表取：菜单只决定"给不给点"，不在前端写引擎名单。
  const profiles = useDatabaseStore((state) => state.profiles);

  return useCallback(
    (context: ObjectMenuContext, table: DbTable): ContextMenuItem[] => {
      const descriptor: EngineDescriptor | null = engineMeta(
        profiles.find((profile) => profile.id === context.profileId)?.engine ?? "",
      ).descriptor;
      const ddl: DdlCapabilities | undefined = descriptor?.ddl_operations;
      // 浏览与结构共用同一条元数据链路：链路没接，两个入口一起禁用，
      // 而不是让用户点进去看到一条空表或 "unsupported" 报错。
      const browseBlocked = !capabilityAllows(descriptor, "table_browse");
      const browseReason = browseBlocked ? t("该引擎暂不支持浏览表数据") : undefined;
      const rename = ddlOperationState(ddl?.rename_table);
      const copyTable = ddlOperationState(ddl?.copy_table);
      const truncate = ddlOperationState(ddl?.truncate_table);
      const dropTable = ddlOperationState(ddl?.drop_table);
      const createView = ddlOperationState(ddl?.create_view);
      const dropView = ddlOperationState(ddl?.drop_view);
      const quoteRules = quoteRulesOf(descriptor);

      return [
        {
          id: "data",
          label: t("打开数据"),
          icon: Table2,
          disabled: browseBlocked,
          reason: browseReason,
          onSelect: () =>
            openTable({
              profileId: context.profileId,
              connectionName: context.connectionName,
              database: context.database,
              table: table.name,
            }),
        },
        {
          id: "structure",
          label: t("打开结构"),
          icon: Columns3,
          disabled: browseBlocked,
          reason: browseReason,
          onSelect: () =>
            openStructure({
              profileId: context.profileId,
              connectionName: context.connectionName,
              database: context.database,
              table: table.name,
            }),
        },
        {
          id: "ddl",
          label: t("查看 DDL"),
          icon: FileCode2,
          // DDL 依赖表定义（`create_sql`），它和结构浏览同一条链路。
          disabled: browseBlocked,
          reason: browseReason,
          onSelect: () =>
            showDdl({
              profileId: context.profileId,
              database: context.database,
              table: table.name,
            }),
        },
        ...(onTableOperation
          ? table.kind === "table"
            ? [
                { separator: true as const },
                {
                  id: "rename",
                  label: t("重命名表"),
                  icon: Pencil,
                  disabled: rename.blocked,
                  reason: rename.reason,
                  onSelect: () => onTableOperation(context, table, "rename"),
                },
                {
                  id: "copy-structure",
                  label: t("复制表结构"),
                  icon: Copy,
                  disabled: copyTable.blocked,
                  reason: copyTable.reason,
                  onSelect: () => onTableOperation(context, table, "copy_structure"),
                },
                {
                  id: "copy-data",
                  label: t("复制表结构和数据"),
                  icon: CopyPlus,
                  disabled: copyTable.blocked,
                  reason: copyTable.reason,
                  onSelect: () => onTableOperation(context, table, "copy_data"),
                },
                { separator: true as const },
                {
                  id: "truncate",
                  label: t("清空表"),
                  icon: Eraser,
                  danger: true,
                  disabled: truncate.blocked,
                  reason: truncate.reason,
                  onSelect: () => onTableOperation(context, table, "truncate"),
                },
                {
                  id: "drop",
                  label: t("删除表"),
                  icon: Trash2,
                  danger: true,
                  disabled: dropTable.blocked,
                  reason: dropTable.reason,
                  onSelect: () => onTableOperation(context, table, "drop"),
                },
              ]
            : [
                ...(onEditView
                  ? [
                      {
                        id: "edit-view",
                        label: t("编辑视图定义"),
                        icon: FileText,
                        disabled: createView.blocked,
                        reason: createView.reason,
                        onSelect: () => onEditView(context, table),
                      },
                    ]
                  : []),
                {
                  id: "rename-view",
                  label: t("重命名视图"),
                  icon: Pencil,
                  // 视图重命名与 `CREATE OR REPLACE VIEW` 同一条链路。
                  disabled: createView.blocked,
                  reason: createView.reason,
                  onSelect: () => onTableOperation(context, table, "rename"),
                },
                {
                  id: "drop-view",
                  label: t("删除视图"),
                  icon: Trash2,
                  danger: true,
                  disabled: dropView.blocked,
                  reason: dropView.reason,
                  onSelect: () => onTableOperation(context, table, "drop"),
                },
              ]
          : []),
        { separator: true },
        {
          id: "copy-name",
          label: t("复制名称"),
          icon: Copy,
          onSelect: () => void copyText(table.name),
        },
        {
          id: "copy-select",
          label: t("复制 SELECT"),
          icon: ScrollText,
          onSelect: () => void copyText(buildSelectSql(context, table, quoteRules)),
        },
        { separator: true },
        {
          id: "refresh",
          label: t("刷新"),
          icon: RefreshCw,
          onSelect: () => {
            void refreshTableDetail(context.profileId, context.database, table.name);
            void refreshTables(context.profileId, context.database);
          },
        },
      ];
    },
    [
      onEditView,
      onTableOperation,
      openStructure,
      openTable,
      profiles,
      refreshTableDetail,
      refreshTables,
      showDdl,
      t,
    ],
  );
}
