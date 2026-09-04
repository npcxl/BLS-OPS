import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";

/**
 * 把原始终端流里的**真实控制字符**变成可见 token，放进 `<pre>` 后不会破坏
 * 布局、也不会以不可见字符混入正文：
 *
 * - ESC（`\x1b`）→ `<ESC>`
 * - BEL（`\x07`）→ `<BEL>`
 * - CR（`\r`）→ `<CR>`
 * - LF（`\n`）→ `<LF>`
 *
 * 转义后是一条 token 流（无折行），配横向滚动查看 —— 这是**高级调试视图**，
 * 用于核对字节层面发生了什么（例如 `ESC[?2004l` 这类 bracketed-paste 开关）。
 */
export function escapeControlCharacters(text: string): string {
  return text
    .replace(/\x1b/g, "<ESC>")
    .replace(/\x07/g, "<BEL>")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>");
}

/**
 * 原始流调试视图：完整 stdout/stderr 逐字节转义展示（含 ESC / 控制字符）。
 *
 * **复制仍是原始字节**（不带 `<ESC>` 等标记）—— 标记只负责"看得见"，
 * 不影响留档与粘贴。
 */
export function RawStreamView({ stdout, stderr }: { stdout: string; stderr?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(stdout || "")) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };

  return (
    <div className="relative h-full min-w-0 bg-surface-1">
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-[6px] border border-line bg-surface-1 px-1.5 py-0.5 text-10 text-fg-subtle hover:text-fg"
        title="复制原始输出（不带转义标记）"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "已复制" : "复制"}
      </button>
      <div className="h-full overflow-auto">
        <pre className="w-max whitespace-pre px-3 py-2.5 font-mono text-11 leading-[1.8] text-fg-muted">
          {escapeControlCharacters(stdout) || "（无输出）"}
        </pre>
      </div>
      {stderr ? (
        <div className="border-t border-danger/30 bg-danger/8">
          <div className="px-3 pt-2 text-10 font-semibold text-danger">stderr</div>
          <div className="max-h-40 overflow-auto">
            <pre className="w-max whitespace-pre px-3 py-2 font-mono text-11 text-danger">
              {escapeControlCharacters(stderr)}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}
