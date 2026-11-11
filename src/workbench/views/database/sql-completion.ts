/**
 * SQL 编辑器补全（对齐 Navicat 的"跟着语句走"）。
 *
 * 触发与内容按**当前位置**决定，不做全量平铺：
 * - `FROM` / `JOIN` / `UPDATE` / `INSERT INTO` 之后只给表名（带库名、视图标记）；
 * - `别名.` / `表名.` → 那张表的字段；
 * - `库名.` → 那个库的表；
 * - `库名.表名.` → 字段；
 * - 其余位置 → 当前语句里出现过的表的字段 + 别名 + 表名 + 关键字/函数。
 *
 * 三条硬规则：
 * 1. **只从语法树取表名**：不拿正则去 `FROM` 里猜，字符串和注释里的 `from` 不算；
 * 2. **元数据只用已连接会话查**：会话断了就返回空，不猜一份"看起来像"的字段；
 * 3. 缓存按连接+库+表，30 秒过期；补全失败一律静默（编辑器不该因为补全弹错误）。
 */
import { syntaxTree } from "@codemirror/language";
import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import {
  MSSQL,
  MariaSQL,
  MySQL,
  PLSQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";
import type { DbEngine, DbTable, DbTableDetail } from "@/api/types/database";

/** `@codemirror/state` 不是直接依赖（只随 lang-sql 装进来），类型从语法树反推。 */
type EditorStateLike = Parameters<typeof syntaxTree>[0];
type SyntaxNodeLike = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** 引擎 → 方言（决定关键字、标识符引号与类型名）。 */
export function completionDialect(engine: DbEngine): SQLDialect {
  if (["postgres", "cockroach", "aurora_pg"].includes(engine)) return PostgreSQL;
  if (engine === "sqlite") return SQLite;
  if (engine === "sqlserver") return MSSQL;
  if (engine === "oracle") return PLSQL;
  if (engine === "mariadb") return MariaSQL;
  if (
    ["mysql", "tidb", "oceanbase_mysql", "doris", "starrocks", "aurora_mysql"].includes(
      engine,
    )
  ) {
    return MySQL;
  }
  return StandardSQL;
}

/** 只补常用关键字：一屏能看完，比几百个冷门关键字有用。 */
const KEYWORDS = [
  "SELECT",
  "DISTINCT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "ON",
  "AS",
  "AND",
  "OR",
  "NOT",
  "NULL",
  "IS NULL",
  "IS NOT NULL",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "ASC",
  "DESC",
  "UNION",
  "UNION ALL",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
  "CREATE VIEW",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
] as const;

/** 带括号的函数补全：选中后光标落在括号里，省一次左方向键。 */
const FUNCTIONS = [
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "IFNULL",
  "NULLIF",
  "CAST",
  "CONCAT",
  "SUBSTRING",
  "TRIM",
  "UPPER",
  "LOWER",
  "LENGTH",
  "ROUND",
  "NOW",
  "DATE",
] as const;

interface TableRef {
  database: string | null;
  table: string;
  alias: string | null;
}

export interface SqlCompletionMetadata {
  tables: (database: string) => Promise<DbTable[]>;
  detail: (database: string, table: string) => Promise<DbTableDetail>;
  /** 会话仍在、且不是另一个连接的世代：false 时整段补全直接放弃。 */
  valid: () => boolean;
}

const OPEN_QUOTES: Record<string, string> = { "`": "`", '"': '"', "[": "]" };

/** 只在必要时加引号：`user` 不加，`user-info` 加。 */
function quoteIdentifier(dialect: SQLDialect, name: string): string {
  if (/^[A-Za-z_][A-Za-z_0-9$]*$/.test(name)) return name;
  const opening = dialect.spec.identifierQuotes?.[0] ?? '"';
  const closing = OPEN_QUOTES[opening] ?? opening;
  return opening + name.split(closing).join(closing + closing) + closing;
}

function unquote(raw: string): string {
  const text = raw.trim();
  const opening = text[0];
  const closing = opening ? OPEN_QUOTES[opening] : undefined;
  if (opening && closing && text.endsWith(closing)) {
    const body = text.slice(1, -1);
    return body.split(closing + closing).join(closing);
  }
  return text;
}

/** 光标所在的语句节点；语法树还没建好时退化为整棵树。 */
function statementAt(state: EditorStateLike, pos: number): SyntaxNodeLike {
  let node: SyntaxNodeLike | null = syntaxTree(state).resolveInner(pos, -1);
  while (node && node.name !== "Statement") node = node.parent;
  return node ?? syntaxTree(state).topNode;
}

const isIdentifier = (node: SyntaxNodeLike) =>
  /^(Composite)?(Quoted)?Identifier$/.test(node.name);

/**
 * 语句里出现过的表 + 它们的别名。
 *
 * `FROM users u`、`FROM users AS u`、`JOIN ops.orders o` 都要识别；
 * 其它关键字出现就把"下一段标识符是表名"的状态清掉，避免把列名当表。
 */
function tableReferences(state: EditorStateLike, pos: number): TableRef[] {
  const statement = statementAt(state, pos);
  const references: TableRef[] = [];
  let expect: "table" | "alias" | null = null;

  for (let node = statement.firstChild; node; node = node.nextSibling) {
    if (/Comment/.test(node.name)) continue;
    const text = state.sliceDoc(node.from, node.to);

    if (node.name === "Keyword") {
      const keyword = text.trim().toUpperCase();
      if (["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(keyword)) {
        expect = "table";
        continue;
      }
      if (keyword === "AS") {
        if (expect !== null) expect = "alias";
        continue;
      }
      expect = null;
      continue;
    }

    if (!isIdentifier(node)) continue;
    if (expect === "table") {
      const path = text.split(".").map(unquote);
      references.push({
        database: path.length >= 2 ? path[path.length - 2] : null,
        table: path[path.length - 1],
        alias: null,
      });
      expect = "alias";
    } else if (expect === "alias") {
      const last = references[references.length - 1];
      // 别名后面紧跟关键字（例如 `FROM users WHERE`）时这里根本不会进来。
      if (last) last.alias = unquote(text);
      expect = null;
    }
  }

  // 同一张表在语句里出现多次（自连接）时按别名去重，没有别名就按表名去重。
  return references.filter(
    (ref, index) =>
      references.findIndex(
        (other) =>
          other.table === ref.table &&
          other.database === ref.database &&
          other.alias === ref.alias,
      ) === index,
  );
}

/**
 * 光标前的限定链：`sql.` → ["sql"]，`ops.users.` → ["ops","users"]。
 *
 * 只往回收"标识符 + 点"，遇到别的字符立刻停 —— 这样才能区分
 * `count(u.` （限定链是 u）和 `1.` （不是限定链）。
 */
function qualifierChain(state: EditorStateLike, pos: number): string[] {
  const line = state.sliceDoc(Math.max(0, pos - 200), pos);
  const match = /((?:[A-Za-z_][\w$]*|`[^`]*`|"[^"]*"|\[[^\]]*\])\s*\.\s*)+$/.exec(line);
  if (!match) return [];
  return match[0]
    .split(".")
    .map((part) => unquote(part))
    .filter((part) => part.length > 0);
}

/** 光标是否正处在"该写表名"的位置（FROM / JOIN / UPDATE / INSERT INTO 之后）。 */
function expectsTable(state: EditorStateLike, from: number): boolean {
  const before = state.sliceDoc(Math.max(0, from - 64), from);
  return /(?:\bfrom|\bjoin|\bupdate|\binto|\btable)\s+$/i.exec(before) !== null;
}

const columnCompletion = (
  dialect: SQLDialect,
  column: DbTableDetail["columns"][number],
  owner: string,
): Completion => ({
  label: column.name,
  apply: quoteIdentifier(dialect, column.name),
  type: "property",
  detail: `${column.primary_key ? "PK · " : ""}${column.column_type || column.data_type}`,
  info: [
    `${owner}.${column.name}`,
    column.nullable ? "可为空" : "不可为空",
    column.default_value ? `默认 ${column.default_value}` : null,
    column.comment || null,
  ]
    .filter(Boolean)
    .join("\n"),
  boost: 60,
});

const tableCompletion = (
  dialect: SQLDialect,
  database: string,
  table: DbTable,
): Completion => ({
  label: table.name,
  apply: quoteIdentifier(dialect, table.name),
  type: table.kind === "view" ? "interface" : "class",
  detail: table.kind === "view" ? "视图" : "表",
  info: [
    `${database}.${table.name}`,
    table.comment || null,
    table.estimated_rows !== null ? `约 ${table.estimated_rows} 行` : null,
  ]
    .filter(Boolean)
    .join("\n"),
  boost: 40,
});

/** 函数补全：插入 `NAME()` 并把光标放到括号里。 */
const functionCompletion = (name: string): Completion => ({
  label: name,
  type: "function",
  detail: "函数",
  boost: 20,
  apply: (view, _completion, from, to) => {
    view.dispatch({
      changes: { from, to, insert: `${name}()` },
      selection: { anchor: from + name.length + 1 },
      userEvent: "input.complete",
    });
  },
});

interface CacheEntry {
  until: number;
  promise: Promise<unknown>;
}

/**
 * 补全源工厂。
 *
 * `database` 是**当前查询页的库**（SELECT 里没写库名时用它），
 * 每次换库换连接都会重建一个新的源，缓存自然跟着失效。
 */
export function createSqlCompletion(
  engine: DbEngine,
  database: string | null,
  metadata: SqlCompletionMetadata,
): CompletionSource {
  const dialect = completionDialect(engine);
  const cache = new Map<string, CacheEntry>();
  const TTL = 30_000;

  const cached = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.promise as Promise<T>;
    const promise = load();
    // 失败不留缓存：连接刚恢复时下一次补全还要能重试。
    promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    cache.set(key, { until: Date.now() + TTL, promise });
    return promise;
  };

  const tablesOf = (db: string) =>
    cached(`tables:${db}`, () => metadata.tables(db)).catch(() => [] as DbTable[]);
  const detailOf = (db: string, table: string) =>
    cached(`detail:${db}\u0001${table}`, () => metadata.detail(db, table)).catch(
      () => null,
    );

  return async (context: CompletionContext) => {
    if (!metadata.valid()) return null;

    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (/String|Comment/.test(node.name)) return null;

    const word = context.matchBefore(/[\w$\u0080-\uffff]*$/);
    const from = word?.from ?? context.pos;
    const typedDot = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos) === ".";
    const writingTable = expectsTable(context.state, from);
    // 不显式触发时，要有输入、刚打完点、或正等着写表名才弹，避免到处乱冒。
    if (!context.explicit && !word?.text && !typedDot && !writingTable) return null;

    const chain = qualifierChain(context.state, context.pos);
    const references = tableReferences(context.state, context.pos);
    const options: Completion[] = [];
    const push = (item: Completion) => {
      if (options.some((existing) => existing.label === item.label && existing.type === item.type && existing.detail === item.detail)) return;
      options.push(item);
    };

    /** 限定到某一张表：只给它的字段。 */
    const addColumnsOf = async (ref: TableRef) => {
      const db = ref.database ?? database;
      if (!db) return;
      const detail = await detailOf(db, ref.table);
      if (!detail) return;
      for (const column of detail.columns) {
        push(columnCompletion(dialect, column, `${db}.${ref.table}`));
      }
    };

    if (chain.length > 0) {
      const first = chain[0]!;
      if (chain.length >= 2) {
        // 库.表. → 这张表的字段（多段时取最后两段，`a.b.users.` 也认）
        await addColumnsOf({
          database: chain[chain.length - 2]!,
          table: chain[chain.length - 1]!,
          alias: null,
        });
      } else {
        const alias = references.find((ref) => ref.alias === first);
        const named = references.find((ref) => ref.table === first);
        if (alias || named) {
          await addColumnsOf(alias ?? named!);
        } else {
          // `库名.` 给这个库的表；这个库查不到东西时才当成表名去补字段 ——
          // 两者都补会让 `ops.` 既出表名又出一堆字段，等于没判断。
          const tables = await tablesOf(first!);
          if (tables.length > 0) {
            for (const table of tables) push(tableCompletion(dialect, first!, table));
          } else {
            await addColumnsOf({ database: null, table: first!, alias: null });
          }
        }
      }
      if (context.aborted || !metadata.valid() || options.length === 0) return null;
      return { from, options, validFor: /^[\w$\u0080-\uffff]*$/ } satisfies CompletionResult;
    }

    if (writingTable) {
      const db = database;
      if (!db) return null;
      for (const table of await tablesOf(db)) push(tableCompletion(dialect, db, table));
      if (context.aborted || !metadata.valid() || options.length === 0) return null;
      return { from, options, validFor: /^[\w$\u0080-\uffff]*$/ } satisfies CompletionResult;
    }

    // 普通位置：先补当前语句里那些表的字段，再补别名/表名，最后才是关键字。
    await Promise.all(references.slice(0, 6).map(addColumnsOf));
    for (const ref of references) {
      if (ref.alias) {
        push({
          label: ref.alias,
          type: "variable",
          detail: `${ref.table} 别名`,
          boost: 50,
        });
      }
      const db = ref.database ?? database;
      if (db) {
        push({
          label: ref.table,
          apply: quoteIdentifier(dialect, ref.table),
          type: "class",
          detail: "表",
          info: `${db}.${ref.table}`,
          boost: 45,
        });
      }
    }
    /*
     * **关键字/函数必须排在表名之前**。
     *
     * 业务库里几百张表时，表名会把 200 条上限占满，关键字被挤出结果 ——
     * 输入 `SE` 只看到 `eh_license` 这类表名（模糊匹配能命中 "se"），
     * 看不到 `SELECT`，这正是"像 Navicat 那样提示关键字"失效的原因。
     */
    for (const keyword of KEYWORDS) {
      push({ label: keyword, type: "keyword", boost: 10 });
    }
    for (const name of FUNCTIONS) push(functionCompletion(name));
    if (database) {
      for (const table of await tablesOf(database)) {
        push(tableCompletion(dialect, database, table));
      }
    }

    if (context.aborted || !metadata.valid() || options.length === 0) return null;
    /*
     * 结果多的时候把字段/表顶到前面：boost 已经在选项里，这里只兜底截断。
     *
     * `validFor: /^$/` 是**故意的**：以前给的是"任意词字符都算有效"，
     * CodeMirror 就会拿上一次的结果直接过滤，不再重算 —— 敲第一个字母时
     * 只返回了 200 条（表多时关键字被截在后面），再敲一个字母就只剩那 200 条
     * 里的子集，看起来就是"输入两个字母后提示没了"。现在每次输入都重新算，
     * 候选永远是完整的（元数据有缓存，代价很小）。
     */
    return {
      from,
      options: options.slice(0, 200),
      validFor: /^$/,
    } satisfies CompletionResult;
  };
}
