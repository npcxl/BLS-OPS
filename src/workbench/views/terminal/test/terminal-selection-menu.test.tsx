import { act } from "react";
import { createRoot } from "react-dom/client";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 组件用 useTranslation —— 测试断言英文 key（默认语言 en 下 t(key) 返回 key）。
import "@/i18n";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";
import { TerminalSelectionMenu, clampMenuPosition } from "../terminal-selection-menu";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clipboard = { text: "" };
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: async (text: string) => void (clipboard.text = text) },
});

describe("clampMenuPosition —— 菜单绝不溢出容器", () => {
  const container = { width: 800, height: 400 };
  const menu = { width: 160, height: 28 };

  it("空间充足 → 就用锚点原位置（贴在选区末端）", () => {
    expect(clampMenuPosition({ x: 100, y: 100, menu, container })).toEqual({ left: 100, top: 100 });
  });

  it("从右侧选中、锚点贴近右缘 → 翻到锚点左侧（不再被裁掉）", () => {
    // 锚点 780 + 菜单 160 > 800 → 翻转：780 - 160 = 620
    expect(clampMenuPosition({ x: 780, y: 100, menu, container }).left).toBe(620);
    // 锚点正好在容器右缘（选区拉到行尾）：翻转后 640，再夹进 8px 安全边距 → 632
    const clamped = clampMenuPosition({ x: 800, y: 100, menu, container }).left;
    expect(clamped).toBe(632);
    expect(clamped + menu.width).toBeLessThanOrEqual(container.width - 8);
  });

  it("翻转后仍然放不下 → 夹到安全边距（先保不溢出）", () => {
    // 菜单比容器还宽：左右都放不下 → 贴左边距
    const wide = { width: 900, height: 28 };
    expect(clampMenuPosition({ x: 700, y: 10, menu: wide, container }).left).toBe(8);
  });

  it("选区贴着底部 → 翻到锚点上方", () => {
    expect(clampMenuPosition({ x: 100, y: 395, menu, container }).top).toBe(395 - 28 - 4);
  });

  it("上下都放不下 → 夹到顶部边距", () => {
    const tall = { width: 160, height: 420 };
    expect(clampMenuPosition({ x: 100, y: 390, menu: tall, container }).top).toBe(8);
  });

  it("字符数变多 → 菜单更宽也不会溢出（长选区场景）", () => {
    // "已选择 123456 个字符" 让菜单变宽，右侧空间进一步被压缩
    const longMenu = { width: 320, height: 28 };
    const { left } = clampMenuPosition({ x: 790, y: 40, menu: longMenu, container });
    expect(left + longMenu.width).toBeLessThanOrEqual(container.width - 8);
  });

  it("容器尺寸不可用（未布局 / jsdom 恒为 0）→ 原样返回，交给 CSS 兜底", () => {
    expect(clampMenuPosition({ x: 12, y: 34, menu, container: { width: 0, height: 0 } })).toEqual({
      left: 12,
      top: 34,
    });
  });
});

/** 真实用法：菜单 + 共用复制提示（TerminalView 里就是这么接的）。 */
function Harness({
  x,
  y,
  text,
  onCopy,
}: {
  x: number;
  y: number;
  text: string;
  onCopy?: (value: string) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { status, copy } = useCopyFeedback();
  return (
    <div ref={wrapperRef} className="relative">
      <TerminalSelectionMenu
        x={x}
        y={y}
        text={text}
        containerRef={wrapperRef}
        onCopy={async (value) => {
          await copy(value);
          onCopy?.(value);
        }}
      />
      <CopyNotice status={status} />
    </div>
  );
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  clipboard.text = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const menu = () => container.querySelector<HTMLElement>('[data-testid="terminal-selection-menu"]');
const notice = () => container.querySelector('[data-testid="copy-notice"]')?.textContent ?? null;

describe("TerminalSelectionMenu", () => {
  it("显示选中的字符数（长文本只显示数量，不撑爆布局）", () => {
    act(() => {
      root.render(<Harness x={10} y={10} text={"x".repeat(5000)} />);
    });
    expect(menu()?.textContent).toContain("5000 characters selected");
    // 数量变化用等宽数字，避免宽度跳动
    expect(menu()?.querySelector("span")?.className).toContain("tabular-nums");
    expect(menu()?.className).toContain("max-w-[calc(100%-16px)]");
  });

  it("点击复制 → 走共用 copyText，内容准确（含换行与空格）", async () => {
    const text = "CONTAINER ID   IMAGE\ndocker   ps -a";
    act(() => {
      root.render(<Harness x={10} y={10} text={text} />);
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="selection-copy"]')?.click();
    });
    expect(clipboard.text).toBe(text);
  });

  it("复制成功 → 显示共用提示“复制成功”", async () => {
    act(() => {
      root.render(<Harness x={10} y={10} text="abc" />);
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="selection-copy"]')?.click();
    });
    expect(notice()).toBe("Copied");
  });

  it("复制失败 → 显示“复制失败，请检查剪贴板权限”（不假装成功）", async () => {
    const failing = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("denied"));
    try {
      act(() => {
        root.render(<Harness x={10} y={10} text="abc" />);
      });
      await act(async () => {
        container.querySelector<HTMLElement>('[data-testid="selection-copy"]')?.click();
      });
      expect(notice()).toBe("Copy failed. Please check clipboard permission");
    } finally {
      failing.mockRestore();
    }
  });

  it("提示不参与布局（absolute + pointer-events-none），不会撑动面板", async () => {
    act(() => {
      root.render(<Harness x={10} y={10} text="abc" />);
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="selection-copy"]')?.click();
    });
    const layer = container.querySelector('[data-testid="copy-notice"]')?.parentElement;
    expect(layer?.className).toContain("absolute");
    expect(layer?.className).toContain("pointer-events-none");
    expect(layer?.getAttribute("aria-live")).toBe("polite");
  });

  it("菜单内部按下鼠标不触发外层关闭（stopPropagation）", () => {
    let closed = 0;
    act(() => {
      root.render(
        <div onMouseDown={() => (closed += 1)}>
          <Harness x={10} y={10} text="abc" />
        </div>,
      );
    });
    act(() => {
      menu()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(closed).toBe(0);
  });
});
