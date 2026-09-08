import { describe, expect, it } from "vitest";
import {
  computeSuggestPosition,
  ghostTextFor,
  keysForReplace,
  resolveTerminalCompleteKey,
  SUGGEST_GAP,
} from "../terminal-suggest";

const BS = "\x7f"; // Backspace

describe("把统一候选写回 shell（replaceRange → 按键序列）", () => {
  it("只退掉还没敲完的那一段，再写入候选", () => {
    // `cd o` + 候选 `opt/` → 退 1 格，写 `opt/`。
    expect(keysForReplace("cd o", { start: 3, end: 4 }, "opt/")).toBe(`${BS}opt/`);
  });

  it("写入带空格的路径（转义后的文本原样进 shell）", () => {
    expect(keysForReplace("cd m", { start: 3, end: 4 }, '"my dir"/')).toBe(`${BS}"my dir"/`);
  });

  it("目录保留结尾 / ，补全后能继续提示下一层", () => {
    const keys = keysForReplace("cd ", { start: 3, end: 3 }, "opt/");
    expect(keys).toBe("opt/");
    expect(keys.endsWith("/")).toBe(true);
  });

  it("整行替换（环境生成的命令）不需要退格之外的操作", () => {
    expect(keysForReplace("nginx", { start: 0, end: 5 }, "docker exec bls-nginx nginx -t")).toBe(
      `${BS.repeat(5)}docker exec bls-nginx nginx -t`,
    );
  });

  it("替换范围被夹到行的合法区间内（不会退过头）", () => {
    expect(keysForReplace("cd", { start: 99, end: 99 }, "opt/")).toBe("opt/");
    expect(keysForReplace("cd", { start: -5, end: 99 }, "opt/")).toBe(`${BS.repeat(2)}opt/`);
  });

  it("空操作（候选与行内内容一致）不产生任何按键", () => {
    expect(keysForReplace("cd opt/", { start: 6, end: 7 }, "/")).toBe(BS + "/");
    expect(keysForReplace("cd opt/", { start: 7, end: 7 }, "")).toBe("");
  });
});

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

describe("统一补全状态机（默认 ghost，Tab/↓ 才展开面板）", () => {
  const expanded = { expanded: true, hasItems: true };
  const collapsed = { expanded: false, hasItems: true };
  const empty = { expanded: false, hasItems: false };

  it("collapsed：Tab / ArrowDown = 接受第一条并展开面板（唯一出现方式）", () => {
    expect(resolveTerminalCompleteKey({ key: "Tab" }, collapsed)).toEqual({ type: "accept-first" });
    expect(resolveTerminalCompleteKey({ key: "ArrowDown" }, collapsed)).toEqual({
      type: "accept-first",
    });
  });

  it("collapsed：Enter = 直接执行第一条；无候选 = 穿透给 shell 执行原始命令", () => {
    expect(resolveTerminalCompleteKey({ key: "Enter" }, collapsed)).toEqual({ type: "run-first" });
    expect(resolveTerminalCompleteKey({ key: "Enter" }, empty)).toEqual({ type: "none" });
  });

  it("expanded：↑/↓ 移动，Enter 执行当前项，Tab/→ 填入当前项", () => {
    expect(resolveTerminalCompleteKey({ key: "ArrowDown" }, expanded)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(resolveTerminalCompleteKey({ key: "ArrowUp" }, expanded)).toEqual({
      type: "move",
      delta: -1,
    });
    expect(resolveTerminalCompleteKey({ key: "Enter" }, expanded)).toEqual({ type: "run-active" });
    expect(resolveTerminalCompleteKey({ key: "Tab" }, expanded)).toEqual({ type: "accept-active" });
    expect(resolveTerminalCompleteKey({ key: "ArrowRight" }, expanded)).toEqual({
      type: "accept-active",
    });
  });

  it("任何状态 Esc = 清空整行（清输入/ghost/面板）", () => {
    expect(resolveTerminalCompleteKey({ key: "Escape" }, collapsed)).toEqual({ type: "clear-line" });
    expect(resolveTerminalCompleteKey({ key: "Escape" }, expanded)).toEqual({ type: "clear-line" });
    expect(resolveTerminalCompleteKey({ key: "Escape" }, empty)).toEqual({ type: "clear-line" });
  });

  it("无候选时 Tab/↓ 不接管（终端 Tab 穿透给远程 shell 补全）", () => {
    expect(resolveTerminalCompleteKey({ key: "Tab" }, empty)).toEqual({ type: "none" });
    expect(resolveTerminalCompleteKey({ key: "ArrowDown" }, empty)).toEqual({ type: "none" });
  });

  it("输入法组合中绝不拦截", () => {
    expect(
      resolveTerminalCompleteKey({ key: "Enter", isComposing: true }, collapsed),
    ).toEqual({ type: "none" });
    expect(resolveTerminalCompleteKey({ key: "ArrowDown", isComposing: true }, expanded)).toEqual({
      type: "none",
    });
  });

  it("其他按键不拦截（字符是输入；ArrowUp 在 collapsed 是 shell 历史）", () => {
    expect(resolveTerminalCompleteKey({ key: "a" }, collapsed)).toEqual({ type: "none" });
    expect(resolveTerminalCompleteKey({ key: "Backspace" }, expanded)).toEqual({ type: "none" });
    expect(resolveTerminalCompleteKey({ key: "ArrowUp" }, collapsed)).toEqual({ type: "none" });
  });
});

describe("行内 ghost 文本（第一条候选的剩余部分）", () => {
  it("token 替换类：去掉已敲的 partial（cd o + ops/ → ps/）", () => {
    expect(ghostTextFor({ insertText: "ops/" }, "cd o", "o")).toBe("ps/");
  });

  it("全语法类：去掉与整行重合的前缀（docker p + docker ps -a → s -a）", () => {
    expect(ghostTextFor({ insertText: "docker ps -a" }, "docker p", "p")).toBe("s -a");
  });

  it("裸 cd：整条显示（自带前导空格 —— ghost 前自动含空格）", () => {
    expect(ghostTextFor({ insertText: " ops/" }, "cd", "cd")).toBe(" ops/");
  });

  it("空输入或无候选 → 空串（不显示 ghost）", () => {
    expect(ghostTextFor({ insertText: "docker ps -a" }, "", null)).toBe("");
    expect(ghostTextFor({ insertText: "docker ps -a" }, "   ", null)).toBe("");
    expect(ghostTextFor(undefined, "docker p", "p")).toBe("");
  });
});
