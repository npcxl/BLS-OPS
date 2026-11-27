import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Select } from "@/components/ui/select";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Select", () => {
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
    document.body.innerHTML = "";
  });

  it("渲染两行 description、分组分隔线并支持键盘快速检索", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <Select
          variant="menu"
          testId="perm-select"
          ariaLabel="权限"
          value="readonly"
          onChange={onChange}
          options={[
            { value: "readonly", label: "Read only", description: "Only queries" },
            { value: "ask", label: "Ask first", description: "Confirm writes" },
            { value: "full", label: "Full access", description: "Direct writes", tone: "warning" },
            { value: "manage", label: "Manage rules", separatorBefore: true },
          ]}
        />,
      );
    });

    const trigger = holder.querySelector<HTMLButtonElement>('[data-testid="perm-select"]')!;
    act(() => trigger.click());

    const menu = document.body.querySelector<HTMLElement>(".select-menu")!;
    expect(menu).not.toBeNull();
    expect(menu.textContent).toContain("Confirm writes");
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();

    // 键入 'f' 跳到 Full access，按 Enter 确认。
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    });
    act(() => {
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith("full");
  });

  it("鼠标点选选项后不会残留滞留的 Tooltip", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(
        <Select
          variant="menu"
          testId="perm-select"
          ariaLabel="权限"
          title="完全访问说明"
          value="ask"
          onChange={onChange}
          options={[
            { value: "ask", label: "按需确认" },
            { value: "full", label: "完全访问" },
          ]}
        />,
      );
    });

    const trigger = holder.querySelector<HTMLButtonElement>('[data-testid="perm-select"]')!;
    act(() => {
      trigger.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      trigger.click();
    });

    const fullOption = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((item) => item.textContent?.includes("完全访问"))!;
    act(() => fullOption.click());

    expect(onChange).toHaveBeenCalledWith("full");
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });
});
