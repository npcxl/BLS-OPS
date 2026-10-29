/**
 * 右键菜单里的复制项 —— 数据表与 SQL 结果共用一份，避免两边文案/快捷键漂移。
 *
 * 菜单本身由各个视图的 `ContextMenu` 渲染，这里只产出 `ContextMenuItem[]`；
 * 右键时调用方要先把"右键目标"变成当前选择（单元格/行/列），这样
 * 「复制选中区域」和 Ctrl+C 才是同一件事。
 */
import type { TFunction } from "i18next";
import type { ContextMenuItem } from "@/components/ui/context-menu";
import type { CopyFormat } from "./copy-format";

export interface CopyMenuOptions {
  t: TFunction;
  /** 当前是否有可复制的选择。 */
  hasSelection: boolean;
  /** 表名与字段可靠时才提供 INSERT。 */
  canInsert: boolean;
  onCopy: (format: CopyFormat, includeHeaders?: boolean) => void;
}

export function copyMenuItems({
  t,
  hasSelection,
  canInsert,
  onCopy,
}: CopyMenuOptions): ContextMenuItem[] {
  return [
    {
      id: "copy-tsv",
      label: t("复制"),
      hint: "Ctrl+C",
      disabled: !hasSelection,
      onSelect: () => onCopy("tsv"),
    },
    {
      id: "copy-tsv-headers",
      label: t("复制（含列名）"),
      hint: "Ctrl+Shift+C",
      disabled: !hasSelection,
      onSelect: () => onCopy("tsv", true),
    },
    { separator: true },
    {
      id: "copy-csv",
      label: t("复制为 CSV"),
      disabled: !hasSelection,
      onSelect: () => onCopy("csv", true),
    },
    {
      id: "copy-json",
      label: t("复制为 JSON"),
      disabled: !hasSelection,
      onSelect: () => onCopy("json"),
    },
    {
      id: "copy-insert",
      label: t("复制为 INSERT"),
      disabled: !hasSelection || !canInsert,
      onSelect: () => onCopy("insert"),
    },
  ];
}
