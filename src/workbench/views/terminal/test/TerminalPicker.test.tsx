import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerRecord } from "@/api/ops-api";

const h = vi.hoisted(() => ({ update: vi.fn(), close: vi.fn(), save: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({t:(key:string)=>key}) }));
vi.mock("@/stores/workbench-store", () => ({ useWorkbenchStore: (pick: (state: unknown)=>unknown) => pick({updateTab:h.update,closeTabById:h.close}) }));
vi.mock("@/stores/domain-store", () => ({ emptyServer: () => ({}), useDomainStore: {getState:()=>({saveServer:h.save})} }));
vi.mock("@/workbench/server-list/ServerForm", () => ({ServerForm: ({variant}: {variant:string}) => <form data-testid="server-form" data-variant={variant} />}));
vi.mock("../../home/quick-connect", () => ({
  QuickConnectForm: ({onConnect}: {onConnect: (target: unknown, auth: unknown, save: boolean)=>unknown}) => <>
    <button onClick={()=>void onConnect({host:"test.local",username:"ops",port:2222},{password:"temporary"},false)}>connect once</button>
    <button onClick={()=>void onConnect({host:"test.local",username:"ops",port:2222},{password:"temporary"},true)}>save and connect</button>
  </>,
}));
import { TerminalPicker } from "../TerminalPicker";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let holder: HTMLDivElement;
let root: Root;
const server = {id:"existing",name:"Existing server",host:"localhost",username:"ops",port:22} as ServerRecord;
const click = async (label: string) => {
  const target = Array.from(holder.querySelectorAll("button")).find(node=>node.textContent?.includes(label));
  expect(target).toBeDefined();
  await act(async()=>target!.click());
};
beforeEach(async()=>{
  vi.clearAllMocks();
  h.save.mockResolvedValue({...server,id:"saved"});
  holder=document.createElement("div");document.body.appendChild(holder);root=createRoot(holder);
  await act(async()=>root.render(<TerminalPicker tabId="current-tab" servers={[server]} />));
});
afterEach(async()=>{await act(async()=>root.unmount());holder.remove();});
describe("terminal connection page",()=>{
  it("renders in the work area without a dialog",()=>{
    expect(holder.querySelector(".page-surface")).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("opens new server creation inline in the same setup page",async()=>{
    await act(async()=>root.render(<TerminalPicker key="create" tabId="new-server" servers={[]} initialMode="create" />));
    expect(holder.querySelector('[data-testid="server-form"]')?.getAttribute("data-variant")).toBe("inline");
    expect(holder.querySelector('[role="dialog"]')).toBeNull();
  });
  it("connects a one-time target in the current tab",async()=>{
    await click("connect once");
    expect(h.save).not.toHaveBeenCalled();
    expect(h.update).toHaveBeenCalledWith("current-tab",expect.objectContaining({quickTarget:"ops@test.local:2222",oneTimePassword:"temporary"}));
    expect(h.update).toHaveBeenCalledTimes(1);
  });
  it("saves only server metadata and keeps the temporary password in the tab",async()=>{
    await click("save and connect");
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({host:"test.local",username:"ops",port:2222,credential_id:null}));
    expect(JSON.stringify(h.save.mock.calls)).not.toContain("temporary");
    expect(h.update).toHaveBeenCalledWith("current-tab",expect.objectContaining({serverId:"saved",quickTarget:undefined,oneTimePassword:"temporary"}));
  });
  it("keeps the original one-time connection fallback if saving fails",async()=>{
    h.save.mockRejectedValue(new Error("save unavailable"));
    await click("save and connect");
    expect(h.update).toHaveBeenCalledWith("current-tab",expect.objectContaining({quickTarget:"ops@test.local:2222",serverId:undefined}));
  });
  it("attaches a saved server to the current tab",async()=>{
    await click("Saved servers");await click("Existing server");
    expect(h.update).toHaveBeenCalledWith("current-tab",expect.objectContaining({serverId:"existing",oneTimePassword:undefined,quickTarget:undefined}));
  });
});
