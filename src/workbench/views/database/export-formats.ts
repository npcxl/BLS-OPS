import type { ExportFormat } from "@/api/types/database";

export const EXPORT_FORMATS: { value: ExportFormat; label: string; hint: string; description: string }[] = [
  { value: "csv", label: "CSV", hint: ".csv", description: "逗号分隔，适合 Excel 与通用数据交换。NULL 为空字段，空字符串为双引号。" },
  { value: "tsv", label: "TSV", hint: ".tsv", description: "制表符分隔，适合表格工具。含制表符、引号或换行的内容会自动转义。" },
  { value: "json", label: "JSON", hint: ".json", description: "导出为对象数组。整数与 DECIMAL 保留为字符串，避免精度丢失；NULL 保留为 null。" },
  { value: "jsonl", label: "JSON Lines", hint: ".jsonl", description: "每行一个 JSON 对象，适合流式处理。整数与 DECIMAL 保留为字符串。" },
  { value: "sql", label: "SQL INSERT", hint: ".sql", description: "按当前数据库方言生成 INSERT 语句，仅导出数据，不包含建表语句。" },
  { value: "html", label: "HTML", hint: ".html", description: "导出为可在浏览器查看的表格，字段内容会转义，不执行 HTML。" },
  { value: "xml", label: "XML", hint: ".xml", description: "按记录与字段组织，保留 NULL 标记。二进制与 XML 不支持的字符使用 Base64。" },
];

export function exportFileName(path: string, format: ExportFormat): string {
  return path.replace(/\.(csv|tsv|json|jsonl|sql|html|xml)$/i, "") + `.${format}`;
}
