import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { emptyServer, useDomainStore } from "@/stores/domain-store";
import { ServerForm } from "../server-list/ServerForm";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let holder: HTMLDivElement;
const originalSaveCredential = useDomainStore.getState().saveCredential;
const originalSaveServer = useDomainStore.getState().saveServer;
const saveCredential = vi.fn();
const saveServer = vi.fn();
const button = (label: string) => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
  .find(node=>node.textContent?.trim()===label)!;
const openEditor = async () => {
  await act(async()=>holder.querySelector<HTMLButtonElement>('[aria-label="Credential"]')!.click());
  const option = button("Enter now and save credential");
  await act(async()=>option.click());
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,180));});
};
const fillPassword = async (value: string) => {
  const input = holder.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')!;
  await act(async()=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);
    input.dispatchEvent(new Event("input",{bubbles:true}));
  });
};
beforeEach(async()=>{
  vi.clearAllMocks();await i18n.changeLanguage("en");
  saveCredential.mockImplementation(async metadata=>({...metadata,id:"created-credential",secret_ref:"keyring:fixture"}));
  saveServer.mockImplementation(async server=>server);
  useDomainStore.setState({credentials:[],servers:[],groups:[],saveCredential,saveServer});
  holder=document.createElement("div");document.body.appendChild(holder);root=createRoot(holder);
  await act(async()=>root.render(<ServerForm variant="inline" server={{...emptyServer(),name:"Example",host:"test.local",username:"ops"}} onClose={()=>{}} />));
});
afterEach(async()=>{
  await act(async()=>root.unmount());holder.remove();
  useDomainStore.setState({saveCredential:originalSaveCredential,saveServer:originalSaveServer});
});
describe("inline credential creation on the server page",()=>{
  it("opens a searchable chooser and selects from a large credential list",async()=>{
    await act(async()=>useDomainStore.setState({credentials:Array.from({length:100},(_,i)=>({id:`c-${i}`,name:`Server key ${i}`,username:`ops-${i}`,credential_type:"password",created_at:0,updated_at:0}))}));
    await act(async()=>holder.querySelector<HTMLButtonElement>('[aria-label="Credential"]')!.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(100);
    const input=document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"OPS-42");
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
    await act(async()=>(document.querySelector('[role="option"]') as HTMLButtonElement).click());
    expect(holder.querySelector('[aria-label="Credential"]')?.textContent).toContain("Server key 42");
  });
  it("can clear an unmatched search without changing the selected credential",async()=>{
    await act(async()=>holder.querySelector<HTMLButtonElement>('[aria-label="Credential"]')!.click());
    const input=document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"missing");
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    expect(document.body.textContent).toContain("No matching credentials");
    await act(async()=>button("Clear search").click());
    expect(input.value).toBe("");
    expect(saveServer).not.toHaveBeenCalled();
    expect(saveCredential).not.toHaveBeenCalled();
  });
  it("saves the secret separately, selects the credential and binds it to the server",async()=>{
    await openEditor();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Save Ctrl+S").disabled).toBe(true);
    expect(holder.querySelectorAll("form")).toHaveLength(1);
    await fillPassword(" exact secret ");
    await act(async()=>button("Save credential").click());
    expect(saveCredential).toHaveBeenCalledWith(expect.objectContaining({username:"ops",name:"ops@test.local"})," exact secret ",undefined);
    expect(holder.querySelector('[aria-label="Credential"]')?.textContent).toContain("ops@test.local");
    expect(holder.querySelector('input[autocomplete="new-password"]')).toBeNull();
    await act(async()=>holder.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({credential_id:"created-credential",username:"ops"}));
    expect(JSON.stringify(saveServer.mock.calls)).not.toContain(" exact secret ");
  });
  it("keeps the draft editable and does not bind anything when saving fails",async()=>{
    saveCredential.mockRejectedValue(new Error("keyring unavailable"));
    await openEditor();await fillPassword("fixture secret");
    await act(async()=>button("Save credential").click());
    expect(holder.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')?.value).toBe("fixture secret");
    expect(holder.textContent).toContain("keyring unavailable");
    expect(button("Save Ctrl+S").disabled).toBe(true);
    expect(saveServer).not.toHaveBeenCalled();
  });
  it("cancels the inline editor without creating or binding a credential",async()=>{
    await openEditor();await fillPassword("fixture secret");
    await act(async()=>button("Cancel").click());
    expect(holder.querySelector('input[autocomplete="new-password"]')).toBeNull();
    expect(saveCredential).not.toHaveBeenCalled();
    expect(button("Save Ctrl+S").disabled).toBe(false);
  });
});
