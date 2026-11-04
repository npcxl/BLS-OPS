import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbColumn, DbValue } from "@/api/types/database";
import { VirtualDataGrid, type DataGridApi } from "../VirtualDataGrid";

const columns: DbColumn[] = Array.from({length: 10}, (_, index) => ({
  index, name: `column_${index}`, org_name: `column_${index}`, table: "t", org_table: "t",
  type_name: "varchar", type_code: 253, nullable: true, unsigned: false, binary: false,
  primary_key: false, auto_increment: false, decimals: 0, charset: 33,
}));
const rows: DbValue[][] = Array.from({length: 200}, (_, row) => columns.map((_, col) => ({
  kind: "text", value: `${row}:${col}`, bytes: 8, truncated: false,
})));
let holder: HTMLDivElement;
let root: Root;
let grid: HTMLDivElement;
let api: {current: DataGridApi | null};
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
const fire = (target: EventTarget, type: string, x: number, y: number, buttons = 1) => {
  const event = new MouseEvent(type, {clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true});
  const content = target === grid && type === "mousedown" && x < 600 && y < 300 ? grid.firstElementChild! : target;
  act(() => { content.dispatchEvent(event); });
  return event;
};
const tick = () => act(() => {
  const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16));
});
beforeEach(() => {
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map(); frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
  holder = document.createElement("div"); document.body.appendChild(holder); root = createRoot(holder); api = {current: null};
  act(() => root.render(<VirtualDataGrid columns={columns} rows={rows} selectionKey="result-1" editable={false} apiRef={api} />));
  grid = holder.querySelector('[role="grid"]')!;
  Object.defineProperties(grid, {clientWidth: {value: 600}, clientHeight: {value: 300}});
  vi.spyOn(grid, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 616, 316));
});
afterEach(() => { act(() => root.unmount()); holder.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("native scrolling does not start grid selection", () => {
  it("retains selection for draft value updates and resets it for a new result", () => {
    act(()=>api.current!.focusCell({row:2,col:1}));
    const updated=rows.map((row,index)=>index===2?[...row]:row);
    act(()=>root.render(<VirtualDataGrid columns={columns} rows={updated} selectionKey="result-1" editable={false} apiRef={api}/>));
    expect(api.current!.getFocus()).toEqual({row:2,col:1});
    act(()=>root.render(<VirtualDataGrid columns={columns} rows={updated} selectionKey="result-2" editable={false} apiRef={api}/>));
    expect(api.current!.getFocus()).toBeNull();
  });
  it.each([[610,100], [200,310], [610,310]])("leaves the native scrollbar/corner (%i,%i) alone", (x,y) => {
    act(() => api.current!.focusCell({row: 2, col: 1}));
    const selected = api.current!.getSelection();
    const event = fire(grid, "mousedown", x, y);
    expect(event.defaultPrevented).toBe(false);
    fire(window, "mousemove", x + 5, y + 50);
    tick();
    expect(api.current!.getSelection()).toEqual(selected);
    expect(grid.scrollTop).toBe(0); expect(grid.scrollLeft).toBe(0);
  });
  it("does not auto-scroll just because a held click is near an edge", () => {
    fire(grid, "mousedown", 595, 295); tick(); tick();
    expect(grid.scrollTop).toBe(0); expect(grid.scrollLeft).toBe(0);
    fire(window, "mouseup", 595, 295, 0);
  });
  it("keeps cell selection mode when dragging across row and column headers", () => {
    fire(grid, "mousedown", 200, 100);
    fire(window, "mousemove", 10, 140);
    expect(api.current!.getSelection().mode).toBe("cell");
    fire(window, "mousemove", 250, 5);
    expect(api.current!.getSelection().mode).toBe("cell");
    fire(window, "mouseup", 250, 5, 0);
  });
  it("stops a gesture when mouseup was missed or the window loses focus", () => {
    fire(grid, "mousedown", 200, 100);
    fire(window, "mousemove", 260, 160, 0);
    const selected = api.current!.getSelection();
    fire(window, "mousemove", 595, 295); tick();
    expect(api.current!.getSelection()).toEqual(selected);
    expect(grid.scrollTop).toBe(0);
    fire(grid, "mousedown", 200, 100);
    act(() => window.dispatchEvent(new Event("blur")));
    fire(window, "mousemove", 595, 295); tick();
    expect(grid.scrollTop).toBe(0);
  });
  it("still auto-scrolls during a real selection drag", () => {
    fire(grid, "mousedown", 200, 100);
    fire(window, "mousemove", 595, 295); tick();
    expect(grid.scrollTop).toBeGreaterThan(0); expect(grid.scrollLeft).toBeGreaterThan(0);
    fire(window, "mouseup", 595, 295, 0);
  });
  it("does not scroll the other axis during a row or column gesture", () => {
    grid.scrollLeft = 100;
    fire(grid, "mousedown", 10, 100); fire(window, "mousemove", 5, 295); tick();
    expect(grid.scrollLeft).toBe(100); expect(grid.scrollTop).toBeGreaterThan(0);
    fire(window, "mouseup", 5, 295, 0);
    grid.scrollTop = 100;
    fire(grid, "mousedown", 200, 10); fire(window, "mousemove", 595, 5); tick();
    expect(grid.scrollTop).toBe(100); expect(grid.scrollLeft).toBeGreaterThan(100);
    fire(window, "mouseup", 595, 5, 0);
  });
});
