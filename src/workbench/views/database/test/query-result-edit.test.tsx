import "@/i18n";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { databaseApi } from "@/api/ops-api";
import type { DatabaseProfile, DbSessionInfo, DbColumn, DbTableDetail, MutationResult, BrowseResult } from "@/api/types/database";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { useDatabaseWorkbenchStore, type StatementResult } from "@/stores/database-workbench-store";
import { QueryResultGrid } from "../QueryResultGrid";
import { EMPTY_SELECTION } from "../grid/selection";

type GridProps=Parameters<typeof import("../VirtualDataGrid").VirtualDataGrid>[0];
const mock=vi.hoisted(()=>({grid:null as GridProps | null}));
vi.mock("../db-engines",()=>({engineMeta:()=>({descriptor:{}}),capabilityAllows:()=>true}));
vi.mock("../VirtualDataGrid",()=>({VirtualDataGrid:(props:GridProps)=>{
  mock.grid=props;
  useEffect(()=>{if(props.apiRef)props.apiRef.current={getRows:()=>props.rows,getSelection:()=>EMPTY_SELECTION,getFocus:()=>null,
    selectAll:()=>undefined,moveFocus:()=>undefined,focusCell:()=>undefined,focus:()=>undefined};},[props.apiRef,props.rows]);
  return <div role="grid" aria-readonly={!props.editable}>{props.rows.map((r,i)=><span key={i}>{r.map(c=>c.kind==="text"||c.kind==="int"?c.value:"").join(" / ")}</span>)}</div>;
}}));
const profile={id:"p",name:"test",engine:"mysql",read_only:false} as DatabaseProfile;
const session:DbSessionInfo={session_id:"s1",profile_id:"p",generation:1,state:"ready",connection:{label:"test",numeric:1},server_version:"8",current_database:"other",tls_active:false,tls_cipher:null,tls_version:null,transaction:"none",read_only:false,opened_at:0};
const col=(name:string):DbColumn=>({index:0,name,org_name:name,org_table:"users",table:"u",origin_database:"main",type_name:"VARCHAR",type_code:0,nullable:true,unsigned:false,binary:false,primary_key:false,auto_increment:false,decimals:0,charset:0});
const detail={database:"main",table:"users",kind:"table",primary_key:["id"],reliable_key:["id"],columns:[{name:"id",data_type:"int",nullable:false},{name:"name",data_type:"varchar",nullable:true}],engine:"InnoDB"} as DbTableDetail;
const source:StatementResult={key:"r1",sourceSql:"SELECT u.id,u.name AS display_name FROM main.users u",sessionId:"s1",generation:1,
  statement:"SELECT …",statementIndex:0,resultSetIndex:0,columns:[col("id"),{...col("name"),name:"display_name"}],
  rows:[[{kind:"int",value:"1",unsigned:false},{kind:"text",value:"123",bytes:3,truncated:false}]],affectedRows:0,lastInsertId:null,warnings:0,info:"",elapsedMs:1,receivedRows:1,bytes:8,truncated:false,truncationReason:null,error:null};
const committed:MutationResult={state:"committed",outcomes:[{index:0,kind:"update",affected_rows:1,status:"applied",error:null}],committed_rows:1,elapsed_ms:1,transactional:true,warning:null,verify_hint:null};
let root:Root;let holder:HTMLDivElement;let tabId:string;
const report=(_key:string,count:number)=>{
  useDatabaseWorkbenchStore.getState().setPendingResultEdits(tabId,count);
  useDatabaseWorkspaceStore.getState().setStatus(tabId,{pendingCount:count});
};
function Harness(){
  const result=useDatabaseWorkbenchStore(s=>s.tabs[tabId]?.results[0]);
  return result?<QueryResultGrid tabId={tabId} result={result} active onCopy={()=>undefined} onOpenCell={()=>undefined} onPendingCount={report}/>:null;
}
const render=async()=>act(async()=>root.render(<Harness/>));
const button=(label:string)=>Array.from(holder.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent?.trim()===label)!;
const edit=async()=>{
  act(()=>mock.grid!.onStartEdit!({row:0,col:1}));
  act(()=>mock.grid!.onEditingValueChange!("789"));
  await act(async()=>mock.grid!.onCommitEdit!({row:0,col:1},null));
};
beforeEach(()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  useDatabaseWorkspaceStore.setState({items:[],activeId:null});
  useDatabaseWorkbenchStore.setState({tabs:{}});
  useDatabaseStore.setState({profiles:[profile],sessions:{p:session}});
  tabId=useDatabaseWorkspaceStore.getState().newQuery({profileId:"p",connectionName:"test",database:"main"});
  useDatabaseWorkbenchStore.getState().ensureTab(tabId,"p");
  useDatabaseWorkbenchStore.setState(s=>({tabs:{...s.tabs,[tabId]:{...s.tabs[tabId],results:[source],runState:"completed"}}}));
  vi.spyOn(databaseApi,"tableDetail").mockResolvedValue(detail);
  vi.spyOn(databaseApi,"invalidateMetadata").mockResolvedValue({} as Awaited<ReturnType<typeof databaseApi.invalidateMetadata>>);
  vi.spyOn(databaseApi,"sessionInfo").mockResolvedValue(session);
  vi.spyOn(databaseApi,"mutate").mockResolvedValue(committed);
  vi.spyOn(databaseApi,"browse").mockResolvedValue({columns:[col("id"),col("name")],rows:[[{kind:"int",value:"1",unsigned:false},{kind:"text",value:"789",bytes:3,truncated:false}]]} as BrowseResult);
  holder=document.createElement("div");document.body.appendChild(holder);root=createRoot(holder);
});
afterEach(async()=>{await act(async()=>root.unmount());holder.remove();vi.restoreAllMocks();});

