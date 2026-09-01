import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  title = "暂无内容",
  description,
  icon = <Inbox size={22} strokeWidth={1.5} />,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("flex min-h-32 flex-col items-center justify-center px-6 py-8 text-center", className)}>
      <div className="mb-2.5 flex size-9 items-center justify-center rounded-[10px] bg-surface-3 text-fg-subtle">{icon}</div>
      <p className="text-12 font-medium text-fg-muted">{title}</p>
      {description && <p className="mt-1 max-w-xs text-11 leading-relaxed text-fg-subtle">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
