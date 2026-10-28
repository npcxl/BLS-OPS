/**
 * 表 / 视图的公共右键动作。
 *
 * 左侧资产树和中央对象列表必须调用同一份定义，否则同一个表在两个位置
 * 会出现不同的操作。这里只放"打开/复制/刷新"这类无副作用动作；
 * 重命名、删除、清空等破坏性操作等有统一确认与执行闭环后再加。
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import type { DbTable, TableOperationKind } from "@/api/types/database";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

export interface ObjectMenuContext {
  profileId: string;
  connectionName: string;
  database: string;
}

const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;

export type ObjectTableOperation = Extract<
  TableOperationKind,
  "rename" | "copy_structure" | "copy_data" | "drop" | "truncate"
>;

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
  const refreshTableDetail = useDatabaseStore(
    (state) => state.refreshTableDetail,
  );
  const refreshTables = useDatabaseStore((state) => state.refreshTables);

  return useCallback(
    (context: ObjectMenuContext, table: DbTable): ContextMenuItem[] => [
      {
        id: "data",
        label: t("打开数据"),
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
                onSelect: () => onTableOperation(context, table, "rename"),
              },
              {
                id: "copy-structure",
                label: t("复制表结构"),
                onSelect: () =>
                  onTableOperation(context, table, "copy_structure"),
              },
              {
                id: "copy-data",
                label: t("复制表结构和数据"),
                onSelect: () => onTableOperation(context, table, "copy_data"),
              },
              { separator: true as const },
              {
                id: "truncate",
                label: t("清空表"),
                danger: true,
                onSelect: () => onTableOperation(context, table, "truncate"),
              },
              {
                id: "drop",
                label: t("删除表"),
                danger: true,
                onSelect: () => onTableOperation(context, table, "drop"),
              },
            ]
          : [
              ...(onEditView
                ? [
                    {
                      id: "edit-view",
                      label: t("编辑视图定义"),
                      onSelect: () => onEditView(context, table),
                    },
                  ]
                : []),
              {
                id: "rename-view",
                label: t("重命名视图"),
                onSelect: () => onTableOperation(context, table, "rename"),
              },
              {
                id: "drop-view",
                label: t("删除视图"),
                danger: true,
                onSelect: () => onTableOperation(context, table, "drop"),
              },
            ]
        : []),
      { separator: true },
      {
        id: "copy-name",
        label: t("复制名称"),
        onSelect: () => void copyText(table.name),
      },
      {
        id: "copy-select",
        label: t("复制 SELECT"),
        onSelect: () =>
          void copyText(
            `SELECT * FROM ${quote(context.database)}.${quote(table.name)} LIMIT 200;`,
          ),
      },
      { separator: true },
      {
        id: "refresh",
        label: t("刷新"),
        onSelect: () => {
          void refreshTableDetail(
            context.profileId,
            context.database,
            table.name,
          );
          void refreshTables(context.profileId, context.database);
        },
      },
    ],
    [
      onEditView,
      onTableOperation,
      openStructure,
      openTable,
      refreshTableDetail,
      refreshTables,
      showDdl,
      t,
    ],
  );
}
