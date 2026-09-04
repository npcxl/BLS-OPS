import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CopyNotice, useCopyFeedback } from "@/components/ui/copy-feedback";

/**
 * 原始终端输出 —— **永久保留**的兜底视图。
 *
 * 无法识别、交互式命令、解析失败都落到这里：命令绝不会因为没有专用 UI
 * 而不可用。保留 ANSI 之外的全部字节（含换行与空白）。
 *
 * 只提供"复制全部"：**不拆分控制字符、不做任何结构化**（复制与展示的是
 * 同一份原始字节），复制走共用 `copyText`（有成功/失败提示）。
 */
export function RawView({ stdout, stderr }: { stdout: string; stderr?: string }) {
  const { t } = useTranslation();
  const { status, copy } = useCopyFeedback();

  return (
    <div className="relative h-full overflow-auto bg-surface-1">
      <button
        type="button"
        onClick={() => void copy(stdout)}
        className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-[6px] border border-line bg-surface-1 px-1.5 py-0.5 text-10 text-fg-subtle hover:text-fg"
        title={t("Copy raw output")}
      >
        {status === "ok" ? <Check size={11} /> : <Copy size={11} />}
        {status === "ok" ? t("Copied") : t("Copy")}
      </button>
      <pre className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-11 leading-[1.55] text-fg-muted">
        {stdout || t("(no output)")}
      </pre>
      {stderr ? (
        <div className="border-t border-danger/30 bg-danger/8">
          <div className="px-3 pt-2 text-10 font-semibold text-danger">stderr</div>
          <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-11 text-danger">
            {stderr}
          </pre>
        </div>
      ) : null}
      <CopyNotice status={status} />
    </div>
  );
}
