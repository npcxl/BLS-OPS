import type { DbColumn, DbTableDetail, DbValue } from "@/api/types/database";

type Token = {text: string; kind: "name" | "quoted" | "string" | "symbol"};
const keyword = (token: Token | undefined, text: string) => token?.kind === "name" && token.text.toUpperCase() === text;
const name = (token: Token | undefined) => token && (token.kind === "name" || token.kind === "quoted");

/** A deliberately restricted SELECT grammar, not a regex extracting FROM.
 * Unknown syntax is read-only; protocol provenance remains authoritative. */
function tokens(sql: string, mysql: boolean): Token[] {
  const result: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if ((sql.startsWith("--", i) && (!mysql || /\s/.test(sql[i+2] ?? " "))) || (mysql && c === "#")) {
      while (i < sql.length && sql[i] !== "\n") i++; continue;
    }
    if (sql.startsWith("/*", i)) {
      if (sql[i+2] === "!" || sql.slice(i+2,i+4).toUpperCase()==="M!") throw new Error("执行型注释的查询结果只读");
      let depth=1; i+=2;
      while (i<sql.length && depth) {
        if (sql.startsWith("/*",i)) {depth++;i+=2;}
        else if (sql.startsWith("*/",i)) {depth--;i+=2;} else i++;
      }
      if (depth) throw new Error("无法完整解析查询来源");
      continue;
    }
    const dollar = c === "$" && !mysql ? /^\$(?:[A-Za-z_][\w]*)?\$/.exec(sql.slice(i))?.[0] : null;
    if (dollar) {
      const end=sql.indexOf(dollar,i+dollar.length);
      if (end<0) throw new Error("无法完整解析查询来源");
      result.push({text:"",kind:"string"});i=end+dollar.length;continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c; let text=""; let closed=false;i++;
      while (i<sql.length) {
        if (sql[i]===close) {
          if (sql[i+1]===close) {text+=close;i+=2;continue;}
          i++;closed=true;break;
        }
        // SQL modes can change backslash escaping. Without a captured mode,
        // do not let an ambiguous quote hide a UNION/JOIN from this checker.
        if (sql[i] === "\\") throw new Error("含反斜杠转义的查询暂不支持结果编辑");
        text+=sql[i++];
      }
      if (!closed) throw new Error("无法完整解析查询来源");
      result.push({text,kind:c === "'" ? "string" : "quoted"});continue;
    }
    const word=/^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(i))?.[0];
    if (word) {result.push({text:word,kind:"name"});i+=word.length;continue;}
    result.push({text:c,kind:"symbol"});i++;
  }
  return result;
}

export function simpleSelect(sql: string, engine: string): {table: string; database?: string} {
  const list=tokens(sql, engine === "mysql" || engine === "mariadb");
  if (list[list.length-1]?.text === ";") list.pop();
  if (!keyword(list[0],"SELECT")) throw new Error("仅支持单表 SELECT 结果编辑");
  const forbidden=new Set(["JOIN","UNION","INTERSECT","EXCEPT","DISTINCT","GROUP","HAVING","WITH","OVER","WINDOW","INTO","PROCEDURE"]);
  if (list.slice(1).some(t=>t.kind==="name" && (forbidden.has(t.text.toUpperCase()) || keyword(t,"SELECT"))) || list.some(t=>t.text === ";" && t.kind==="symbol")) {
    throw new Error("联表、去重、聚合或子查询结果只读");
  }
  const from=list.findIndex(t=>keyword(t,"FROM"));
  if (from<2) throw new Error("无法确定查询的原始表");
  const projection=list.slice(1,from);
  let part: Token[]=[];
  const check = () => {
    let i=0;
    if (!name(part[i]) && part[i]?.text!=="*") throw new Error("计算列或表达式结果只读");
    i++;
    while (part[i]?.text===".") { i++; if (!name(part[i]) && part[i]?.text!=="*") throw new Error("无法确定字段来源"); i++; }
    if (keyword(part[i],"AS")) i++;
    if (name(part[i])) i++;
    if (i!==part.length) throw new Error("计算列或表达式结果只读");
  };
  for (const token of projection) {if (token.text==="," && token.kind==="symbol") {check();part=[];} else part.push(token);}
  check();
  let i=from+1; const ref: Token[]=[];
  if (!name(list[i])) throw new Error("无法确定查询的原始表"); ref.push(list[i++]);
  while (list[i]?.text===".") {i++;if (!name(list[i])) throw new Error("无法确定查询的原始表");ref.push(list[i++]);}
  if (ref.length>2) throw new Error("不支持该表名限定方式");
  if (keyword(list[i],"AS")) { i++; if (!name(list[i])) throw new Error("无法确定表别名");i++; }
  else if (name(list[i]) && !["WHERE","ORDER","LIMIT","OFFSET","FETCH","FOR"].some(k=>keyword(list[i],k))) i++;
  if (i<list.length && !["WHERE","ORDER","LIMIT","OFFSET","FETCH","FOR"].some(k=>keyword(list[i],k))) throw new Error("仅支持单表 SELECT 结果编辑");
  const normalized=(t: Token)=>engine==="postgres" && t.kind==="name" ? t.text.toLowerCase() : t.text;
  return {table:normalized(ref[ref.length-1]), database:ref.length===2?normalized(ref[0]):undefined};
}

export interface QueryEditTarget {database: string; table: string; names: string[]}
export function queryEditTarget(sql: string, engine: string, columns: DbColumn[]): QueryEditTarget {
  if (!["mysql","mariadb","postgres","sqlite"].includes(engine)) throw new Error("该引擎暂不支持查询结果编辑");
  const parsed=simpleSelect(sql,engine);
  const first=columns[0];
  if (!first?.origin_database || !first.org_table) throw new Error("结果缺少可验证的来源信息，请重新执行查询");
  if (parsed.table!==first.org_table || (parsed.database && parsed.database!==first.origin_database)) throw new Error("查询表与字段来源不一致，结果只读");
  if (columns.some(c=>!c.org_name || c.org_table!==first.org_table || c.origin_database!==first.origin_database)) throw new Error("结果包含来源不明或不同表的字段");
  const names=columns.map(c=>c.org_name);
  if (new Set(names).size!==names.length) throw new Error("结果重复包含同一字段，无法安全回写");
  return {database:first.origin_database,table:first.org_table,names};
}

export function validateQueryKey(target: QueryEditTarget, detail: DbTableDetail, rows: DbValue[][]): number[] {
  if (detail.kind!=="table") throw new Error("视图查询结果只读");
  if (!detail.primary_key.length) throw new Error("原表没有主键，查询结果只读");
  const indexes=detail.primary_key.map(key=>target.names.indexOf(key));
  if (indexes.some(index=>index<0)) throw new Error("查询结果必须包含完整主键（含联合主键全部字段）");
  if (target.names.some(n=>!detail.columns.some(c=>c.name===n))) throw new Error("表结构已变化，请重新执行查询");
  const seen=new Set<string>();
  for (const row of rows) {
    const key=indexes.map(index=>{
      const value=row[index];
      if (!value || value.kind==="null" || value.kind==="binary" || value.kind==="bit" || value.kind==="unsupported" || ((value.kind==="text" || value.kind==="json") && value.truncated)) throw new Error("主键值不完整或类型不支持，无法安全定位记录");
      return String(value.value);
    });
    const identity=JSON.stringify(key);
    if (seen.has(identity)) throw new Error("结果主键重复，无法唯一定位原记录");
    seen.add(identity);
  }
  return indexes;
}
