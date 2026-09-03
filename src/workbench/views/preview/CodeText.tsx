import { useMemo, useRef, useState } from "react";
import { Search, WrapText } from "lucide-react";
import CodeMirror, { EditorState, EditorView } from "@uiw/react-codemirror";
import { Button } from "@/components/ui/button";
import { CodeSearchBox } from "@/components/ui/code-search-box";
import { useEditorTheme } from "@/lib/cm-theme";
import { opsSearch } from "@/lib/cm-search";

/**
 * 只读代码/文本查看器（由 TextPreview 懒加载）。
 *
 * 工具栏：自动换行开关 · Ctrl+F 搜索 · 行数统计。搜索用与编辑器同一套
 * VSCode 风格浮动框（只读文档不显示替换）。
 */
export default function CodeText({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const theme = useEditorTheme();
  const viewRef = useRef<EditorView | null>(null);

  const extensions = useMemo(
    () => [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      opsSearch(),
      ...(wrap ? [EditorView.lineWrapping] : []),
    ],
    [wrap],
  );

  const lines = text.split(/\r?\n/);
  // A trailing newline is the normal end of a text file, not an empty line.
  const lineCount =
    lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          size="xs"
          variant={wrap ? "secondary" : "ghost"}
          onClick={() => setWrap((current) => !current)}
        >
          <WrapText size={12} />
          自动换行
        </Button>
        <Button
          size="xs"
          variant={searchOpen ? "secondary" : "ghost"}
          onClick={() => setSearchOpen((current) => !current)}
          title="查找（Ctrl+F）"
        >
          <Search size={12} />
          搜索
        </Button>
        <span className="ml-auto text-11 text-fg-subtle">
          {lineCount.toLocaleString()} 行
        </span>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        // 捕获阶段拦截，避免 CodeMirror 的默认搜索面板被打开。
        onKeyDownCapture={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
            event.preventDefault();
            event.stopPropagation();
            setSearchOpen(true);
          }
        }}
      >
        <CodeMirror
          value={text}
          height="100%"
          theme={theme}
          extensions={extensions}
          basicSetup={{
            foldGutter: false,
            highlightActiveLine: false,
            autocompletion: false,
            closeBrackets: false,
          }}
          onCreateEditor={(view) => {
            viewRef.current = view;
          }}
        />
        {searchOpen && (
          <CodeSearchBox view={viewRef.current} readOnly onClose={() => setSearchOpen(false)} />
        )}
      </div>
    </>
  );
}
