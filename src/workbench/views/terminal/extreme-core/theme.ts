import { theme as antdTheme } from "antd";

/**
 * 超能的配色**跟随应用主题**（浅色 / 深色都支持）。
 *
 * 这里不再写死十六进制，全部引用全局 token 变量：外层 `data-theme` 一切换，
 * 超能里的气泡、侧栏、按钮跟着变。`EC` 只是让组件里少写一长串 `rgb(var(…))`。
 */
export const EC = {
  /** 工作台底色。 */
  bg: "rgb(var(--app))",
  /** 侧栏 / 次级表面。 */
  surface: "rgb(var(--surface-1))",
  /** 气泡 / 卡片。 */
  surfaceRaised: "rgb(var(--surface-2))",
  /** 悬停底。 */
  surfaceHover: "rgb(var(--surface-hover))",
  border: "rgb(var(--line))",
  borderStrong: "rgb(var(--line-strong))",
  fg: "rgb(var(--fg))",
  fgMuted: "rgb(var(--fg-muted))",
  fgSubtle: "rgb(var(--fg-subtle))",
  /** 用户气泡 / 主行动色。 */
  accent: "rgb(var(--accent))",
  /** 聚焦描边。 */
  accentSoft: "rgb(var(--accent-soft))",
  success: "rgb(var(--success))",
  danger: "rgb(var(--danger))",
  warning: "rgb(var(--warning))",
} as const;

/**
 * 超能里所有 antd 组件共用的主题。
 *
 * `dark` 由调用方按当前 `data-theme` 传入 —— antd 的算法不读 CSS 变量，
 * 必须显式切 `darkAlgorithm` / `defaultAlgorithm`，否则浅色主题下弹窗、
 * 输入框仍是深色。
 */
export function antdThemeFor(dark: boolean) {
  return {
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: "rgb(var(--accent))",
      colorBgContainer: "rgb(var(--surface-2))",
      colorBgElevated: "rgb(var(--surface-1))",
      colorBorder: "rgb(var(--line))",
      colorText: "rgb(var(--fg))",
      colorTextDescription: "rgb(var(--fg-subtle))",
      colorFill: "rgb(var(--surface-3))",
      colorFillSecondary: "rgb(var(--surface-2))",
      colorFillTertiary: "rgb(var(--surface-2))",
      colorFillQuaternary: "rgb(var(--surface-1))",
      borderRadius: 8,
      fontSize: 12,
    },
  };
}
