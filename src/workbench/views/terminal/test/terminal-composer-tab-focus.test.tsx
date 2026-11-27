import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalComposer } from "../TerminalComposer";

/**
 * 普通模式：**Tab 只服务命令补全**（用户裁决 2026-11-25）。
 *
 * 能补就补；没有可补的也**不能**把焦点跳到下一个输入框 —— 以前 Tab 在没候选时
 * 直接穿透，用户按 Tab 想补全却看见焦点在表单里乱跳。
 *
 * 这里把补全 hook mock 成"永远没有候选"，于是 Tab 走的就是"补不了"那条路。
 */

vi.mock("@/components/ui/curved-input", () => ({
  CurvedInput: ({
    value,
    onChange,
    onCaretChange,
    onCaretPosition,
  }: {
    value: string;
    onChange: (next: string) => void;
    onCaretChange?: (caret: number) => void;
    onCaretPosition: (point: { x: number; y: number }) => void;
  }) => {
    useEffect(() => onCaretPosition({ x: 100, y: 100 }), [onCaretPosition]);
    return (
      <input
        data-testid="curved-input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          onCaretChange?.(event.target.selectionStart ?? event.target.value.length);
        }}
      />
    );
  },
}));

// 没有任何候选：Tab 既填不进去，也不该跳焦点。
vi.mock("../use-composer-completion", () => ({
  useComposerCompletion: () => ({ items: [], usable: false }),
}));

let holder: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  holder = document.body.appendChild(document.createElement("div"));
  root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    root.render(
      <TerminalComposer
        sessionId="test"
        cwd={null}
        home={null}
        disabled={false}
        interactive={false}
        history={[]}
        onSubmit={() => undefined}
        onInterrupt={() => undefined}
      />,
    );
  });
  const input = holder.querySelector("input")!;
  await act(async () => input.focus());
});

afterEach(async () => {
  await act(async () => root.unmount());
  holder.remove();
  vi.unstubAllGlobals();
});

/** 返回事件本身，方便断言 `defaultPrevented`。 */
async function press(init: KeyboardEventInit): Promise<KeyboardEvent> {
  const input = holder.querySelector("input")!;
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}

async function type(value: string) {
  const input = holder.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("没有可补的内容时，Tab 被吞掉：焦点留在输入框、草稿不动", async () => {
  await type("docker --tail 100");

  const event = await press({ key: "Tab" });

  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(holder.querySelector("input"));
  expect(holder.querySelector<HTMLInputElement>("input")!.value).toBe("docker --tail 100");
});

it("空草稿时 Tab 同样不跳焦点", async () => {
  const event = await press({ key: "Tab" });

  expect(event.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(holder.querySelector("input"));
});

it("Shift+Tab 仍然可以离开输入框（反向焦点导航）", async () => {
  const event = await press({ key: "Tab", shiftKey: true });

  expect(event.defaultPrevented).toBe(false);
});
