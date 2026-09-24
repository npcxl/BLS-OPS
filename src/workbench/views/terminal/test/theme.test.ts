import { describe, expect, it } from "vitest";

import { terminalTheme } from "../theme";

/** xterm 认识的 16 个 ANSI 槽位。 */
const ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

const THEMES = [
  { name: "dark", dark: true },
  { name: "light", dark: false },
];

/** #rrggbb → 0-255 亮度（够用的近似，只用来判"谁更亮"）。 */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("terminalTheme", () => {
  it("两套主题都显式给出全部 16 个 ANSI 槽位", () => {
    // 缺一个，xterm 就会用**自己的**默认色 —— 两套主题的色感当场分裂，
    // 而且这种缺失在界面上表现为"某个命令的输出颜色怪"，极难定位。
    for (const { name, dark } of THEMES) {
      const theme = terminalTheme(dark);
      for (const key of ANSI_KEYS) {
        expect(theme[key], `${name} 缺少 ${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("背景 / 前景 / 光标 / 选区都有值", () => {
    for (const { name, dark } of THEMES) {
      const theme = terminalTheme(dark);
      expect(theme.background, name).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.foreground, name).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.cursor, name).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.cursorAccent, name).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(theme.selectionBackground, name).toBeTruthy();
    }
  });

  it("没有哪个 ANSI 色等于背景色（等于背景 = 该颜色渲染出来是隐形的）", () => {
    for (const { name, dark } of THEMES) {
      const theme = terminalTheme(dark);
      for (const key of ANSI_KEYS) {
        expect(theme[key].toLowerCase(), `${name}.${key}`).not.toBe(
          theme.background.toLowerCase(),
        );
      }
    }
  });

  it("亮色主题是浅底深字、暗色主题是深底浅字", () => {
    const light = terminalTheme(false);
    const dark = terminalTheme(true);
    expect(luminance(light.background)).toBeGreaterThan(luminance(light.foreground));
    expect(luminance(dark.background)).toBeLessThan(luminance(dark.foreground));
  });
});
