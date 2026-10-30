import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, WifiOff } from "@/components/icons";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { stageLabel, toAppError } from "@/lib/app-error";

export interface TerminalErrorBannerProps {
  /** 原始异常（或一句人话）：横幅自己解析成 阶段 / 摘要 / 详情。 */
  error: unknown;
  onCopy: () => void;
  onRetry: () => void;
}

/**
 * 连接失败 / 断线的红色横幅（含阶段、详情、复制与重试）。
 *
 * 为什么只有一行 + 可展开：终端上方是寸土寸金的位置，把后端原文整段铺开
 * 会把终端挤走；但只有一行又会让人"看不出到底哪一步挂了"——所以摘要常显、
 * 详情按需展开，复制始终拿得到完整信息。
 */
export function TerminalErrorBanner({ error, onCopy, onRetry }: TerminalErrorBannerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const info = toAppError(error);
  const detail = info.detail ?? info.hint ?? null;

  return (
    <div className="shrink-0 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
      <div className="flex items-center gap-2">
        <WifiOff size={12} className="shrink-0" />
        {info.stage && (
          <span className="shrink-0 rounded-[4px] bg-danger/15 px-1 py-px text-10 font-medium">
            {stageLabel(info.stage)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" title={info.message}>
          {info.message}
        </span>
        {detail && (
          <button
            type="button"
            aria-label={open ? t("Hide details") : t("Show details")}
            aria-expanded={open}
            title={open ? t("Hide details") : t("Show details")}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded-[6px] px-1.5 text-11 text-danger/80 hover:bg-danger/10 hover:text-danger"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
        <button
          type="button"
          aria-label={t("Copy error message")}
          title={t("Copy error message")}
          className="flex h-6 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-11 text-danger/80 hover:bg-danger/10 hover:text-danger"
          onClick={onCopy}
        >
          <Copy size={12} />
          {t("Copy")}
        </button>
        <Button variant="ghost" size="xs" onClick={onRetry}>
          {t("Retry")}
        </Button>
      </div>
      {open && detail && (
        <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-surface-1/70 px-2 py-1 font-mono text-10 leading-relaxed text-fg-muted">
          {detail}
        </pre>
      )}
    </div>
  );
}
