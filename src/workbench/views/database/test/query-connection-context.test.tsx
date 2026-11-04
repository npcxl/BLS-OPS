import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProfile, DbSessionInfo, DbDatabase } from "@/api/types/database";
import { databaseApi } from "@/api/ops-api";
import { useDatabaseStore } from "@/stores/database-store";
import { useDatabaseWorkbenchStore } from "@/stores/database-workbench-store";
import { useDatabaseWorkspaceStore } from "@/stores/database-workspace-store";
import { useWorkbenchStore } from "@/stores/workbench-store";
import { WorkItemHost } from "../WorkItemHost";

vi.mock("@uiw/react-codemirror", async original => ({...await original<typeof import("@uiw/react-codemirror")>(), default: ({value}: {value: string}) => <textarea value={value} readOnly />}));
vi.mock("../TableBrowser", () => ({TableBrowser: () => null}));
vi.mock("../TableStructure", () => ({TableStructure: () => null}));
vi.mock("../DatabaseObjects", () => ({DatabaseObjects: () => null}));
vi.mock("../ResultsPanel", () => ({ResultsPanel: () => null}));
vi.mock("../ExportDialog", () => ({ExportDialog: () => null}));
vi.mock("../HistoryDialog", () => ({HistoryDialog: () => null}));
(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const a = {id:"a",name:"connection-a",engine:"mysql",host:"localhost",port:3306,username:"root",default_database:"old_db",read_only:false} as DatabaseProfile;
const b = {...a,id:"b",name:"connection-b"};
const session = (id: string): DbSessionInfo => ({
  session_id:`session-${id}`,profile_id:id,current_database:"old_db",transaction:"none",
  generation:1,connection:{label:"test",numeric:1},server_version:"8.0",tls_active:false,
  tls_cipher:null,tls_version:null,read_only:false,opened_at:0,
});
let holder: HTMLDivElement;
let root: Root;
let aId: string;
let bId: string;
beforeEach(() => {
  useDatabaseWorkspaceStore.setState({items:[],activeId:null});
  useDatabaseWorkbenchStore.setState({tabs:{}});
  useDatabaseStore.setState({profiles:[a,b],databases:{
    a:[{name:"old_db",system:false}] as DbDatabase[], b:[{name:"new_db",system:false}] as DbDatabase[],
  },sessions:{a:session("a"),b:session("b")},tables:{},details:{}});
  vi.spyOn(databaseApi,"useDatabase").mockResolvedValue(session("a"));
  vi.spyOn(useWorkbenchStore.getState(),"openDatabaseTab").mockImplementation(() => undefined);
  const workspace = useDatabaseWorkspaceStore.getState();
  aId=workspace.newQuery({profileId:"a",connectionName:a.name,database:"old_db"});
  bId=workspace.newQuery({profileId:"b",connectionName:b.name,database:null});
  useDatabaseWorkbenchStore.getState().ensureTab(aId,"a");
  useDatabaseWorkbenchStore.getState().setSql(aId,"SELECT 42;");
  holder=document.createElement("div");document.body.appendChild(holder);root=createRoot(holder);
});
afterEach(async () => { await act(async () => root.unmount());holder.remove();vi.restoreAllMocks(); });
const mount = async () => act(async () => root.render(<>
  <div data-connection="a"><WorkItemHost profileId="a" connectionName={a.name} session={session("a")} onRequestClose={() => undefined} onNewQuery={() => undefined} /></div>
  <div data-connection="b"><WorkItemHost profileId="b" connectionName={b.name} session={session("b")} onRequestClose={() => undefined} onNewQuery={() => undefined} /></div>
</>));

describe("multiple resident query hosts and connection context", () => {
  it("does not let background hosts fight over global activeId", async () => {
    await mount();
    expect(useDatabaseWorkspaceStore.getState().activeId).toBe(bId);
    await act(async () => useDatabaseWorkspaceStore.getState().setActive(aId));
    expect(useDatabaseWorkspaceStore.getState().activeId).toBe(aId);
    await act(async () => useDatabaseWorkspaceStore.getState().setActive(bId));
    expect(useDatabaseWorkspaceStore.getState().activeId).toBe(bId);
    const notify=vi.fn();const stop=useDatabaseWorkspaceStore.subscribe(notify);
    act(() => useDatabaseWorkspaceStore.getState().setActive(bId));
    expect(notify).not.toHaveBeenCalled();stop();
  });
  it("clears the database on connection change and preserves both SQL drafts", async () => {
    await mount();
    const source=holder.querySelector('[data-connection="a"]')!;
    await act(async () => source.querySelector<HTMLButtonElement>('[aria-label="选择连接"]')!.click());
    const target=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(n=>n.textContent?.includes("connection-b"))!;
    await act(async () => target.click());
    const state=useDatabaseWorkspaceStore.getState();
    const created=state.items.find(item=>item.id===state.activeId)!;
    expect(created.profileId).toBe("b");expect(created.database).toBeNull();
    expect(created.id).not.toBe(bId);
    expect(useDatabaseWorkbenchStore.getState().tabs[created.id].sql).toBe("SELECT 42;");
    expect(useDatabaseWorkbenchStore.getState().tabs[aId].sql).toBe("SELECT 42;");
    expect(databaseApi.useDatabase).not.toHaveBeenCalled();
    const visible=Array.from(holder.querySelectorAll<HTMLElement>('[aria-label="选择数据库"]')).find(n=>n.closest('[aria-hidden="false"]') && n.closest('[data-connection="b"]'))!;
    expect(visible.textContent).toContain("选择数据库");
  });
});
