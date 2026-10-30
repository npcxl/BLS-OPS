import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OVERLAY_Z } from "@/components/ui/overlay";
import * as toastApi from "@/components/ui/toast";

/**
 * 错误通知的可用性：能重试、能复制、长详情可展开、层级在弹窗之上。
 *
 * 层级那条是真实事故：toast 和 modal 都写 `z-[130]`，谁压谁取决于 DOM 顺序 ——
 * 弹窗一开，保存失败的错误就被遮罩盖住了。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 挂一个 ToastHost，返回可用的推送接口。
 *
 * 这里**不再** `vi.resetModules()` + 动态 import：在共享 worker 里那样做，
 * 动态 import 拿到的模块实例可能和已渲染的组件不是同一份（列表是模块级状态），
 * 于是"推了但屏幕上是空的"。改用静态 import + `clearToasts()` 清场 —— 结果与
 * 机器负载无关。
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

const buttons = () => Array.from(document.body.querySelectorAll("button"));

describe("toast 的错误通知", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("错误提示带重试与复制，重试按钮真的能点", async () => {
    const { toast, unmount } = await mountHost();
    const retry = vi.fn();

    act(() => {
      toast.pushErrorToast(
        { stage: "tcp", message: "Connection refused", detail: "127.0.0.1:3306" },
        { title: "订单库 · 连接失败", retry },
      );
    });

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Connection refused");

    const retryButton = buttons().find((button) => button.textContent?.includes("Retry"));
    expect(retryButton).toBeDefined();
    act(() => retryButton?.click());
    expect(retry).toHaveBeenCalledTimes(1);

    const copyButton = buttons().find(
      (button) => button.getAttribute("aria-label") === "Copy error details",
    );
    expect(copyButton).toBeDefined();

    unmount();
  });

  it("结果未知不给重试按钮", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushErrorToast(
        { stage: "outcome_unknown", message: "COMMIT 期间连接中断" },
        { title: "提交修改", retry: () => undefined },
      );
    });

    const retryButton = buttons().find((button) => button.textContent?.includes("Retry"));
    expect(retryButton).toBeUndefined();
    expect(document.body.textContent).toContain("Outcome unknown");

    unmount();
  });

  it("长详情默认折叠，可展开且限高不溢出", async () => {
    const { toast, unmount } = await mountHost();
    const longDetail = "stack line\n".repeat(80);

    act(() => {
      toast.pushToast("查询失败", "error", { title: "订单库", detail: longDetail });
    });

    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain("stack line");

    const toggle = buttons().find((button) => button.textContent?.trim() === "Show details");
    expect(toggle).toBeDefined();
    act(() => toggle?.click());

    const detail = document.querySelector('[role="alert"] p.whitespace-pre-wrap');
    expect(detail?.textContent).toContain("stack line");
    expect(detail?.className).toContain("max-h-28");
    expect(detail?.className).toContain("overflow-y-auto");
    expect(detail?.className).toContain("break-words");

    unmount();
  });

  it("警告走顶部提醒条（不是右下角一闪而过），超时自动消失", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushToast("该文件超过 8 MiB，只显示了前 256 KiB", "warning");
    });

    const status = document.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    // 卡片外面还有 LiquidGlass 的两层 div，向上找固定定位的那一层。
    expect(status?.closest(".fixed")?.className).toContain("top-3");

    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(document.querySelector('[role="status"]')).toBeNull();

    unmount();
  });

  it("通知层级高于模态框：弹窗开着也看得见错误", async () => {
    const { toast, unmount } = await mountHost();

    act(() => {
      toast.pushToast("保存失败", "error", { persist: true });
    });

    const stack = document.querySelector('[role="alert"]')?.closest(".fixed") as HTMLElement;
    expect(Number(stack.style.zIndex)).toBe(OVERLAY_Z.toast);
    expect(OVERLAY_Z.toast).toBeGreaterThan(OVERLAY_Z.modal);
    expect(OVERLAY_Z.toast).toBeGreaterThan(OVERLAY_Z.select);

    unmount();
  });
});
