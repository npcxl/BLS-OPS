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
import type { DbTable } from "@/api/types/database";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";

export interface ObjectMenuContext {
  profileId: string;
  connectionName: string;
  database: string;
}

const quote = (name: string) => `\`${name.replace(/`/g, "``")}\``;

export function useObjectMenuBuilder() {
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
    [openStructure, openTable, refreshTableDetail, refreshTables, showDdl, t],
  );
}
