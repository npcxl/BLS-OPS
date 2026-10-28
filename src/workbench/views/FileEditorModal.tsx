import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, Save } from "@/components/icons";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@uiw/react-codemirror";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { html as htmlLang } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { java as javaLang } from "@codemirror/lang-java";
import { json as jsonLang } from "@codemirror/lang-json";
import { css as cssLang } from "@codemirror/lang-css";
import { python as pythonLang } from "@codemirror/lang-python";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { Button } from "@/components/ui/button";
import { CodeSearchBox } from "@/components/ui/code-search-box";
import { ErrorText, Modal } from "@/components/ui/modal";
import {
  opsApi,
  toErrorMessage,
  type EditorHistoryEntry,
  type RemoteFileVersion,
} from "@/api/ops-api";
import type { EditorLanguage } from "@/lib/file-kind";
import { editorCursorTheme, useEditorTheme } from "@/lib/cm-theme";
import { opsSearch } from "@/lib/cm-search";
import { useActivityTicket } from "@/stores/activity-store";
import { useInspectionMode } from "@/stores/inspection-store";

/**
 * Read/edit modal for remote text files (phase 2 of the file panel).
 *
 * Content flows through SFTP read/write on the session's own connection; the
 * CodeMirror bundle is code-split — it only loads when an editor is opened.
 * Saving overwrites the remote file in place; nothing is cached locally.
 */
