/**
 * 只读 DDL 视图（CodeMirror）。
 *
 * 右侧 DDL 面板和"在新窗口打开"的独立窗口共用这一份：
 * 高亮、字号、折行策略只有一处，两个入口才不会越长越不像。
 */
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { MySQL, sql as sqlLanguage } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { useEditorTheme } from "@/lib/cm-theme";

/**
 * 默认 `basicSetup` 的高亮样式非常淡（关键字只是深紫、字符串暗红），
 * 在 420px 的侧栏里几乎看不出区别。这里给 DDL 定义一套对比度更高的
 * token 颜色，并按明/暗主题切换。
 */
const ddlHighlightLight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
    color: "#6d28d9",
    fontWeight: "600",
  },
  { tag: [t.typeName, t.className], color: "#0e7490", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "#15803d" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#b45309" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "#6b7280",
    fontStyle: "italic",
  },
  { tag: [t.operator, t.punctuation, t.separator], color: "#475569" },
  { tag: [t.name, t.variableName], color: "#0f172a" },
  { tag: [t.propertyName, t.attributeName], color: "#1d4ed8" },
  { tag: [t.invalid], color: "#dc2626" },
]);

const ddlHighlightDark = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword],
    color: "#c084fc",
    fontWeight: "600",
  },
  { tag: [t.typeName, t.className], color: "#67e8f9", fontWeight: "500" },
  { tag: [t.string, t.special(t.string)], color: "#86efac" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fdba74" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "#94a3b8",
    fontStyle: "italic",
  },
  { tag: [t.operator, t.punctuation, t.separator], color: "#cbd5e1" },
  { tag: [t.name, t.variableName], color: "#e2e8f0" },
  { tag: [t.propertyName, t.attributeName], color: "#93c5fd" },
  { tag: [t.invalid], color: "#fca5a5" },
]);

/**
 * 可读性：
 * - 背景交给外层卡片，编辑器本身透明，不再是刺眼的白底；
 * - 字号跟正文一致（13px）、行距 1.8，长行折行后按挂起缩进（text-indent），
 *   一眼能分清"新的一列"和"上一行的续行"；
 * - 行号栏压暗、去掉分隔背景，只留一条细线。
 */
const ddlReadability = EditorView.theme({
  "&": { backgroundColor: "transparent", height: "100%" },
  ".cm-editor": { backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.8",
  },
  ".cm-content": { fontSize: "13px", padding: "10px 10px 12px 2px" },
  ".cm-line": { paddingLeft: "16px", textIndent: "-16px" },
  ".cm-gutters": {
    fontSize: "11px",
    paddingRight: "8px",
    marginRight: "10px",
    borderRight: "1px solid rgb(var(--line))",
    backgroundColor: "transparent",
    color: "rgb(var(--fg-subtle))",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
});

export function DdlCode({
  sql,
  wrap = true,
}: {
  sql: string;
  /** 关掉折行改用横向滚动（对照长行时用）。 */
  wrap?: boolean;
}) {
  const theme = useEditorTheme();

  return (
    <div className="h-full overflow-hidden rounded-[8px] border border-line bg-surface-2/40">
      <CodeMirror
        className="h-full"
        value={sql}
        height="100%"
        theme={theme}
        editable={false}
        readOnly
        extensions={[
          sqlLanguage({ dialect: MySQL, upperCaseKeywords: true }),
          ...(wrap ? [EditorView.lineWrapping] : []),
          syntaxHighlighting(theme === "light" ? ddlHighlightLight : ddlHighlightDark),
          ddlReadability,
        ]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: false,
          highlightActiveLineGutter: false,
          autocompletion: false,
          closeBrackets: false,
          // 用上面的高对比样式，不要默认那套很淡的高亮。
          syntaxHighlighting: false,
        }}
      />
    </div>
  );
}
