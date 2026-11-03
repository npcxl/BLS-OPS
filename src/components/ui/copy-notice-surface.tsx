import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, X, XCircle } from "@/components/icons";
import { cn } from "@/lib/cn";

/**
 * 应用里所有"一次操作的结果"提示的**唯一样式**。
 *
 * 复制成功、表数据提交成功、提交冲突、回滚…… 全都用这一颗胶囊：同一个应用
 * 里不该出现"已复制"是胶囊、"已修改"是横幅、"失败"又是另一种横幅。
 * 位置也统一由使用方放在内容区底部居中（见 `CopyNotice` / `TableBrowser`）。
 *
 * 单层实心：不套 LiquidGlass，也不叠 backdrop-blur —— 不透明填充之下它们
 * 只剩一圈多余光晕和一次整屏合成。
 */
export type NoticeTone = "success" | "danger" | "warning";

const TONE_ICON = {
  success: CheckCircle2,
  danger: XCircle,
  warning: AlertTriangle,
} as const;

const TONE_TINT = {
  success: "bg-success/10 text-success",
  danger: "bg-danger/10 text-danger",
  warning: "bg-warning/10 text-warning",
} as const;

export function NoticePill({
  tone,
  children,
  actions,
  onDismiss,
  testId,
  title,
}: {
  tone: NoticeTone;
  children: ReactNode;
  /** 行内小动作（复制没有；提交冲突的"跳过校验 / 放弃并刷新"用）。 */
  actions?: ReactNode;
  /** 传了才显示关闭按钮；临时结果（成功）不传，靠自动消失。 */
  onDismiss?: () => void;
  testId?: string;
  /** 长内容（例如校验用的 SQL）放这里，鼠标悬停可看，不撑开胶囊。 */
  title?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      data-testid={testId}
      title={title}
      className="overlay-enter inline-flex max-w-full items-center gap-2 rounded-full border border-line/60 bg-surface-1/92 py-2 pl-2.5 pr-3 text-12 font-medium text-fg shadow-[0_4px_18px_rgb(0_0_0/0.08)]"
    >
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-full", TONE_TINT[tone])}>
        <Icon size={13} />
      </span>
      <span className="min-w-0 flex-1 break-words leading-snug">{children}</span>
      {actions ? <span className="flex shrink-0 items-center gap-1">{actions}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label="关闭"
          className="shrink-0 rounded-full p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
          onClick={onDismiss}
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

/** 复制反馈：`ok` 决定成功/失败色调，其余外观与其它结果提示完全一致。 */
export function CopyNoticeSurface({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <NoticePill tone={ok ? "success" : "danger"} testId="copy-notice">
      {children}
    </NoticePill>
  );
}
