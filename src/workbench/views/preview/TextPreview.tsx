import { useMemo, useState } from "react";
import { WrapText } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Read-only text view.
 *
 * Kept deliberately plain (a `<pre>`, not CodeMirror): this is the preview
 * path, where the point is to look at a file, and for code the editor is a
 * click away in the footer. Line numbers are rendered in a gutter column so
 * they stay aligned when long lines wrap.
 */
export function TextPreview({ text }: { text: string }) {
  const [wrap, setWrap] = useState(true);
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  // A trailing newline is the normal end of a text file, not an empty line.
  const visible = lines.length > 1 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        <Button
          size="xs"
          variant={wrap ? "secondary" : "ghost"}
          onClick={() => setWrap((current) => !current)}
        >
          <WrapText size={12} />
          自动换行
        </Button>
        <span className="ml-auto text-11 text-fg-subtle">{visible.length.toLocaleString()} 行</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex min-w-full font-mono text-11 leading-[1.55]">
          <div
            aria-hidden
            className="sticky left-0 shrink-0 select-none border-r border-line bg-surface-1 px-2 text-right text-fg-subtle"
          >
            {visible.map((_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>
          <pre
            className={
              wrap
                ? "flex-1 whitespace-pre-wrap break-words px-3 text-fg-muted"
                : "flex-1 whitespace-pre px-3 text-fg-muted"
            }
          >
            {visible.join("\n")}
          </pre>
        </div>
      </div>
    </div>
  );
}
