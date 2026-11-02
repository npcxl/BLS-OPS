import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuShowPayload } from "../bridge";

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: new Map<string, (event: {payload: unknown}) => void>(),
  layouts: [] as {requestId: string; resolve: (value: unknown) => void}[],
}));
vi.mock("@tauri-apps/api/core", () => ({invoke: ipc.invoke}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, callback: (event: {payload: unknown}) => void) => {
    ipc.events.set(name, callback);
    return () => {ipc.events.delete(name);};
  },
}));
vi.mock("@/components/ui/menu-surface", () => ({
  MenuSurface: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
  MenuItemRow: ({item, onClick}: {item: {label: string}; onClick: () => void}) => <button onClick={onClick}>{item.label}</button>,
}));
import { DesktopMenuRoot } from "../menu-window";

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const payload = (requestId: string): MenuShowPayload => ({requestId, theme:"light", anchor:{x:0,y:0}, width:220, items:[{label:requestId,actionId:"a0"}]});
const layout = (x: number) => ({main:{x,y:40},submenu:null,maxHeight:800,material:"solid"});
const emit = async (name: string, value: unknown) => {await act(async () => {ipc.events.get(name)?.({payload:value});});};

describe("desktop menu request lifecycle", () => {
  let holder: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    ipc.events.clear(); ipc.layouts=[]; ipc.invoke.mockReset();
    ipc.invoke.mockImplementation((command: string, args?: {requestId: string}) => {
      if (command === "desktop_menu_layout") return new Promise(resolve => ipc.layouts.push({requestId:args!.requestId,resolve}));
      return Promise.resolve(null);
    });
    vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {callback(0); return 1;});
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    holder=document.createElement("div"); document.body.appendChild(holder); root=createRoot(holder);
    await act(async () => {root.render(<DesktopMenuRoot />);});
  });
  afterEach(async () => {await act(async () => root.unmount());holder.remove();vi.unstubAllGlobals();});

  it("does not show an unmeasured window and presents the committed request only", async () => {
    await emit("desktop-menu:show",payload("one"));
    expect(ipc.invoke).not.toHaveBeenCalledWith("desktop_menu_present",expect.anything());
    expect(ipc.layouts[0].requestId).toBe("one");
    await act(async () => ipc.layouts[0].resolve(layout(16)));
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_present",{requestId:"one"});
  });

  it("discards a late layout from the previous menu", async () => {
    await emit("desktop-menu:show",payload("old"));
    await emit("desktop-menu:show",payload("new"));
    await act(async () => ipc.layouts.find(item=>item.requestId==="new")!.resolve(layout(70)));
    await act(async () => ipc.layouts.find(item=>item.requestId==="old")!.resolve(layout(5)));
    expect(holder.querySelector<HTMLElement>(".desktop-menu__panel")!.style.transform).toContain("70px");
    expect(ipc.invoke).not.toHaveBeenCalledWith("desktop_menu_present",{requestId:"old"});
  });

  it("clears content on native dismissal and never revives it from an old layout", async () => {
    await emit("desktop-menu:show",payload("closed"));
    await emit("desktop-menu:reset",{requestId:"closed"});
    await act(async () => ipc.layouts[0].resolve(layout(16)));
    expect(holder.querySelector(".desktop-menu__panel")).toBeNull();
    expect(ipc.invoke).not.toHaveBeenCalledWith("desktop_menu_present",expect.anything());
  });

  it("transparent-area clicks close the exact request and clear its DOM immediately", async () => {
    await emit("desktop-menu:show",payload("outside"));
    await act(async () => {holder.querySelector(".desktop-menu__stage")!.dispatchEvent(new MouseEvent("pointerdown",{bubbles:true}));});
    expect(ipc.invoke).toHaveBeenCalledWith("desktop_menu_close",{requestId:"outside",reason:"outside"});
    expect(holder.querySelector(".desktop-menu__panel")).toBeNull();
  });
});
