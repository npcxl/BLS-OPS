import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({invoke: vi.fn()}));
vi.mock("@tauri-apps/api/core", () => ({invoke: ipc.invoke, isTauri: () => true}));
vi.mock("@tauri-apps/api/event", () => ({listen: async () => () => undefined}));
import { cancelDesktopMenu, openDesktopMenu } from "../bridge";

describe("non-activating desktop menu source input", () => {
  beforeEach(() => { ipc.invoke.mockReset(); ipc.invoke.mockResolvedValue(null); });
  afterEach(() => cancelDesktopMenu());
  const open = () => openDesktopMenu([{label:"Open",onSelect:()=>undefined}],{x:20,y:40});

  it("keeps source input focused and consumes menu keys before editor shortcuts", async () => {
    const input=document.createElement("input");document.body.appendChild(input);input.focus();
    await open();
    const requestId=ipc.invoke.mock.calls.find(([command])=>command==="desktop_menu_show")![1].payload.requestId;
    const editorShortcut=vi.fn();window.addEventListener("keydown",editorShortcut);
    const event=new KeyboardEvent("keydown",{key:"ArrowDown",cancelable:true});
    window.dispatchEvent(event);
    expect(document.activeElement).toBe(input);
    expect(event.defaultPrevented).toBe(true);
    expect(editorShortcut).not.toHaveBeenCalled();
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_key",{requestId,key:"ArrowDown"});
    window.removeEventListener("keydown",editorShortcut);input.remove();
  });

  it("keeps actions and keyboard routing during a WebView child-focus blur", async () => {
    await open();
    const requestId=ipc.invoke.mock.calls.find(([command])=>command==="desktop_menu_show")![1].payload.requestId;
    ipc.invoke.mockResolvedValue(false);
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve();
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_blur",{requestId});
    expect(ipc.invoke).not.toHaveBeenCalledWith("desktop_menu_cancel",expect.anything());
    ipc.invoke.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_key",{requestId,key:"Enter"});
  });

  it("detaches only after native foreground verification confirms an app switch", async () => {
    await open();
    ipc.invoke.mockResolvedValue(true);
    window.dispatchEvent(new Event("blur"));
    await Promise.resolve(); await Promise.resolve();
    ipc.invoke.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it("an old blur result cannot detach a replacement menu", async () => {
    await open();
    let finish!: (closed: boolean) => void;
    ipc.invoke.mockImplementation((command: string) => command === "desktop_menu_blur"
      ? new Promise<boolean>(resolve => { finish=resolve; }) : Promise.resolve(null));
    window.dispatchEvent(new Event("blur"));
    await open();
    const requestId=[...ipc.invoke.mock.calls].reverse().find(([command])=>command==="desktop_menu_show")![1].payload.requestId;
    finish(true); await Promise.resolve();
    ipc.invoke.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_key",{requestId,key:"Enter"});
  });

  it("Tab closes the menu and ordinary text never reaches the underlying editor", async () => {
    await open();
    const text=new KeyboardEvent("keydown",{key:"a",cancelable:true});window.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(true);
    expect(ipc.invoke).not.toHaveBeenCalledWith("desktop_menu_key",expect.objectContaining({key:"a"}));
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",cancelable:true}));
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_cancel",expect.anything());
  });
});
