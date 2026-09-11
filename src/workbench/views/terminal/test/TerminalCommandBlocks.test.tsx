import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";

import "@/i18n";

const copyText = vi.fn(async (_text: string) => true);
vi.mock("@/lib/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { TerminalCommandBlocks } from "../TerminalCommandBlocks";
import type { BlockMarker, CommandBlock } from "../terminal-command-blocks";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeMarker(line: number): BlockMarker {
  return { line, dispose: () => undefined };
}

function makeBlock(overrides: Partial<CommandBlock> = {}): CommandBlock {
  return {
    id: "block-1",
    command: "docker ps",
    startMarker: fakeMarker(10),
    endMarker: fakeMarker(14),
    exitCode: 0,
    renderedText: "CONTAINER ID   IMAGE",
    finished: true,
    ...overrides,
  };
}

/**
 * 假终端几何：20 行 × 16px。
 * - host（wrapper）从 0 开始，rows 顶边相对 host 是 8px；
 * - viewportY=0，buffer 行 n 的中心 localY = 8 + n*16 + 8。
 */
function stubGeometry() {
  const rowsRect = { top: 8, left: 8, width: 784, height: 320 };
  const hostRect = { top: 0, left: 0, width: 800, height: 336 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.className.includes("xterm-rows")) return rowsRect as DOMRect;
    if (this.dataset?.testid === "wrapper") return hostRect as DOMRect;
    return hostRect as DOMRect;
  });
}

let holder: HTMLDivElement;
let root: Root;

/** 与 TerminalView 相同的结构：wrapper(relative) > container + overlay。 */
function render(blocks: CommandBlock[]) {
  const terminal = { rows: 20, buffer: { active: { viewportY: 0 } } } as unknown as Terminal;
  function Harness() {
    const containerRef = { current: null as HTMLDivElement | null };
    const terminalRef = { current: terminal as Terminal | null };
    return (
      <div data-testid="wrapper">
        <div ref={containerRef}>
          <div className="xterm-rows" />
        </div>
        <TerminalCommandBlocks blocks={blocks} terminalRef={terminalRef} containerRef={containerRef} />
      </div>
    );
  }
  act(() => {
    root.render(<Harness />);
  });
}

function moveMouse(target: Element, clientY: number) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY }),
    );
  });
}

/** 悬停到 buffer 行 n（视口内）的中心。 */
function hoverAt(bufferLine: number) {
  moveMouse(holder.querySelector<HTMLElement>("[data-testid=wrapper]")!, 8 + bufferLine * 16 + 8);
}

const highlight = () => holder.querySelector("[data-testid=terminal-command-block-highlight]");
const actions = () => holder.querySelector("[data-testid=terminal-command-block-actions]");

beforeEach(() => {
  stubGeometry();
  holder = document.createElement("div");
  document.body.appendChild(holder);
  root = createRoot(holder);
});

afterEach(() => {
  act(() => root.unmount());
  holder.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("TerminalCommandBlocks", () => {
  it("鼠标悬到块行上 → 整块高亮 + 按钮条出现", () => {
    render([makeBlock()]);

    hoverAt(12); // 块范围 10..14 之内

    expect(highlight()).not.toBeNull();
    // 块顶 = 8 + 10*16 = 168；高 = (14-10+1)*16 = 80。
    expect(highlight()!.getAttribute("style")).toMatch(/top:\s*168/);
    expect(highlight()!.getAttribute("style")).toMatch(/height:\s*80/);
    expect(holder.querySelector("[data-testid=terminal-command-block-copy-command]")).not.toBeNull();
    expect(holder.querySelector("[data-testid=terminal-command-block-copy-output]")).not.toBeNull();
  });

  it("鼠标移出块 → 高亮消失", () => {
    render([makeBlock()]);

    hoverAt(12);
    expect(highlight()).not.toBeNull();

    hoverAt(0); // 块上方
    expect(highlight()).toBeNull();
    expect(actions()).toBeNull();
  });

  it("点击复制命令 / 复制输出 → copyText 收到对应文本", () => {
    render([makeBlock()]);
    hoverAt(12);

    act(() => {
      holder.querySelector<HTMLElement>("[data-testid=terminal-command-block-copy-command]")!.click();
    });
    expect(copyText).toHaveBeenLastCalledWith("docker ps");

    act(() => {
      holder.querySelector<HTMLElement>("[data-testid=terminal-command-block-copy-output]")!.click();
    });
    expect(copyText).toHaveBeenLastCalledWith("CONTAINER ID   IMAGE");
  });

  it("报错块显示 exit 徽标 + 红底高亮；成功块用强调色底且无描边", () => {
    render([makeBlock({ exitCode: 1 })]);
    hoverAt(12);

    expect(holder.querySelector("[data-testid=terminal-command-block-exit]")!.textContent).toBe("exit 1");
    expect(highlight()!.className).toContain("bg-danger/10");
    expect(highlight()!.className).not.toContain("border");
  });

  it("成功块高亮是纯背景色，不含任何描边类", () => {
    render([makeBlock({ exitCode: 0 })]);
    hoverAt(12);

    expect(highlight()!.className).toContain("bg-accent/10");
    expect(highlight()!.className).not.toMatch(/\bborder\b/);
  });

  it("输出为空的块不显示「复制输出」按钮", () => {
    render([makeBlock({ renderedText: "" })]);
    hoverAt(12);

    expect(holder.querySelector("[data-testid=terminal-command-block-copy-command]")).not.toBeNull();
    expect(holder.querySelector("[data-testid=terminal-command-block-copy-output]")).toBeNull();
  });

  it("鼠标移到按钮条上（块矩形之外）hover 保持不清除", () => {
    render([makeBlock()]);
    hoverAt(12);
    expect(highlight()).not.toBeNull();

    // 按钮条挂在块顶上方（块矩形外）：这次 mousemove 若按命中检测会把
    // hover 清掉，按钮条闪没 —— 必须原地保持。
    moveMouse(actions()!, 8 + 10 * 16 - 20);
    expect(highlight()).not.toBeNull();
  });

  it("无块悬停时不渲染高亮与按钮条", () => {
    render([]);
    hoverAt(12);
    expect(highlight()).toBeNull();
    expect(actions()).toBeNull();
  });

  it("marker 被淘汰（line=-1）的块不参与命中", () => {
    render([makeBlock({ startMarker: fakeMarker(-1), endMarker: fakeMarker(-1) })]);
    hoverAt(12);
    expect(highlight()).toBeNull();
  });

  it("块滚出视口下方 → 不画高亮（超出自动隐藏）", () => {
    // 视口 20 行（0..19）：块 30..34 完全在视口下方。
    render([makeBlock({ startMarker: fakeMarker(30), endMarker: fakeMarker(34) })]);
    hoverAt(12);
    expect(highlight()).toBeNull();
  });

  it("块部分滚出视口 → 只画可视部分，不溢出", () => {
    // 视口行 0..19；块 15..40：可见 15..19 → top=8+15*16=248，高=5*16=80。
    render([makeBlock({ startMarker: fakeMarker(15), endMarker: fakeMarker(40) })]);
    hoverAt(16);

    const style = highlight()!.getAttribute("style")!;
    expect(style).toMatch(/top:\s*248/);
    expect(style).toMatch(/height:\s*80/);
    // 底边正好贴行区底（8 + 320 = 328），不越界。
    expect(248 + 80).toBe(328);
  });
});
