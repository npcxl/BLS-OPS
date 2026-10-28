/**
 * 从建表语句里解析外键。
 *
 * 为什么解析 DDL 而不是查 information_schema：`referential_constraints` 需要
 * 额外的后端查询与类型（`ColumnEdit` / `AlterTableRequest` 里也没有外键），
 * 而结构页本来就拿到了完整的 `create_sql`。DDL 里的 `CONSTRAINT ... FOREIGN
 * KEY ... REFERENCES ...` 是标准写法，MySQL / MariaDB / SQLite 都能命中。
 *
 * 只做只读展示：新建/修改外键需要后端支持，前端不做假入口。
 */

export interface ForeignKeyInfo {
  /** 约束名；DDL 里没写 CONSTRAINT 时为空字符串。 */
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** `CASCADE` / `SET NULL` / `RESTRICT` …；没写则为 null。 */
  onDelete: string | null;
  onUpdate: string | null;
}

const FOREIGN_KEY_RE =
  /(?:CONSTRAINT\s+([`\w$]+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+([^()]+?)\s*\(([^)]*)\)((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION))*)/gi;

const ON_DELETE_RE = /ON\s+DELETE\s+(RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i;
const ON_UPDATE_RE = /ON\s+UPDATE\s+(RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION)/i;

const strip = (value: string) => value.replace(/`/g, "").trim();

const splitColumns = (value: string) =>
  value
    .split(",")
    .map((column) => strip(column))
    .filter(Boolean);

export function parseForeignKeys(createSql: string | null | undefined): ForeignKeyInfo[] {
  if (!createSql) return [];

  const keys: ForeignKeyInfo[] = [];
  // exec 会改 lastIndex，复用同一个正则对象会影响并发渲染，这里每次新建。
  const pattern = new RegExp(FOREIGN_KEY_RE.source, FOREIGN_KEY_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(createSql)) !== null) {
    const actions = match[5] ?? "";
    const refTarget = strip(match[3] ?? "");
    keys.push({
      name: strip(match[1] ?? ""),
      columns: splitColumns(match[2] ?? ""),
      // 跨库引用写成 `db`.`table`，只保留表名。
      refTable: refTarget.split(".").pop() ?? refTarget,
      refColumns: splitColumns(match[4] ?? ""),
      onDelete: actions.match(ON_DELETE_RE)?.[1].replace(/\s+/g, " ").toUpperCase() ?? null,
      onUpdate: actions.match(ON_UPDATE_RE)?.[1].replace(/\s+/g, " ").toUpperCase() ?? null,
    });
  }
  return keys;
}
