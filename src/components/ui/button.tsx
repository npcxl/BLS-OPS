import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Ops Workbench Button — spec §24.
 * Sizes: XS 24 / SM 28 / MD 30 / LG 34. Default MD.
 * Default variant is ghost (dense desktop tooling, not filled buttons everywhere).
 */

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "xs" | "sm" | "md" | "lg";

const variantClasses: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent/90 active:bg-accent/80",
  secondary:
    "bg-surface-3 text-fg border border-line hover:bg-surface-hover hover:border-line-strong",
  ghost: "text-fg-muted hover:text-fg hover:bg-surface-hover",
  outline: "text-fg border border-line-strong hover:bg-surface-hover hover:border-fg-subtle",
  danger: "text-danger hover:bg-danger/10",
};

const sizeClasses: Record<Size, string> = {
  xs: "h-6 px-2 gap-1 text-11",
  sm: "h-7 px-2.5 gap-1.5 text-12",
  md: "h-[30px] px-3 gap-1.5 text-13",
  lg: "h-[34px] px-4 gap-2 text-13",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({ variant = "ghost", size = "md", className, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 cursor-default items-center justify-center rounded-control font-medium select-none",
        "transition-colors duration-100",
        "disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