describe("editable query result mutation flow",()=>{
  it("registers pending changes in the blur event before another action can clear results",async()=>{
    await render();
    act(()=>mock.grid!.onStartEdit!({row:0,col:1}));
    act(()=>mock.grid!.onEditingValueChange!("789"));
    act(()=>{
      mock.grid!.onCommitEdit!({row:0,col:1},null);
      expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
      useDatabaseWorkbenchStore.getState().clearResults(tabId);
      expect(useDatabaseWorkbenchStore.getState().tabs[tabId].results).toHaveLength(1);
    });
  });
  it("keeps the runtime alive while a write is in flight",async()=>{
    let complete!: (value:MutationResult)=>void;
    vi.mocked(databaseApi.mutate).mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    await render();await edit();await act(async()=>button("应用修改").click());
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].resultWriteInFlight).toBe(true);
    act(()=>useDatabaseWorkbenchStore.getState().dispose(tabId,{clearDraft:true}));
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId]).toBeDefined();
    await act(async()=>complete(committed));
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].resultWriteInFlight).toBe(false);
  });
  it("shows drafts on blur, writes the original field name once, and reads canonical values",async()=>{
    await render();expect(mock.grid!.editable).toBe(true);
    await edit();expect(mock.grid!.rows[0][1]).toMatchObject({value:"789"});
    expect(databaseApi.mutate).not.toHaveBeenCalled();
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
    act(()=>useDatabaseWorkbenchStore.getState().clearResults(tabId));
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].results).toHaveLength(1);
    await act(async()=>{button("应用修改").click();button("应用修改").click();});
    expect(databaseApi.mutate).toHaveBeenCalledTimes(1);
    expect(databaseApi.mutate).toHaveBeenCalledWith(expect.objectContaining({sessionId:"s1",database:"main",table:"users",rows:[{
      kind:"update",key:[{kind:"value",value:"1"}],values:[{column:"name",value:{kind:"value",value:"789"}}],
      expected:[{column:"id",value:{kind:"value",value:"1"}},{column:"name",value:{kind:"value",value:"123"}}],
    }]}));
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(0);
    expect(mock.grid!.rows[0][1]).toMatchObject({value:"789"});
  });
  it("retains drafts and original comparisons after rollback",async()=>{
    vi.mocked(databaseApi.mutate).mockResolvedValue({...committed,state:"rolled_back",committed_rows:0,outcomes:[{index:0,kind:"update",affected_rows:0,status:"conflict",error:{stage:"query",code:null,sql_state:null,message:"原记录已变化",detail:null,retryable:false}}]});
    await render();await edit();await act(async()=>button("应用修改").click());
    expect(holder.textContent).toContain("原记录已变化");
    expect(mock.grid!.rows[0][1]).toMatchObject({value:"789"});
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
    expect(databaseApi.browse).not.toHaveBeenCalled();
  });
  it("rechecks the actual session before mutation and refuses a replacement connection",async()=>{
    vi.mocked(databaseApi.sessionInfo).mockResolvedValue({...session,generation:2});
    await render();await edit();await act(async()=>button("应用修改").click());
    expect(databaseApi.mutate).not.toHaveBeenCalled();
    expect(holder.textContent).toContain("连接、权限或事务状态已变化");
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
  });
  it("locks unknown outcomes instead of offering a blind retry",async()=>{
    vi.mocked(databaseApi.mutate).mockResolvedValue({...committed,state:"outcome_unknown"});
    await render();await edit();await act(async()=>button("应用修改").click());
    expect(button("应用修改").disabled).toBe(true);
    expect(holder.textContent).toContain("提交结果未知");
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
  });
  it("also locks an unknown outcome returned as an IPC error",async()=>{
    vi.mocked(databaseApi.mutate).mockRejectedValue({stage:"outcome_unknown",code:null,sql_state:null,message:"连接中断，提交结果未知",detail:null,retryable:false});
    await render();await edit();await act(async()=>button("应用修改").click());
    expect(button("应用修改").disabled).toBe(true);
    expect(useDatabaseWorkbenchStore.getState().tabs[tabId].pendingResultEdits).toBe(1);
  });
  it("explains missing primary keys rather than enabling a writable-looking grid",async()=>{
    useDatabaseWorkbenchStore.setState(s=>({tabs:{...s.tabs,[tabId]:{...s.tabs[tabId],results:[{...source,sourceSql:"SELECT name FROM main.users",columns:[col("name")],rows:[[source.rows[0][1]]]}]}}}));
    await render();expect(mock.grid!.editable).toBe(false);
    expect(holder.textContent).toContain("完整主键");
  });
});
