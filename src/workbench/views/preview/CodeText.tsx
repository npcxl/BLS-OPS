import { useMemo, useRef, useState } from "react";
import { Search, WrapText } from "lucide-react";
import CodeMirror, { EditorState, EditorView } from "@uiw/react-codemirror";
import { Button } from "@/components/ui/button";
import { useEditorTheme } from "@/lib/cm-theme";
import { openOpsSearch, opsSearch } from "@/lib/cm-search";

/**
 * 只读代码/文本查看器（由 TextPreview 懒加载）。
 *
 * 工具栏：自动换行开关 · Ctrl+F 搜索提示 · 行数统计。
 * 只读：`editable=false` + `readOnly` state；搜索面板据此隐藏替换行。
 */
export default function CodeText({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  const theme = useEditorTheme();
  const viewRef = useRef<Parameters<typeof openOpsSearch>[0] | null>(null);

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
          variant="ghost"
          onClick={() => openOpsSearch(viewRef.current)}
          title="查找 · Enter 下一个 · Shift+Enter 上一个 · Esc 关闭"
        >
          <Search size={12} />
          搜索 Ctrl+F
        </Button>
        <span className="ml-auto text-11 text-fg-subtle">
          {lineCount.toLocaleString()} 行
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
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
      </div>
    </>
  );
}
