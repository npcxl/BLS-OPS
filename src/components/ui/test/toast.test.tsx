import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as toastApi from "@/components/ui/toast";

/**
 * 错误提示必须**在屏幕上沿**、常驻到用户关掉。
 *
 * 之前所有 toast 都堆在右下角、6 秒就消失，数据库连接失败这类错误用户根本
 * 看不见（他那时正盯着左边的树或表单）。这组用例锁死：错误去顶部、常驻、
 * 有 × 可关、长详情不截断。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/**
 * 挂一个 ToastHost。
 *
 * items 是模块级状态：改用 `clearToasts()` 清场，而不是 `vi.resetModules()`
 * 重载模块 —— 共享 worker 里动态 import 可能拿到与已渲染组件不同的实例，
 * 表现为"推了消息但屏幕是空的"（只在满载并行时才复现）。
 */
async function mountHost() {
  toastApi.clearToasts();
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<toastApi.ToastHost />);
  });
  return {
    toast: toastApi,
    unmount: () => act(() => root.unmount()),
  };
}

describe("toast / alert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("错误显示在顶部、常驻、带阶段与详情，并且有可点的关闭按钮", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushToast("WRONGPASS invalid username-password pair", "error", {
        title: "缓存 · Redis 连接失败",
        label: "auth",
        detail: "127.0.0.1:6379 · tcp",
      });
    });

    const alert = document.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const text = alert?.textContent ?? "";
    expect(text).toContain("WRONGPASS");
    expect(text).toContain("auth");
    expect(text).toContain("连接失败");
    // 详情完整显示，不截断。
    expect(text).toContain("127.0.0.1:6379");

    // 位置：顶部居中（不是右下角那种容易被忽略的地方）。
    const stack = alert?.parentElement;
    expect(stack?.className).toContain("top-3");
    expect(stack?.className).toContain("left-1/2");

    // 常驻：推进两分钟仍在。
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();

    // 关得掉。
    const close = alert?.querySelector<HTMLButtonElement>('button[aria-label="dismiss"]');
    expect(close).not.toBeNull();
    act(() => {
      close?.click();
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();

    unmount();
  });

  it("成功提示仍是轻提示：几秒后自动消失", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushToast("已保存连接", "success");
    });
    expect(document.body.textContent).toContain("已保存连接");
    // 轻提示不该占用错误区。
    expect(document.querySelector('[role="alert"]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(document.body.textContent).not.toContain("已保存连接");

    unmount();
  });

  it("同一条错误重复推送不会堆成一墙", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushToast("连接被拒绝", "error", { title: "缓存 · 连接失败" });
      toast.pushToast("连接被拒绝", "error", { title: "缓存 · 连接失败" });
      toast.pushToast("连接被拒绝", "error", { title: "缓存 · 连接失败" });
    });

    expect(document.querySelectorAll('[role="alert"]').length).toBe(1);

    unmount();
  });
});
