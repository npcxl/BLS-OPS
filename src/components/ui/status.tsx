import type { HTMLAttributes, ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClasses: Record<StatusTone, { badge: string; notice: string; icon: string }> = {
  success: {
    badge: "bg-success/12 text-success",
    notice: "border-success/25 bg-success/10 text-success",
    icon: "text-success",
  },
  warning: {
    badge: "bg-warning/14 text-warning",
    notice: "border-warning/28 bg-warning/10 text-warning",
    icon: "text-warning",
  },
  danger: {
    badge: "bg-danger/12 text-danger",
    notice: "border-danger/25 bg-danger/10 text-danger",
    icon: "text-danger",
  },
  info: {
    badge: "bg-accent/12 text-accent",
    notice: "border-accent/25 bg-accent/10 text-accent",
    icon: "text-accent",
  },
  neutral: {
    badge: "bg-surface-3 text-fg-muted",
    notice: "border-line bg-surface-2 text-fg-muted",
    icon: "text-fg-subtle",
  },
};

const toneIcons = {
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
  info: Info,
  neutral: Info,
} satisfies Record<StatusTone, typeof Info>;

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  dot?: boolean;
  children: ReactNode;
}

export function StatusBadge({ tone = "neutral", dot = true, className, children, ...props }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-10 font-medium leading-none select-none",
        toneClasses[tone].badge,
        className,
      )}
      {...props}
    >
      {dot && <span className="size-1.5 rounded-full bg-current opacity-80" aria-hidden="true" />}
      {children}
    </span>
  );
}

export interface StatusNoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: StatusTone;
  title?: string;
  icon?: boolean;
  children: ReactNode;
}

export function StatusNotice({
  tone = "info",
  title,
  icon = true,
  className,
  children,
  ...props
}: StatusNoticeProps) {
  const Icon = toneIcons[tone];

  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-[9px] border px-2.5 py-2 text-11 leading-relaxed",
        toneClasses[tone].notice,
        className,
      )}
      {...props}
    >
      {icon && <Icon size={15} strokeWidth={1.9} className={cn("mt-px shrink-0", toneClasses[tone].icon)} />}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <div className={cn(title && "mt-0.5", "text-fg-muted")}>{children}</div>
      </div>
    </div>
  );
}

export function SuccessNotice(props: Omit<StatusNoticeProps, "tone">) {
  return <StatusNotice tone="success" {...props} />;
}

export function WarningNotice(props: Omit<StatusNoticeProps, "tone">) {
  return <StatusNotice tone="warning" {...props} />;
}

export function DangerNotice(props: Omit<StatusNoticeProps, "tone">) {
  return <StatusNotice tone="danger" {...props} />;
}
