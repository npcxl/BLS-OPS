import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

export interface MacButtonProps extends ButtonProps {
  icon?: LucideIcon;
  iconOnly?: boolean;
  children?: ReactNode;
  /** 图标按钮的悬停提示。传入后用统一 Tooltip 替代原生 title。 */
  tip?: ReactNode;
}

export function MacButton({ icon: Icon, iconOnly = false, className, children, size = "sm", tip, ...props }: MacButtonProps) {
  const label = iconOnly && typeof children === "string" ? children : props["aria-label"];
  const button = (
    <Button
      size={size}
      className={cn(iconOnly && "!w-[30px] !px-0", className)}
      aria-label={label}
      {...props}
    >
      {Icon && <Icon size={14} strokeWidth={1.8} aria-hidden="true" />}
      {!iconOnly && children}
    </Button>
  );
  if (tip) return <Tooltip label={tip}>{button}</Tooltip>;
  return button;
}

export function IconButton({ icon: Icon, "aria-label": ariaLabel, className, size = "sm", tip, ...props }: MacButtonProps) {
  return (
    <MacButton
      icon={Icon}
      iconOnly
      aria-label={ariaLabel}
      size={size}
      className={cn("!w-[30px]", className)}
      tip={tip}
      {...props}
    />
  );
}

export type MacButtonHTMLAttributes = ButtonHTMLAttributes<HTMLButtonElement>;
