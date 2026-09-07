import { Copy, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export interface TerminalErrorBannerProps {
  message: string;
  onCopy: () => void;
  onRetry: () => void;
}

/**
 * 连接失败 / 断线的红色横幅（含复制错误与重试）。
 *
 * 复制走共用模块（有成功失败提示），这里只负责把入口画出来。
 */
export function TerminalErrorBanner({ message, onCopy, onRetry }: TerminalErrorBannerProps) {
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-11 text-danger">
      <WifiOff size={12} />
      <span className="min-w-0 flex-1 truncate">{message}</span>
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
  );
}
