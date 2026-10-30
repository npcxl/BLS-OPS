import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * 确认弹窗的三条红线：
 * 1. 连点确认只执行一次（删除 / 重启这类操作重复执行等于事故）；
 * 2. 在输入框里按 Enter 不会误触确认（用户是在填备注，不是在点头）；
 * 3. 不可逆操作必须输入确认词、且确认词不对时按钮不可用。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string) => i18n.t(key) as string;

function buttonByText(text: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

describe("ConfirmDialog", () => {
  let holder: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    holder = document.createElement("div");
    document.body.appendChild(holder);
    root = createRoot(holder);
  });

  afterEach(() => {
    act(() => root.unmount());
    holder.remove();
  });

  it("连续快速点击确认只执行一次", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          open
          danger
          title="删除表"
          description="orders"
          onConfirm={onConfirm}
          onCancel={() => undefined}
        />,
      );
    });

    const confirm = buttonByText(t("Confirm"));
    act(() => {
      confirm.click();
      confirm.click();
      confirm.click();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("在弹窗里的输入框按 Enter 不会确认", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          open
          danger
          title="删除表"
          description="orders"
          onConfirm={onConfirm}
          onCancel={() => undefined}
        >
          <input aria-label="note" defaultValue="drop table orders" />
        </ConfirmDialog>,
      );
    });

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="note"]');
    expect(input).not.toBeNull();

    act(() => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onConfirm).not.toHaveBeenCalled();

    // 直接点按钮才是确认。
    act(() => buttonByText(t("Confirm")).click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("执行中两个按钮都禁用，且 Esc 不会关掉它", () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          open
          pending
          danger
          title="重启服务"
          description="nginx"
          onConfirm={() => undefined}
          onCancel={onCancel}
        />,
      );
    });

    expect(buttonByText(t("Cancel")).disabled).toBe(true);
    expect(buttonByText(t("Processing")).disabled).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe(
      "true",
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("不可逆操作要输入确认词，填对之前确认按钮不可用", () => {
    const onConfirm = vi.fn();
    act(() => {
      root.render(
        <ConfirmDialog
          open
          risk="irreversible"
          title="删除凭据"
          description="prod-key"
          confirmPhrase="prod-key"
          onConfirm={onConfirm}
          onCancel={() => undefined}
        />,
      );
    });

    const confirm = buttonByText(t("Confirm"));
    expect(confirm.disabled).toBe(true);

    const input = document.body.querySelector<HTMLInputElement>("[data-confirm-phrase]");
    expect(input).not.toBeNull();

    // 输错不放开。
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "prod");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(buttonByText(t("Confirm")).disabled).toBe(true);

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "prod-key");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => buttonByText(t("Confirm")).click());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("执行失败时错误留在弹窗里，弹窗不关闭", () => {
    act(() => {
      root.render(
        <ConfirmDialog
          open
          risk="danger"
          title="删除键"
          description="user:1"
          error="NOAUTH Authentication required"
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("NOAUTH Authentication required");
  });
});
