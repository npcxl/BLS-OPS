import { useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { html as htmlLang } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { java as javaLang } from "@codemirror/lang-java";
import { json as jsonLang } from "@codemirror/lang-json";
import { css as cssLang } from "@codemirror/lang-css";
import { python as pythonLang } from "@codemirror/lang-python";
import { markdown as markdownLang } from "@codemirror/lang-markdown";
import { Button } from "@/components/ui/button";
import { ErrorText, Modal } from "@/components/ui/modal";
import { opsApi, toErrorMessage } from "@/api/ops-api";
import type { EditorLanguage } from "@/lib/file-kind";
import { useThemeMode } from "@/hooks/use-theme";

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
  const [saving, setSaving] = useState(false);
  const theme = useEditorTheme();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await opsApi.sftpReadFile(sessionId, path);
        if (cancelled) return;
        if (result.binary) {
          setError("这是二进制文件，无法以文本方式打开。");
          return;
        }
        setContent(result.content ?? "");
        setSize(result.size);
      } catch (cause) {
        if (!cancelled) setError(toErrorMessage(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  const extensions = useMemo(() => buildExtensions(language), [language]);

  const save = async () => {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await opsApi.sftpWriteFile(sessionId, path, content);
      setDirty(false);
      onSaved();
      onClose();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      width={860}
      title={name}
      description={path}
      onClose={() => {
        if (!dirty || window.confirm("有未保存的修改，确定关闭吗？")) onClose();
      }}
      footer={
        <>
          <span className="mr-auto text-11 text-fg-subtle">
            {size !== null && `${(size / 1024).toFixed(1)} KB`}
            {dirty && " · 未保存"}
          </span>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {dirty ? "取消" : "关闭"}
          </Button>
          <Button variant="primary" size="sm" disabled={saving || content === null} onClick={() => void save()}>
            <Save size={13} />
            {saving ? "保存中…" : "保存 (Ctrl+S)"}
          </Button>
        </>
      }
    >
      <div className="flex min-h-0 flex-col gap-2">
        {content === null && !error && (
          <div className="flex items-center justify-center gap-2 py-10 text-12 text-fg-subtle">
            <Loader2 size={14} className="animate-spin" />
            正在读取…
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {content !== null && (
          <div
            className="overflow-hidden rounded-[6px] border border-line"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void save();
              }
            }}
          >
            <CodeMirror
              value={content}
              height="56vh"
              theme={theme}
              extensions={extensions}
              basicSetup={{ foldGutter: true, highlightActiveLine: true }}
              onChange={(value) => {
                setContent(value);
                setDirty(true);
              }}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}

function useEditorTheme(): "light" | typeof oneDark {
  const [mode] = useThemeMode();
  if (mode === "dark") return oneDark;
  if (mode === "light") return "light";
  // "system": CodeMirror needs a concrete theme; match the media query once
  // per render (good enough — the modal re-renders on interactions).
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? oneDark : "light";
}

function buildExtensions(language?: EditorLanguage) {
  if (!language) return [];
  switch (language) {
    case "sql":
      return [sqlLang()];
    case "html":
      return [htmlLang()];
    case "javascript":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true, typescript: true })];
    case "typescript":
      return [javascript({ typescript: true })];
    case "java":
      return [javaLang()];
    case "json":
      return [jsonLang()];
    case "css":
      return [cssLang()];
    case "python":
      return [pythonLang()];
    case "markdown":
      return [markdownLang()];
  }
}
