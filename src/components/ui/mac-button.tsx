import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface MacButtonProps extends ButtonProps {
  icon?: LucideIcon;
  iconOnly?: boolean;
  children?: ReactNode;
}

export function MacButton({ icon: Icon, iconOnly = false, className, children, size = "sm", ...props }: MacButtonProps) {
  return (
    <Button
      size={size}
      className={cn(iconOnly && "!w-[30px] !px-0", className)}
      aria-label={iconOnly && typeof children === "string" ? children : props["aria-label"]}
      {...props}
    >
      {Icon && <Icon size={14} strokeWidth={1.8} aria-hidden="true" />}
      {!iconOnly && children}
    </Button>
  );
}

export function IconButton({ icon: Icon, "aria-label": ariaLabel, className, size = "sm", ...props }: MacButtonProps) {
  return (
    <MacButton
      icon={Icon}
      iconOnly
      aria-label={ariaLabel}
      size={size}
      className={cn("!w-[30px]", className)}
      {...props}
    />
  );
}

export type MacButtonHTMLAttributes = ButtonHTMLAttributes<HTMLButtonElement>;
