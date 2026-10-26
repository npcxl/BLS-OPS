/**
 * CodeMirror 编辑器主题：跟随应用主题（亮色 / 暗色）。
 * 由文件编辑弹窗与只读代码预览共用。
 */
import { EditorView } from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { useThemeMode } from "@/hooks/use-theme";

/**
 * 编辑器正文的鼠标指针。
 *
 * 应用在 `body` 上设了 `cursor: default`（桌面应用的"不要像网页那样到处
 * I-beam"），CodeMirror 的 `.cm-content` 是 contenteditable div，会继承它，
 * 结果打开文件后鼠标一直是箭头。全局 CSS 里的 `[contenteditable="true"]`
 * 在某些继承链/层叠层下不一定赢，所以这里用 CodeMirror 自己的 style module：
 * 规则带 `.cm-editor` 作用域，优先级稳定。
 *
 * 只读预览也用它：VSCode 的只读编辑器同样显示 I-beam（可选中、不可改）。
 */
export const editorCursorTheme = EditorView.theme({
  ".cm-content": { cursor: "text" },
  ".cm-line": { cursor: "text" },
  ".cm-gutters": { cursor: "default" },
});

export function useEditorTheme(): "light" | typeof oneDark {
  const [mode] = useThemeMode();
  if (mode === "dark") return oneDark;
  if (mode === "light") return "light";
  // "system": CodeMirror needs a concrete theme; match the media query once
  // per render (good enough — the modal re-renders on interactions).
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? oneDark : "light";
}
