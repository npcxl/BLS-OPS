/**
 * 命令面板的键盘交互回归测试。
 *
 * 这一组针对的是"Ctrl+K 打开后 ↑↓ 选中、回车没反应"：回车必须执行**当前
 * 高亮**的那一项并关闭面板，而不是被面板副作用吞掉。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { CommandPalette, type PaletteAction } from "../command-palette";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function action(id: string, onSelect: () => void): PaletteAction {
  return { id, title: id, category: "Test", onSelect };
}

function mount(actions: PaletteAction[]) {
  const onClose = vi.fn();
  act(() => {
    root.render(<CommandPalette open actions={actions} onClose={onClose} />);
  });
  return { onClose };
}

function press(key: string, target: EventTarget = window) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("CommandPalette keyboard", () => {
  it("runs the highlighted action on Enter and closes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { onClose } = mount([action("alpha", first), action("beta", second)]);

    press("ArrowDown");
    press("Enter");

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs the first action without any arrow key", () => {
    const first = vi.fn();
    const { onClose } = mount([action("alpha", first), action("beta", vi.fn())]);

    press("Enter");

    expect(first).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not wrap around past the last item", () => {
    const last = vi.fn();
    const { onClose } = mount([action("alpha", vi.fn()), action("omega", last)]);

    press("ArrowDown");
    press("ArrowDown");
    press("Enter");

    expect(last).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("still closes when the action throws", () => {
    // 动作同步抛错时，面板不能停在"按了回车但什么也没发生"的状态。
    const boom = vi.fn(() => {
      throw new Error("boom");
    });
    const { onClose } = mount([action("boom", boom)]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    press("Enter");

    expect(boom).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores Enter while an input method is composing", () => {
    const first = vi.fn();
    const { onClose } = mount([action("alpha", first)]);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
      );
    });

    expect(first).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
