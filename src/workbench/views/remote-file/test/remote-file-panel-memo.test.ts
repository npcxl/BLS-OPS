/**
 * 文件面板的渲染隔离约束。
 *
 * 背景：终端每敲一个键都会更新 draft 并重渲染父组件。文件面板是它的子组件，
 * 一旦退回普通函数组件，每次按键都会重跑面板渲染（含全部 entries 的遍历），
 * 用户感知就是"开着文件面板时输入卡"。
 *
 * 这里不渲染整个面板（它依赖 xterm / CodeMirror / Tauri IPC），只钉住
 * "导出仍然是 memo 组件"这一结构约束，成本低且不会被日常改动悄悄破坏。
 */

import { describe, expect, it } from "vitest";

import { RemoteFilePanel } from "../RemoteFilePanel";

describe("RemoteFilePanel", () => {
  it("是 memo 组件（父组件每键重渲染时会被短路）", () => {
    const tag = (RemoteFilePanel as unknown as { $$typeof?: symbol }).$$typeof;
    expect(tag).toBe(Symbol.for("react.memo"));
  });
});
