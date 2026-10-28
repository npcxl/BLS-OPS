/**
 * 右侧 DDL 预览面板：点表页的 DDL 时临时替换"已打开"列表并加宽，
 * 关闭后恢复列表和原宽度。这里只读，修改请到 SQL 编辑器执行。
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { MySQL, sql as sqlLanguage } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { Copy, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { useEditorTheme } from "@/lib/cm-theme";
import { useDatabaseStore } from "@/stores/database-store";
import {
  useDatabaseWorkspaceStore,
  type DdlTarget,
} from "@/stores/database-workspace-store";

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

/** 侧栏窄，字号/行距必须比编辑器正文再清楚一点。 */
const ddlReadability = EditorView.theme({
  ".cm-content": { fontSize: "12px", lineHeight: "1.65" },
  ".cm-gutters": { fontSize: "11px" },
});

export function DdlPanel({ target }: { target: DdlTarget }) {
  const { t } = useTranslation();
  const theme = useEditorTheme();
  const detailKey = `${target.profileId}\u0001${target.database}\u0001${target.table}`;
  const detail = useDatabaseStore((state) => state.details[detailKey] ?? null);
  const loading = useDatabaseStore((state) => state.loading[detailKey] ?? false);
  const refreshTableDetail = useDatabaseStore((state) => state.refreshTableDetail);
  const hideDdl = useDatabaseWorkspaceStore((state) => state.hideDdl);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!detail) {
      void refreshTableDetail(target.profileId, target.database, target.table);
    }
  }, [detail, refreshTableDetail, target.database, target.profileId, target.table]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const createSql = detail?.create_sql ?? "";

  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface-1">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span
          className="min-w-0 flex-1 truncate text-12 font-medium text-fg"
          title={`${target.database}.${target.table}`}
        >
          {target.table} · DDL
        </span>
        <Button
          variant="ghost"
          size="xs"
          disabled={!createSql}
          onClick={() => {
            void copyText(createSql).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
          title={t("复制 DDL")}
        >
          <Copy size={11} />
          {copied ? t("已复制") : null}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          onClick={hideDdl}
          title={t("关闭 DDL，恢复已打开列表")}
        >
          <X size={11} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !detail ? (
          <div className="flex h-full items-center gap-2 px-3 text-12 text-fg-subtle">
            <Loader2 size={13} className="animate-spin" />
            {t("加载表定义…")}
          </div>
        ) : createSql ? (
          <CodeMirror
            className="h-full"
            value={createSql}
            height="100%"
            theme={theme}
            editable={false}
            readOnly
            extensions={[
              sqlLanguage({ dialect: MySQL, upperCaseKeywords: true }),
              EditorView.lineWrapping,
              syntaxHighlighting(
                theme === "light" ? ddlHighlightLight : ddlHighlightDark,
              ),
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
        ) : (
          <p className="px-3 py-2 text-12 text-fg-subtle">{t("没有可用的建表语句")}</p>
        )}
      </div>

    </aside>
  );
}
