import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useScopedShortcut, type ScopedShortcut } from "../shortcuts";

/**
 * 快捷键只该在"当前工作项活动"时响应。
 * 这组用例锁的是三条规则：enabled 闸门、修饰键精确匹配、输入框守卫。
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Harness(props: Partial<ScopedShortcut> & { onFire: () => void }) {
  const { onFire, ...rest } = props;
  useScopedShortcut({
    key: "s",
    ctrl: true,
    enabled: true,
    run: onFire,
    ...rest,
  });
  return null;
}

function press(
  key: string,
  options: { ctrl?: boolean; shift?: boolean; target?: HTMLElement } = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    ctrlKey: options.ctrl ?? false,
    shiftKey: options.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  (options.target ?? document.body).dispatchEvent(event);
  return event;
}

describe("useScopedShortcut", () => {
  let container: HTMLDivElement;
  let root: Root;
  // 显式声明成 `() => void` 的 mock：`ReturnType<typeof vi.fn>` 太宽，
  // 传给 `onFire: () => void` 的 Harness 会报类型不兼容。
  let onFire: Mock<() => void>;

  beforeEach(() => {
    onFire = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("enabled=false 时完全不响应（隐藏工作项不抢快捷键）", () => {
    act(() => root.render(<Harness enabled={false} onFire={onFire} />));
    press("s", { ctrl: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("Ctrl+S 触发一次并阻止默认行为", () => {
    act(() => root.render(<Harness onFire={onFire} />));
    const event = press("s", { ctrl: true });
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("少了 Ctrl 或多了 Shift 都不触发", () => {
    act(() => root.render(<Harness onFire={onFire} />));
    press("s");
    press("s", { ctrl: true, shift: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("默认在输入框里不触发，allowInInput 后触发", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    act(() => root.render(<Harness onFire={onFire} />));
    press("s", { ctrl: true, target: input });
    expect(onFire).not.toHaveBeenCalled();

    act(() => root.render(<Harness onFire={onFire} allowInInput />));
    press("s", { ctrl: true, target: input });
    expect(onFire).toHaveBeenCalledTimes(1);

    input.remove();
  });

  it("卸载后监听被移除", () => {
    act(() => root.render(<Harness onFire={onFire} />));
    act(() => root.render(<Harness enabled={false} onFire={onFire} />));
    press("s", { ctrl: true });
    expect(onFire).not.toHaveBeenCalled();
  });
});
