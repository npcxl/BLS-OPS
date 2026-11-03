/**
 * 菜单动作的执行规则（桌面窗口路径）。
 *
 * 覆盖的是"原生窗口里点一下之后"的那一段，不涉及布局：
 * - 一次选择最多执行一次（连点/重复事件不跑两遍业务）；
 * - 旧 requestId 的迟到事件不执行、也不影响新菜单；
 * - 同步抛错与 Promise 拒绝都变成来源窗口的一条错误提示（绝不静默失败）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: unknown) => undefined as unknown),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  toast: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => h.invoke(command, args),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    h.listeners.set(name, handler);
    return () => h.listeners.delete(name);
  },
}));

vi.mock("@/components/ui/toast", () => ({
  pushToast: (...args: unknown[]) => h.toast(...args),
}));

import { cancelDesktopMenu, openDesktopMenu } from "../bridge";
import type { ContextMenuItem } from "@/components/ui/context-menu";

/** 最近一次 `desktop_menu_show` 的 requestId。 */
function lastRequestId(): string {
  const call = [...h.invoke.mock.calls].reverse().find(([name]) => name === "desktop_menu_show");
  expect(call).toBeTruthy();
  return (call![1] as { payload: { requestId: string } }).payload.requestId;
}

function fireSelect(requestId: string, actionId: string): void {
  h.listeners.get("desktop-menu:select")!({ payload: { requestId, actionId } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  cancelDesktopMenu();
  h.invoke.mockClear();
  h.toast.mockClear();
});

describe("菜单动作只执行一次", () => {
  it("重复的 select 事件不会跑两遍业务", async () => {
    const run = vi.fn();
    await openDesktopMenu([{ label: "打开", onSelect: run }], { x: 10, y: 10 });
    const requestId = lastRequestId();

    fireSelect(requestId, "a0");
    fireSelect(requestId, "a0");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("pending 被提前摘掉后，这次菜单的点击仍然执行一次", async () => {
    const run = vi.fn();
    await openDesktopMenu([{ label: "打开连接", onSelect: run }], { x: 10, y: 10 });
    const requestId = lastRequestId();

    // 模拟来源窗口 blur / 兜底超时把本地 pending 摘掉，而原生窗口仍在屏幕上：
    // 用户此刻点菜单项，动作**不能**被静默吞掉。
    cancelDesktopMenu("blur");
    fireSelect(requestId, "a0");
    expect(run).toHaveBeenCalledTimes(1);

    // 重复的迟到事件依然只执行一次。
    fireSelect(requestId, "a0");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("未登记的动作 id 被丢弃", async () => {
    const run = vi.fn();
    await openDesktopMenu([{ label: "打开", onSelect: run }], { x: 10, y: 10 });
    fireSelect(lastRequestId(), "a9");
    expect(run).not.toHaveBeenCalled();
  });

  it("旧菜单的迟到事件不会影响新菜单", async () => {
    const first = vi.fn();
    await openDesktopMenu([{ label: "A", onSelect: first }], { x: 10, y: 10 });
    const staleRequest = lastRequestId();

    const second = vi.fn();
    await openDesktopMenu([{ label: "B", onSelect: second }], { x: 40, y: 40 });
    const currentRequest = lastRequestId();
    expect(currentRequest).not.toBe(staleRequest);

    fireSelect(staleRequest, "a0");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    fireSelect(currentRequest, "a0");
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("失败必须看得见", () => {
  it("同步抛错变成一条错误提示", async () => {
    const run = vi.fn(() => {
      throw new Error("连接已断开");
    });
    await openDesktopMenu([{ label: "删除", onSelect: run }], { x: 10, y: 10 });

    fireSelect(lastRequestId(), "a0");
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(String(h.toast.mock.calls[0][0])).toContain("连接已断开");
  });

  it("异步失败同样回到来源窗口", async () => {
    const run = vi.fn(async () => {
      throw new Error("权限不足");
    });
    await openDesktopMenu([{ label: "清空", onSelect: run }], { x: 10, y: 10 });

    fireSelect(lastRequestId(), "a0");
    await flush();

    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(String(h.toast.mock.calls[0][0])).toContain("权限不足");
  });

  it("菜单窗口未能显示时也有提示，而不是静默失败", async () => {
    await openDesktopMenu([{ label: "打开", onSelect: vi.fn() }], { x: 10, y: 10 });
    const requestId = lastRequestId();

    h.listeners.get("desktop-menu:closed")!({
      payload: { requestId, reason: "layout-error" },
    });

    expect(h.toast).toHaveBeenCalledTimes(1);
  });

  it("没有 onSelect 的展示项不登记动作", async () => {
    const handlers = new Map<string, () => void>();
    const { toWireMenu } = await import("../bridge");
    const wire = toWireMenu(
      [{ label: "仅展示" }, { label: "可执行", onSelect: () => undefined }] as ContextMenuItem[],
      handlers,
    );
    expect(wire[0].actionId).toBeUndefined();
    expect(wire[1].actionId).toBe("a0");
    expect(handlers.size).toBe(1);
  });

  it("禁用原因随菜单项一起过桥（与主窗口读同一句）", async () => {
    const { toWireMenu } = await import("../bridge");
    const handlers = new Map<string, () => void>();
    const wire = toWireMenu(
      [{ label: "复制表", disabled: true, reason: "SQLite 没有 CREATE TABLE … LIKE" }],
      handlers,
    );
    expect(wire[0]).toMatchObject({
      disabled: true,
      reason: "SQLite 没有 CREATE TABLE … LIKE",
    });
  });
});