export default function FileEditorModal({
  sessionId,
  path,
  name,
  language,
  onClose,
  onSaved,
}: {
  sessionId: string;
  /** Absolute remote path. */
  path: string;
  name: string;
  language?: EditorLanguage;
  onClose: () => void;
  /** Called after a successful save so the listing can refresh. */
  onSaved: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Unsaved remote edits: an update restart would lose them, so they are
  // registered with the restart guard (P5.1).
  useActivityTicket("editor", dirty);
  const [saving, setSaving] = useState(false);
  /** 浮动搜索框开关（Ctrl+F）。 */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 打开时拿到的版本指纹：保存前用它判断文件有没有被别人改过。 */
  const [version, setVersion] = useState<RemoteFileVersion | null>(null);
  /** 冲突状态：`current = null` 表示文件已被删除或不再可读。 */
  const [conflict, setConflict] = useState<{ current: RemoteFileVersion | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 本机历史版本（保存前自动留存）。 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<EditorHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const { t } = useTranslation();
  const theme = useEditorTheme();
  const viewRef = useRef<EditorView | null>(null);
  // 巡检模式：可以看、可以搜，但不能写回。
  const inspection = useInspectionMode();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await opsApi.sftpReadFile(sessionId, path);
        if (cancelled) return;
        if (result.binary) {
          setError(t("This is a binary file and cannot be opened as text."));
          return;
        }
        setContent(result.content ?? "");
        setSize(result.size);
        // 版本基线：保存时原样带回，服务器据此判断文件是否被改过。
        setVersion(result.version);
      } catch (cause) {
        if (!cancelled) setError(toErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, t]);

  const extensions = useMemo(() => buildExtensions(language), [language]);

  /**
   * 保存。`expected` 默认是打开时的版本；冲突后用户选择「覆盖」时传**当前**
   * 版本，这样若这期间又变了会再弹一次 —— 绝不静默盖掉别人的修改。
   */
  const save = async (expected?: RemoteFileVersion | null) => {
    if (content === null || saving) return;
    if (inspection) {
      setError(t("Inspection mode: saving is disabled."));
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await opsApi.sftpSaveEditorFile(
        sessionId,
        path,
        content,
        expected === undefined ? version : expected,
      );
      if (outcome.status === "saved") {
        setVersion(outcome.version);
        setSize(outcome.version.size);
        setDirty(false);
        onSaved();
        onClose();
        return;
      }
      setConflict({ current: outcome.current ?? null });
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  /** 重新加载：丢掉本地改动，换成服务器上的当前版本。 */
  const reload = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await opsApi.sftpReadFile(sessionId, path);
      if (result.binary) {
        setError(t("This is a binary file and cannot be opened as text."));
        return;
      }
      setContent(result.content ?? "");
      setSize(result.size);
      setVersion(result.version);
      setDirty(false);
      setConflict(null);
      setNotice(t("Reloaded the current version from the server."));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  /** 另存为副本：不碰原文件，冲突时最安全的选择。 */
  const saveAsCopy = async () => {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
      const target = `${path}.bls-conflict-${stamp}`;
      const outcome = await opsApi.sftpSaveEditorFile(sessionId, target, content, null);
      if (outcome.status === "saved") {
        setConflict(null);
        setNotice(t("Saved as {{path}}. The original file was left untouched.", { path: target }));
        onSaved();
      } else {
        setError(t("The copy target changed too. Try again."));
      }
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const openHistory = async () => {
    setHistoryOpen(true);
    setHistoryError(null);
    if (history !== null) return;
    setHistoryBusy(true);
    try {
      setHistory(await opsApi.editorHistoryList(path));
    } catch (cause) {
      setHistoryError(toErrorMessage(cause));
    } finally {
      setHistoryBusy(false);
    }
  };

  /** 把历史版本载入编辑器；是否写回由用户再点保存决定。 */
  const loadHistory = async (id: string) => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const text = await opsApi.editorHistoryRead(path, id);
      setContent(text);
      setDirty(true);
      setHistoryOpen(false);
      setNotice(t("Loaded a historical version into the editor. Save to write it back."));
    } catch (cause) {
      setHistoryError(toErrorMessage(cause));
    } finally {
      setHistoryBusy(false);
    }
  };

  return (
    <Modal
      open
      width={860}
      title={name}
      description={path}
      onClose={() => {
        if (!dirty || window.confirm(t("There are unsaved changes. Close anyway?"))) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-11 text-fg-subtle">
            {size !== null && `${(size / 1024).toFixed(1)} KB`}
            {dirty && ` · ${t("Unsaved")}`}
          </span>
          <Button variant="ghost" size="sm" disabled={saving} onClick={() => void openHistory()}>
            <History size={13} />
            {t("History")}
          </Button>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {dirty ? t("Cancel") : t("Close")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={saving || content === null || inspection}
            onClick={() => void save()}
          >
            <Save size={13} />
            {saving ? t("Saving") : t("Save (Ctrl+S)")}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-2">
        {content === null && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-12 text-fg-subtle">
            <Loader2 size={14} className="animate-spin" />
            {t("Reading file…")}
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {inspection && (
          <p className="text-11 leading-relaxed text-warning">
            {t("Inspection mode: editing is view-only. Turn it off in Settings to save changes.")}
          </p>
        )}
        {notice && <p className="text-11 leading-relaxed text-success">{notice}</p>}
        {content !== null && (
          <div
            className="relative overflow-hidden rounded-[6px] border border-line"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
              }
            }}
            // Ctrl+F 必须在捕获阶段拦下：searchKeymap 挂在编辑器 DOM 上，
            // 冒泡阶段拦截时它已经把默认面板打开了。
            onKeyDownCapture={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
                event.preventDefault();
                event.stopPropagation();
                setSearchOpen(true);
              }
            }}
          >
            <CodeMirror
              value={content}
              height="52vh"
              theme={theme}
              extensions={extensions}
              basicSetup={{ foldGutter: true, highlightActiveLine: true }}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              onChange={(value) => {
                setContent(value);
                setDirty(true);
              }}
            />
            {searchOpen && (
              <CodeSearchBox view={viewRef.current} onClose={() => setSearchOpen(false)} />
            )}
          </div>
        )}
      </div>

      {/* 冲突：文件在打开之后被改过。三条路都给用户，绝不替用户决定覆盖。 */}
      <Modal
        open={conflict !== null}
        width={520}
        title={t("This file changed on the server")}
        onClose={() => setConflict(null)}
      >
        <div className="flex flex-col gap-3">
          <p className="text-12 leading-relaxed text-fg-muted">
            {t("You opened this file earlier, but it has been modified since. Saving now would overwrite those changes.")}
          </p>
          {conflict?.current ? (
            <div className="rounded-[8px] border border-line bg-surface-2/60 px-3 py-2 text-11 text-fg-muted">
              {t("Current version: {{size}} KB · modified {{time}}", {
                size: (conflict.current.size / 1024).toFixed(1),
                time: conflict.current.modified_at
                  ? new Date(conflict.current.modified_at * 1000).toLocaleString()
                  : t("Unknown time"),
              })}
            </div>
          ) : (
            <p className="rounded-[8px] border border-warning/30 bg-warning/10 px-3 py-2 text-11 text-warning">
              {t("The file no longer exists on the server.")}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => void reload()}>
              {t("Reload from server")}
            </Button>
            <Button variant="secondary" size="sm" disabled={saving} onClick={() => void saveAsCopy()}>
              {t("Save as a copy")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={saving || !conflict?.current}
              onClick={() => void save(conflict?.current ?? null)}
            >
              {t("Overwrite anyway")}
            </Button>
          </div>
        </div>
      </Modal>

      {/* 本机历史：每次覆盖前自动留存，保留最近若干份。 */}
      <Modal
        open={historyOpen}
        width={480}
        title={t("Version history")}
        description={t("Kept on this machine before each overwrite. Older copies roll off automatically.")}
        onClose={() => setHistoryOpen(false)}
      >
        <div className="flex flex-col gap-2">
          {historyError && <ErrorText>{historyError}</ErrorText>}
          {historyBusy && history === null && (
            <div className="flex items-center gap-2 py-6 text-11 text-fg-subtle">
              <Loader2 size={13} className="animate-spin" />
              {t("Reading…")}
            </div>
          )}
          {history !== null && history.length === 0 && (
            <p className="py-4 text-11 text-fg-subtle">
              {t("No history yet — the first copy is recorded when you save over this file.")}
            </p>
          )}
          {history?.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between gap-2 rounded-[8px] border border-line px-3 py-1.5"
            >
              <span className="text-11 text-fg">{new Date(entry.saved_at).toLocaleString()}</span>
              <span className="text-11 text-fg-subtle">
                {t("{{size}} KB", { size: (entry.size / 1024).toFixed(1) })}
              </span>
              <Button
                variant="secondary"
                size="xs"
                disabled={historyBusy}
                onClick={() => void loadHistory(entry.id)}
              >
                {t("Load this version")}
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </Modal>
  );
}

function buildExtensions(language?: EditorLanguage) {
  // opsSearch()：Ctrl+F 打开自定义查找/替换面板（替换默认原生样式）。
  // editorCursorTheme：正文 I-beam（body 上的 cursor: default 会继承进来）。
  const extensions = [opsSearch(), editorCursorTheme];
  if (!language) return extensions;
  switch (language) {
    case "sql":
      extensions.push(sqlLang());
      break;
    case "html":
      extensions.push(htmlLang());
      break;
    case "javascript":
      extensions.push(javascript());
      break;
    case "jsx":
      extensions.push(javascript({ jsx: true, typescript: true }));
      break;
    case "typescript":
      extensions.push(javascript({ typescript: true }));
      break;
    case "java":
      extensions.push(javaLang());
      break;
    case "json":
      extensions.push(jsonLang());
      break;
    case "css":
      extensions.push(cssLang());
      break;
    case "python":
      extensions.push(pythonLang());
      break;
    case "markdown":
      extensions.push(markdownLang());
      break;
  }
  return extensions;
}
