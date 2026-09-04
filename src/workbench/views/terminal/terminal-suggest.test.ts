import { describe, expect, it } from "vitest";
import {
  computeSuggestPosition,
  resolveSuggestKey,
  SUGGEST_GAP,
} from "./terminal-suggest";

describe("提示面板定位（原位补全）", () => {
  const viewport = { width: 800, height: 400 };

  it("默认出现在光标右下方（间隔 6px）", () => {
    const pos = computeSuggestPosition(
      { x: 100, y: 50 },
      { width: 300, height: 120 },
      viewport,
    );
    expect(pos.left).toBe(100 + SUGGEST_GAP);
    expect(pos.top).toBe(50 + SUGGEST_GAP);
  });

  it("右侧放不下 → 向左展开（面板右缘在光标左侧 6px）", () => {
    const pos = computeSuggestPosition(
      { x: 700, y: 50 },
      { width: 300, height: 120 },
      viewport,
    );
    expect(pos.left).toBe(700 - SUGGEST_GAP - 300);
    // 垂直方向仍正常：光标下方
    expect(pos.top).toBe(50 + SUGGEST_GAP);
  });

  it("底部放不下 → 翻到光标上方（面板底缘在光标上侧 6px）", () => {
    const pos = computeSuggestPosition(
      { x: 100, y: 350 },
      { width: 300, height: 120 },
      viewport,
    );
    expect(pos.left).toBe(100 + SUGGEST_GAP);
    expect(pos.top).toBe(350 - SUGGEST_GAP - 120);
  });

  it("翻到上方时让开光标所在整行（rowHeight），不盖住正在输入的命令", () => {
    const pos = computeSuggestPosition(
      { x: 100, y: 350, rowHeight: 16 },
      { width: 300, height: 120 },
      viewport,
    );
    // 面板停在光标行上缘（350 - 16）之上再留 6px 间隔 —— 输入行完整可见。
    expect(pos.top).toBe(350 - 16 - SUGGEST_GAP - 120);
  });

  it("带 rowHeight 翻转后上方空间不足 → 仍 clamp 到边缘，不出可视区", () => {
    const pos = computeSuggestPosition(
      { x: 100, y: 191, rowHeight: 16 },
      { width: 300, height: 200 },
      viewport,
    );
    expect(pos.top).toBe(4);
  });

  it("右下都放不下 → 左上双翻转", () => {
    const pos = computeSuggestPosition(
      { x: 700, y: 350 },
      { width: 300, height: 120 },
      viewport,
    );
    expect(pos.left).toBe(700 - SUGGEST_GAP - 300);
    expect(pos.top).toBe(350 - SUGGEST_GAP - 120);
  });

  it("面板比容器还大 → clamp 到边缘（4px），不会跑出可视区", () => {
    const pos = computeSuggestPosition(
      { x: 400, y: 200 },
      { width: 900, height: 500 },
      viewport,
    );
    expect(pos.left).toBe(4);
    expect(pos.top).toBe(4);
  });
});

describe("提示面板键盘映射（面板打开时接管）", () => {
  it("↑/↓ = 移动选择", () => {
    expect(resolveSuggestKey({ key: "ArrowDown" }, true)).toEqual({ type: "move", delta: 1 });
    expect(resolveSuggestKey({ key: "ArrowUp" }, true)).toEqual({ type: "move", delta: -1 });
  });

  it("→ 与 Enter = 填入候选（第一次 Enter 不执行）", () => {
    expect(resolveSuggestKey({ key: "ArrowRight" }, true)).toEqual({ type: "accept" });
    expect(resolveSuggestKey({ key: "Enter" }, true)).toEqual({ type: "accept" });
  });

  it("← / Esc = 关闭面板，恢复 shell 原生方向键", () => {
    expect(resolveSuggestKey({ key: "ArrowLeft" }, true)).toEqual({ type: "dismiss" });
    expect(resolveSuggestKey({ key: "Escape" }, true)).toEqual({ type: "dismiss" });
  });

  it("面板关闭后（无候选）：第二次 Enter 落回 shell 正常执行", () => {
    expect(resolveSuggestKey({ key: "Enter" }, false)).toEqual({ type: "none" });
    expect(resolveSuggestKey({ key: "ArrowDown" }, false)).toEqual({ type: "none" });
  });

  it("输入法组合中绝不拦截（方向键与 Enter 属于 IME 导航）", () => {
    expect(resolveSuggestKey({ key: "Enter", isComposing: true }, true)).toEqual({ type: "none" });
    expect(resolveSuggestKey({ key: "ArrowDown", isComposing: true }, true)).toEqual({
      type: "none",
    });
  });

  it("其他按键不拦截（Tab 是远程补全、字符是输入）", () => {
    expect(resolveSuggestKey({ key: "Tab" }, true)).toEqual({ type: "none" });
    expect(resolveSuggestKey({ key: "a" }, true)).toEqual({ type: "none" });
    expect(resolveSuggestKey({ key: "Backspace" }, true)).toEqual({ type: "none" });
  });
});
