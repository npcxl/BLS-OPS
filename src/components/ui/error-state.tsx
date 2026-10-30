/**
 * 页面级 / 区块级错误状态 —— 一次失败要回答三个问题：
 * 出了什么事、能不能重试、详细报错在哪。
 *
 * 与 toast 的分工：
 * - toast 用于"用户刚做的一个动作失败了"，且页面本身还是可用的；
 * - `ErrorState` 用于"这一块内容加载不出来"（列表、详情、面板整个空掉），
 *   它占住内容区，必须自带重试入口，否则用户只能靠开关标签页碰运气。
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy, RotateCcw, TriangleAlert } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { canRetry, formatErrorForCopy, stageLabel, toAppError } from "@/lib/app-error";

export interface ErrorStateProps {
  /** 任意异常；字符串、Error、后端结构化错误都行。 */
  error: unknown;
  /** 这一块是干什么的，例如「加载数据表结构」。 */
  title?: string;
  /** 额外说明（默认用后端给的恢复建议）。 */
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** 紧凑模式：嵌在面板/侧栏里，不占整屏高度。 */
  compact?: boolean;
  /** 附加操作（例如「重新选择连接」）。 */
  extra?: ReactNode;
  className?: string;
}

export function ErrorState({
  error,
  title,
  description,
  onRetry,
  retryLabel,
  compact = false,
  extra,
  className,
}: ErrorStateProps) {
  const { t } = useTranslation();
  const info = toAppError(error);
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const label = stageLabel(info.stage);
  const detail = info.detail;
  const retryable = canRetry(info, onRetry);

  const copy = async () => {
    const ok = await copyText(formatErrorForCopy(info, title));
    setCopied(ok ? "done" : "failed");
    window.setTimeout(() => setCopied("idle"), 1600);
  };

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center text-center",
        compact ? "gap-1.5 px-3 py-4" : "gap-2 px-6 py-8",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-danger/12 text-danger",
          compact ? "size-7" : "size-9",
        )}
      >
        <TriangleAlert size={compact ? 13 : 16} strokeWidth={1.8} />
      </div>

      <div className="flex max-w-lg flex-col gap-1">
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <h3 className={cn("font-semibold text-fg", compact ? "text-12" : "text-13")}>
            {title ?? t("Something went wrong")}
          </h3>
          {label && (
            <span className="rounded bg-danger/12 px-1 py-px text-10 font-medium text-danger">
              {label}
            </span>
          )}
          {info.code && (
            <span className="text-10 tabular-nums text-fg-subtle">[{info.code}]</span>
          )}
          {info.outcomeUnknown && (
            <span className="rounded bg-warning/15 px-1 py-px text-10 font-medium text-warning">
              {t("Outcome unknown")}
            </span>
          )}
        </div>
        <p className="break-words text-11 leading-relaxed text-fg-muted">{info.message}</p>
        {(description ?? info.hint) && (
          <p className="break-words text-11 leading-relaxed text-fg-subtle">
            {description ?? info.hint}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {retryable && (
          <Button variant="secondary" size="xs" onClick={onRetry}>
            <RotateCcw size={11} />
            {retryLabel ?? t("Retry")}
          </Button>
        )}
        {extra}
        {(detail || info.code) && (
          <Button variant="ghost" size="xs" onClick={() => setShowDetail((value) => !value)}>
            <ChevronDown size={11} className={cn(showDetail && "rotate-180")} />
            {showDetail ? t("Hide details") : t("Show details")}
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => void copy()}>
          <Copy size={11} />
          {copied === "done"
            ? t("Copied")
            : copied === "failed"
              ? t("Copy failed. Please check clipboard permission")
              : t("Copy error details")}
        </Button>
      </div>

      {showDetail && detail && (
        <pre className="mt-1 max-h-40 w-full max-w-lg overflow-auto rounded-[8px] border border-line bg-surface-2 p-2 text-left text-10 leading-relaxed break-words whitespace-pre-wrap text-fg-subtle">
          {detail}
        </pre>
      )}
    </div>
  );
}
