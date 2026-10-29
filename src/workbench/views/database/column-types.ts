/**
 * 字段类型预设 —— 结构页「类型」下拉与 CreateTable 的候选来源。
 *
 * `length` / `scale` 对应 Navicat 的行为："选完类型自动把长度/小数点填好"：
 * 选 VARCHAR 填 255，选 DECIMAL 填 10 / 0，选 INT / DATE 这类不带参数的清空。
 *
 * 整数类型故意不给显示宽度：MySQL 8.0.19 起 `int(11)` 已废弃，填了反而会
 * 在预览 DDL 里带一条 deprecation 警告。
 *
 * 目前只有 MySQL/MariaDB 有真实适配器，其他引擎接入时再补对应的表。
 */

export interface ColumnTypePreset {
  /** 下拉里展示的类型名。 */
  name: string;
  /** 选中后写回 `base_type` 的值。 */
  value: string;
  /** 自动填入「长度」的默认值；空字符串表示该类型不带长度。 */
  length: string;
  /** 自动填入「小数点」的默认值。 */
  scale: string;
}

export const MYSQL_COLUMN_TYPES: ColumnTypePreset[] = [
  // 数值
  { name: "TINYINT", value: "tinyint", length: "", scale: "" },
  { name: "SMALLINT", value: "smallint", length: "", scale: "" },
  { name: "MEDIUMINT", value: "mediumint", length: "", scale: "" },
  { name: "INT", value: "int", length: "", scale: "" },
  { name: "BIGINT", value: "bigint", length: "", scale: "" },
  { name: "DECIMAL", value: "decimal", length: "10", scale: "0" },
  { name: "FLOAT", value: "float", length: "", scale: "" },
  { name: "DOUBLE", value: "double", length: "", scale: "" },
  { name: "BIT", value: "bit", length: "1", scale: "" },
  // 日期时间
  { name: "DATE", value: "date", length: "", scale: "" },
  { name: "DATETIME", value: "datetime", length: "", scale: "" },
  { name: "TIMESTAMP", value: "timestamp", length: "", scale: "" },
  { name: "TIME", value: "time", length: "", scale: "" },
  { name: "YEAR", value: "year", length: "", scale: "" },
  // 字符串
  { name: "CHAR", value: "char", length: "1", scale: "" },
  { name: "VARCHAR", value: "varchar", length: "255", scale: "" },
  { name: "TINYTEXT", value: "tinytext", length: "", scale: "" },
  { name: "TEXT", value: "text", length: "", scale: "" },
  { name: "MEDIUMTEXT", value: "mediumtext", length: "", scale: "" },
  { name: "LONGTEXT", value: "longtext", length: "", scale: "" },
  { name: "ENUM", value: "enum", length: "", scale: "" },
  { name: "SET", value: "set", length: "", scale: "" },
  // 二进制 / BLOB
  { name: "BINARY", value: "binary", length: "1", scale: "" },
  { name: "VARBINARY", value: "varbinary", length: "255", scale: "" },
  { name: "TINYBLOB", value: "tinyblob", length: "", scale: "" },
  { name: "BLOB", value: "blob", length: "", scale: "" },
  { name: "MEDIUMBLOB", value: "mediumblob", length: "", scale: "" },
  { name: "LONGBLOB", value: "longblob", length: "", scale: "" },
  // 其他
  { name: "JSON", value: "json", length: "", scale: "" },
  { name: "BOOLEAN", value: "boolean", length: "", scale: "" },
];

/** 下拉选项：类型名 + 右侧提示（默认长度 / 小数位）。 */
export const MYSQL_COLUMN_TYPE_OPTIONS = MYSQL_COLUMN_TYPES.map((preset) => ({
  value: preset.value,
  label: preset.name,
  hint: preset.length
    ? preset.scale
      ? `${preset.length},${preset.scale}`
      : preset.length
    : undefined,
}));

export function findColumnTypePreset(value: string): ColumnTypePreset | null {
  const target = value.trim().toLowerCase();
  return MYSQL_COLUMN_TYPES.find((preset) => preset.value === target) ?? null;
}

/** 取基础类型名：`INT UNSIGNED` / `decimal(10,2)` / `varchar(64)` → `int` / `decimal` / `varchar`。 */
function baseName(value: string): string {
  return value.trim().toLowerCase().split(/[\s(]/, 1)[0] ?? "";
}

/** 该类型是否接受「长度」参数。 */
const LENGTH_TYPES = new Set([
  "char",
  "varchar",
  "binary",
  "varbinary",
  "bit",
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
  "decimal",
  "numeric",
  "float",
  "double",
  "time",
  "datetime",
  "timestamp",
  "year",
]);

/** 该类型是否接受「小数点」（小数位）参数。 */
const SCALE_TYPES = new Set(["decimal", "numeric", "float", "double"]);

/** 该类型能否自增 —— MySQL 只允许整数类型。 */
const AUTO_INCREMENT_TYPES = new Set([
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "integer",
  "bigint",
]);

export function typeSupportsLength(value: string): boolean {
  return LENGTH_TYPES.has(baseName(value));
}

export function typeSupportsScale(value: string): boolean {
  return SCALE_TYPES.has(baseName(value));
}

export function typeSupportsAutoIncrement(value: string): boolean {
  return AUTO_INCREMENT_TYPES.has(baseName(value));
}

/** 拼出完整类型（`varchar(255)` / `decimal(10,0)` / `int`），给只有一列类型的表单用。 */
export function columnTypeTemplate(preset: ColumnTypePreset): string {
  if (!preset.length) return preset.value;
  return preset.scale
    ? `${preset.value}(${preset.length},${preset.scale})`
    : `${preset.value}(${preset.length})`;
}
