import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 组件用 useTranslation —— 测试断言英文 key（默认语言 en 下 t(key) 返回 key）。
import "@/i18n";
import { TerminalSettingsGroup } from "../settings-terminal";
import {
  DEFAULT_TERMINAL_FONT_ID,
  TERMINAL_FONT_KEY,
  resolveFontStack,
  setTerminalFontId,
} from "../views/terminal/terminal-font";
import { COMPACT_PROMPT_KEY } from "../views/terminal/terminal-prompt";

// React 19 + vitest：需要显式声明 act 环境（见项目既有约定）。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  // 复位共享字体状态（模块级缓存 + CSS 变量 + 存储），避免用例互相污染。
  setTerminalFontId(DEFAULT_TERMINAL_FONT_ID);
  window.localStorage.removeItem(COMPACT_PROMPT_KEY);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const preview = () => container.querySelector<HTMLElement>('[data-testid="terminal-font-preview"]');
const select = () => container.querySelector<HTMLSelectElement>("select");

/** 受控 select 必须走 native setter，否则 React 收不到这次变更。 */
function chooseFont(id: string) {
  const element = select();
  if (!element) throw new Error("font select not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, id);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("TerminalSettingsGroup", () => {
  it("把字体选择放在设置里，并列出全部候选", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    expect(select()).not.toBeNull();
    expect(select()?.options.length).toBeGreaterThan(1);
    expect(select()?.value).toBe(DEFAULT_TERMINAL_FONT_ID);
  });

  it("预览块用的是与终端完全相同的那套字体栈", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    const stack = resolveFontStack(DEFAULT_TERMINAL_FONT_ID);
    expect(preview()?.style.fontFamily).toBe(stack);
    // 样张要能看出"等宽对齐 + 数字列 + 中文"，否则预览等于没用。
    expect(preview()?.textContent).toContain("api-gateway");
    expect(preview()?.textContent).toContain("序号");
  });

  it("改字体：预览与全局 CSS 变量一起变（不用连服务器试）", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    chooseFont("consolas");

    const stack = resolveFontStack("consolas");
    expect(stack).toContain("Consolas");
    expect(preview()?.style.fontFamily).toBe(stack);
    expect(select()?.value).toBe("consolas");
    // 终端读的就是这个变量 —— 预览与实际渲染不可能各说各话。
    expect(document.documentElement.style.getPropertyValue("--font-terminal")).toBe(stack);
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("consolas");
  });

  it("提示符精简开关：默认关，打开后落到存储（下次连接生效）", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem(COMPACT_PROMPT_KEY)).toBe("1");
  });
});
