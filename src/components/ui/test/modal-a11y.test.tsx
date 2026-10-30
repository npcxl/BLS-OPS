import "@/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui/modal";

/**
 * 弹窗的键盘与焦点契约。
 *
 * 之前每个 Modal 都在 window 上挂一个自己的 Esc 监听，嵌套弹窗（文件编辑器
 * → 版本冲突）按一次 Esc 会**同时**关掉两层；焦点也从不归还，关掉弹窗后
 * 键盘焦点掉在 body 上，Tab 得从头走一遍。
 */

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const FRAME = () =>
  new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

const dialog = (index = -1) => {
  const all = document.body.querySelectorAll<HTMLElement>('[role="dialog"]');
  return index < 0 ? all[all.length - 1] : all[index];
};

const pressEscape = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

describe("Modal 焦点与 Esc", () => {
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

  it("打开时把焦点移进弹窗，关闭后还给原来的控件", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      root.render(
        <Modal open title="编辑" onClose={() => undefined}>
          <input aria-label="name" />
        </Modal>,
      );
    });
    await act(async () => {
      await FRAME();
    });

    // 焦点落在第一个输入框，而不是背后的按钮或右上角的 ×。
    expect(document.activeElement?.getAttribute("aria-label")).toBe("name");

    act(() => {
      root.render(
        <Modal open={false} title="编辑" onClose={() => undefined}>
          <input aria-label="name" />
        </Modal>,
      );
    });

    expect(document.activeElement).toBe(trigger);
  });

  it("嵌套弹窗时 Esc 只关最上层", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();

    const tree = (innerOpen: boolean) => (
      <Modal open title="编辑器" onClose={closeOuter}>
        <p>outer</p>
        <Modal open={innerOpen} title="覆盖确认" onClose={closeInner}>
          <p>inner</p>
        </Modal>
      </Modal>
    );

    act(() => {
      root.render(tree(true));
    });
    await act(async () => {
      await FRAME();
    });
    expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(2);

    pressEscape();
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();

    // 上层关掉之后，Esc 才轮到下层。
    act(() => {
      root.render(tree(false));
    });
    await act(async () => {
      await FRAME();
    });
    pressEscape();
    expect(closeOuter).toHaveBeenCalledTimes(1);
  });

  it("Tab 在弹窗内循环，不跑到背后的页面", async () => {
    act(() => {
      root.render(
        <Modal open title="表单" onClose={() => undefined}>
          <button type="button">first</button>
          <button type="button">last</button>
        </Modal>,
      );
    });
    await act(async () => {
      await FRAME();
    });

    const panel = dialog();
    const buttons = Array.from(panel.querySelectorAll("button"));
    const last = buttons[buttons.length - 1];
    last.focus();

    act(() => {
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });

    expect(document.activeElement).toBe(buttons[0]);
  });

  it("带 aria 语义，并且点遮罩可以关、点面板不会关", async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal open title="连接" description="密码保存在系统钥匙串" onClose={onClose}>
          <p>body</p>
        </Modal>,
      );
    });
    await act(async () => {
      await FRAME();
    });

    const panel = dialog();
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const labelledBy = panel.getAttribute("aria-labelledby");
    expect(labelledBy && document.getElementById(labelledBy)?.textContent).toBe("连接");

    act(() => {
      panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const scrim = panel.parentElement as HTMLElement;
    act(() => {
      scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("busy 时 Esc 与遮罩都不关闭（执行中不许误关）", async () => {
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Modal open busy title="保存中" onClose={onClose}>
          <p>body</p>
        </Modal>,
      );
    });
    await act(async () => {
      await FRAME();
    });

    pressEscape();
    const panel = dialog();
    act(() => {
      (panel.parentElement as HTMLElement).dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
