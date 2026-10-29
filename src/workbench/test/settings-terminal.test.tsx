import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// 组件用 useTranslation —— 测试断言英文 key（默认语言 en 下 t(key) 返回 key）。
import "@/i18n";
import { TerminalSettingsGroup } from "../settings-terminal";
import {
  DEFAULT_TERMINAL_FONT_ID,
  TERMINAL_FONT_KEY,
  TERMINAL_FONTS,
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
/** 自绘下拉的触发器（原生 select 已不再使用）。 */
const combobox = () => container.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
const labelOf = (id: string) => TERMINAL_FONTS.find((font) => font.id === id)?.label ?? id;

/** 打开下拉并点选某个字体（选项面板是 portal，挂在 body 上）。 */
function chooseFont(id: string) {
  const trigger = combobox();
  if (!trigger) throw new Error("font select not rendered");
  act(() => trigger.click());
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
    (item) => item.textContent?.includes(labelOf(id)),
  );
  if (!option) throw new Error("font option not rendered");
  act(() => option.click());
}

describe("TerminalSettingsGroup", () => {
  it("把字体选择放在设置里，并列出全部候选", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    const trigger = combobox();
    expect(trigger).not.toBeNull();
    // 当前项就是默认字体。
    expect(trigger?.textContent).toContain(labelOf(DEFAULT_TERMINAL_FONT_ID));

    act(() => trigger!.click());
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBeGreaterThan(1);
    // 选中项带 aria-selected，阅读器与测试都能据此判断"当前是哪个"。
    const selected = document.querySelector('[role="option"][aria-selected="true"]');
    expect(selected?.textContent).toContain(labelOf(DEFAULT_TERMINAL_FONT_ID));
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
    expect(combobox()?.textContent).toContain(labelOf("consolas"));
    // 终端读的就是这个变量 —— 预览与实际渲染不可能各说各话。
    expect(document.documentElement.style.getPropertyValue("--font-terminal")).toBe(stack);
    expect(window.localStorage.getItem(TERMINAL_FONT_KEY)).toBe("consolas");
  });

  it("提示符精简开关：默认开，关掉后落到存储（下次连接生效）", () => {
    act(() => {
      root.render(<TerminalSettingsGroup />);
    });
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle).not.toBeNull();
    // 默认开：连上就该是短提示符，不该让用户先去设置里找开关。
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    act(() => {
      toggle?.click();
    });
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem(COMPACT_PROMPT_KEY)).toBe("0");
  });
});
