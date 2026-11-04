import { describe, expect, it } from "vitest";
import type { DbColumn, DbTableDetail, DbValue } from "@/api/types/database";
import { queryEditTarget, simpleSelect, validateQueryKey } from "../query-edit-plan";

const column=(name: string):DbColumn=>({index:0,name,org_name:name,table:"u",org_table:"users",origin_database:"main",type_name:"VARCHAR",type_code:0,nullable:true,unsigned:false,binary:false,primary_key:false,auto_increment:false,decimals:0,charset:0});
const columns=[column("id"),{...column("name"),name:"display_name"}];
const detail={kind:"table",primary_key:["id"],columns:[{name:"id"},{name:"name"}],reliable_key:["id"]} as DbTableDetail;
const row=(id: string):DbValue[]=>[{kind:"int",value:id,unsigned:false},{kind:"text",value:"test",bytes:4,truncated:false}];
describe("query result edit eligibility",()=>{
  it("supports single-table SELECT, filters, sort/limit and field/table aliases",()=>{
    const plan=queryEditTarget("SELECT u.id, u.name AS display_name FROM main.users AS u WHERE u.id > 0 ORDER BY u.id LIMIT 10","mysql",columns);
    expect(plan).toEqual({database:"main",table:"users",names:["id","name"]});
    expect(validateQueryKey(plan,detail,[row("1"),row("2")])).toEqual([0]);
    expect(queryEditTarget("SELECT * FROM users","mysql",columns).database).toBe("main");
  });
  it.each([
    "SELECT u.id, u.name FROM users u JOIN users x ON x.id=u.id",
    "SELECT * FROM users, other",
    "SELECT DISTINCT id, name FROM users",
    "SELECT id, count(*) FROM users GROUP BY id",
    "SELECT id, upper(name) FROM users",
    "SELECT id, name FROM users UNION SELECT id, name FROM users",
    "WITH x AS (SELECT * FROM users) SELECT * FROM x",
    "SELECT * FROM (SELECT * FROM users) u",
    "SELECT * FROM users WHERE EXISTS (SELECT 1 FROM other)",
    "SELECT * FROM users; SELECT * FROM other",
    "SELECT * FROM users /*! JOIN users b ON b.id=users.id */",
    "SELECT * FROM users /*M! JOIN users b ON b.id=users.id */",
    "SELECT * FROM users WHERE name='a\\b'",
  ])("keeps ambiguous/derived query results read-only: %s",sql=>{
    expect(()=>queryEditTarget(sql,"mysql",columns)).toThrow();
  });
  it("does not mistake literal/comment text for JOINs or SELECTs",()=>{
    expect(simpleSelect("/* SELECT JOIN */ SELECT * FROM users WHERE name='JOIN SELECT UNION'","mysql").table).toBe("users");
    expect(simpleSelect("SELECT * FROM public.users WHERE name=$tag$ JOIN SELECT $tag$","postgres").table).toBe("users");
    expect(simpleSelect('SELECT * FROM "MixedCase"',"postgres").table).toBe("MixedCase");
    expect(simpleSelect('SELECT * FROM USERS',"postgres").table).toBe("users");
  });
  it("requires full primary keys, never substitutes a unique index",()=>{
    const target=queryEditTarget("SELECT * FROM users","mysql",columns);
    expect(()=>validateQueryKey(target,{...detail,primary_key:[]},[row("1")])).toThrow("没有主键");
    expect(()=>validateQueryKey(target,{...detail,primary_key:["id","tenant_id"]},[row("1")])).toThrow("完整主键");
    expect(()=>validateQueryKey(target,{...detail,kind:"view"},[row("1")])).toThrow("视图");
    expect(()=>validateQueryKey(target,detail,[row("1"),row("1")])).toThrow("主键重复");
  });
  it("requires exact column provenance rather than display names",()=>{
    expect(()=>queryEditTarget("SELECT * FROM users","mysql",columns.map(c=>({...c,org_table:""})))).toThrow("来源");
    expect(()=>queryEditTarget("SELECT * FROM other.users","mysql",columns)).toThrow("不一致");
    expect(()=>queryEditTarget("SELECT * FROM users","mysql",[columns[0],{...columns[1],origin_database:"other"}])).toThrow("来源");
    expect(()=>queryEditTarget("SELECT id,id FROM users","mysql",[columns[0],columns[0]])).toThrow("重复");
  });
});
