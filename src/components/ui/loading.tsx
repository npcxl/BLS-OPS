import type { HTMLAttributes, ReactNode } from "react";
import { LoaderCircle, type LucideProps } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className, ...props }: LucideProps) {
  return <LoaderCircle aria-label="加载中" className={cn("animate-spin text-fg-subtle", className)} {...props} />;
}

export interface LoadingStateProps extends HTMLAttributes<HTMLDivElement> {
  label?: ReactNode;
  compact?: boolean;
}

export function LoadingState({ label = "加载中…", compact = false, className, ...props }: LoadingStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center justify-center gap-2 text-11 text-fg-subtle",
        compact ? "py-2" : "min-h-24 py-6",
        className,
      )}
      {...props}
    >
      <Spinner size={14} strokeWidth={1.8} />
      <span>{label}</span>
    </div>
  );
}
