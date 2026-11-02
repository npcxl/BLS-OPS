/**
 * 表 / 视图的公共右键动作。
 *
 * 左侧资产树和中央对象列表必须调用同一份定义，否则同一个表在两个位置
 * 会出现不同的操作。这里只放"打开/复制/刷新"这类无副作用动作；
 * 重命名、删除、清空等破坏性操作等有统一确认与执行闭环后再加。
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
import type { DbTable, EngineDescriptor, TableOperationKind } from "@/api/types/database";
import { copyText } from "@/lib/clipboard";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { capabilityAllows, engineMeta } from "./db-engines";

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
  // 引擎能力从注册表取：菜单只决定"给不给点"，不在前端写引擎名单。
  const profiles = useDatabaseStore((state) => state.profiles);

  return useCallback(
    (context: ObjectMenuContext, table: DbTable): ContextMenuItem[] => {
      const descriptor: EngineDescriptor | null = engineMeta(
        profiles.find((profile) => profile.id === context.profileId)?.engine ?? "",
      ).descriptor;
      // 浏览与结构共用同一条元数据链路：链路没接，两个入口一起禁用，
      // 而不是让用户点进去看到一条空表或 "unsupported" 报错。
      const browseBlocked = !capabilityAllows(descriptor, "table_browse");
      // 菜单里的 hint 只放短标签：完整原因在表页/结构页顶部横幅与能力面板里，
      // 塞进菜单会被截断成一串省略号。
      const browseHint = browseBlocked ? t("未接入") : undefined;
      const schemaBlocked = !capabilityAllows(descriptor, "schema_edit");
      const schemaHint = schemaBlocked ? t("未接入") : undefined;
      const viewBlocked = !capabilityAllows(descriptor, "view_edit");
      const viewHint = viewBlocked ? t("未接入") : undefined;

      return [
      {
        id: "data",
        label: t("打开数据"),
        icon: Table2,
        disabled: browseBlocked,
        hint: browseHint,
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
        hint: browseHint,
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
        hint: browseHint,
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
                disabled: schemaBlocked,
                hint: schemaHint,
                onSelect: () => onTableOperation(context, table, "rename"),
              },
              {
                id: "copy-structure",
                label: t("复制表结构"),
                icon: Copy,
                disabled: schemaBlocked,
                hint: schemaHint,
                onSelect: () =>
                  onTableOperation(context, table, "copy_structure"),
              },
              {
                id: "copy-data",
                label: t("复制表结构和数据"),
                icon: CopyPlus,
                disabled: schemaBlocked,
                hint: schemaHint,
                onSelect: () => onTableOperation(context, table, "copy_data"),
              },
              { separator: true as const },
              {
                id: "truncate",
                label: t("清空表"),
                icon: Eraser,
                danger: true,
                disabled: schemaBlocked,
                hint: schemaHint,
                onSelect: () => onTableOperation(context, table, "truncate"),
              },
              {
                id: "drop",
                label: t("删除表"),
                icon: Trash2,
                danger: true,
                disabled: schemaBlocked,
                hint: schemaHint,
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
                      disabled: viewBlocked,
                      hint: viewHint,
                      onSelect: () => onEditView(context, table),
                    },
                  ]
                : []),
              {
                id: "rename-view",
                label: t("重命名视图"),
                icon: Pencil,
                disabled: viewBlocked,
                hint: viewHint,
                onSelect: () => onTableOperation(context, table, "rename"),
              },
              {
                id: "drop-view",
                label: t("删除视图"),
                icon: Trash2,
                danger: true,
                disabled: viewBlocked,
                hint: viewHint,
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
        onSelect: () =>
          void copyText(
            `SELECT * FROM ${quote(context.database)}.${quote(table.name)} LIMIT 200;`,
          ),
      },
      { separator: true },
      {
        id: "refresh",
        label: t("刷新"),
        icon: RefreshCw,
        onSelect: () => {
          void refreshTableDetail(
            context.profileId,
            context.database,
            table.name,
          );
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
