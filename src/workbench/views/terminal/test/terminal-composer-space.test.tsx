import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalComposer } from "../TerminalComposer";

/**
 * 弧形输入栏「空格 / Tab / 浮层」联动的组件级测试。
 *
 * CurvedInput 用受控 `<input>` 替身（真的 SVG 需要 `getSubStringLength` 等
 * jsdom 不提供的 API），其余全部走真实逻辑：补全 hook 被 mock 成"永远有两条
 * 候选"，于是能否被 Tab 选中**只取决于浮层是否真的显示** —— 正是要验证的东西。
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

// 始终返回两条候选：浮层显隐因此完全由 composer 的 autoAllowed 决定。
vi.mock("../use-composer-completion", () => ({
  useComposerCompletion: ({ text }: { text: string }) => ({
    usable: true,
    items: [
      {
        label: "docker",
        source: "command",
        insertText: "docker ",
        detail: "",
        type: "command",
        icon: "command",
        // 替换整行当前输入（相当于把正在编辑的那个词补完）。
        replaceRange: { start: 0, end: text.length },
        priority: 1,
      },
      {
        label: "dockerd",
        source: "command",
        insertText: "dockerd ",
        detail: "",
        type: "command",
        icon: "command",
        replaceRange: { start: 0, end: text.length },
        priority: 1,
      },
    ],
  }),
}));

let holder: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 用同一组 props 重渲染（模拟"远程候选结果晚到"引发的状态更新）。 */
const renderComposer = () =>
  root.render(
    <TerminalComposer
      sessionId="test"
      cwd={null}
      home={null}
      disabled={false}
      interactive={false}
      history={[]}
      onSubmit={() => {}}
      onInterrupt={() => {}}
    />,
  );

beforeEach(async () => {
  holder = document.body.appendChild(document.createElement("div"));
  root = createRoot(holder);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderComposer();
  });
  const input = holder.querySelector("input")!;
  await act(async () => input.focus());
});

afterEach(async () => {
  await act(async () => root.unmount());
  holder.remove();
  vi.unstubAllGlobals();
});

/** 模拟用户输入（React 受控组件必须走原生 setter + input 事件）。 */
async function type(value: string, caret?: number) {
  const input = holder.querySelector<HTMLInputElement>("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    // 光标位置决定"当前在编辑哪一段"：命令中间插入空格时必须能复现。
    input.setSelectionRange(caret ?? value.length, caret ?? value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(init: KeyboardEventInit) {
  const input = holder.querySelector<HTMLInputElement>("input")!;
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

const candidate = () => document.querySelector<HTMLButtonElement>('button[title="docker "]');

it("输入命令时浮层出现", async () => {
  await type("docker");
  expect(candidate()).toBeTruthy();
});

it("按空格只插入空格：浮层收起，Tab 不会填入隐藏候选", async () => {
  await type("docker");
  expect(candidate()).toBeTruthy();

  await type("docker ");
  // 浮层（含隐藏候选）必须消失 —— 这是"空格被提示挡住"的根因修复。
  expect(candidate()).toBeFalsy();

  // 此时 Tab 恢复正常的焦点导航，不能把 `docker ` 改成任何候选。
  await press({ key: "Tab" });
  expect(holder.querySelector<HTMLInputElement>("input")!.value).toBe("docker ");
});

it("空格后继续输入下一个词，浮层立刻回来", async () => {
  await type("docker ");
  expect(candidate()).toBeFalsy();

  await type("docker l");
  expect(candidate()).toBeTruthy();
});

it("Ctrl+Space 在空格之后也能主动调出候选", async () => {
  await type("docker ");
  expect(candidate()).toBeFalsy();

  await press({ key: " ", code: "Space", ctrlKey: true });
  expect(candidate()).toBeTruthy();
});

it("Tab 填入带尾随空格的候选后，下一轮不会立即弹出", async () => {
  await type("dock");
  expect(candidate()).toBeTruthy();

  await press({ key: "Tab" });
  const input = holder.querySelector<HTMLInputElement>("input")!;
  // 填入的是"看到的那条"（首选 docker），并带上尾随空格。
  expect(input.value).toBe("docker ");
  // 尾随空格 = 刚结束一个词 → 浮层不在下一轮立刻弹出来。
  expect(candidate()).toBeFalsy();
});

it("命令中间插入空格后按 Tab：不填入隐藏候选，后续参数保留", async () => {
  // `docker  --tail 100`，光标停在中间那个空格之后（下标 7）。
  await type("docker  --tail 100", 7);
  expect(candidate()).toBeFalsy();

  await press({ key: "Tab" });
  // 既不填候选，也不破坏后面已经打好的参数。
  expect(holder.querySelector<HTMLInputElement>("input")!.value).toBe("docker  --tail 100");
});

it("Esc 收起后，远程候选晚到也不会重新弹出浮层", async () => {
  await type("docker");
  expect(candidate()).toBeTruthy();

  await press({ key: "Escape" });
  expect(candidate()).toBeFalsy();

  // 模拟远程目录/容器结果到达：组件拿到新候选后重渲染。
  await act(async () => {
    renderComposer();
  });
  expect(candidate()).toBeFalsy();

  // 隐藏状态下 Tab 也不能填入任何东西。
  await press({ key: "Tab" });
  expect(holder.querySelector<HTMLInputElement>("input")!.value).toBe("docker");
});
