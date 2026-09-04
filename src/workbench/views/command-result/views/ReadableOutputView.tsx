import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";

/**
 * 可读输出 —— 终端结果面板的**默认**视图。
 *
 * 展示 `normalizeForParsing(rawOutput, command)` 的结果：控制序列、回显、
 * 尾部提示符都已清掉，用户看到的是干净的、可在终端里正常阅读的输出。
 * 长行不折行（`w-max whitespace-pre`），在横向滚动容器里看全 —— 表格列
 * 不会被 `break-words` 打断。
 */
export function ReadableOutputView({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (await copyText(text || "")) {
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
        title="复制可读输出"
      >
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? "已复制" : "复制"}
      </button>
      <div className="h-full overflow-auto">
        <pre className="w-max whitespace-pre px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted">
          {text || "（无输出）"}
        </pre>
      </div>
    </div>
  );
}
