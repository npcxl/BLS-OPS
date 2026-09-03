/**
 * CodeMirror 编辑器主题：跟随应用主题（亮色 / 暗色）。
 * 由文件编辑弹窗与只读代码预览共用。
 */
import { oneDark } from "@codemirror/theme-one-dark";
import { useThemeMode } from "@/hooks/use-theme";

export function useEditorTheme(): "light" | typeof oneDark {
  const [mode] = useThemeMode();
  if (mode === "dark") return oneDark;
  if (mode === "light") return "light";
  // "system": CodeMirror needs a concrete theme; match the media query once
  // per render (good enough — the modal re-renders on interactions).
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? oneDark : "light";
}
