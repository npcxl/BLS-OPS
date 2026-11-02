import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { IconComponent } from "@/components/icons";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * 图标按钮的兼容出口。
 *
 * 视觉规则只有一套，就在 `Button` 里。这里只做三件事：
 * 1. 图标按钮的**宽度跟随 size**（以前固定 30px，xs 的图标按钮会比同排
 *    24px 的按钮高出一截，sm/md 又对不齐）；
 * 2. 传 `tip` 时统一走 Tooltip（不再各自写 `title`）；
 * 3. `iconOnly` 时把 `children` 当成 `aria-label`，保证读屏器与自动化测试
 *    都能拿到名字。
 *
 * 新代码直接用 `<IconButton icon={...} aria-label="..." />`；
 * `<MacButton>` 保留给历史调用点，不再维护第二套外观。
 */

/** 图标按钮的方形宽度：与 Button/Input 的 24/28/30/34 档位一一对应。 */
const ICON_BUTTON_WIDTH: Record<NonNullable<ButtonProps["size"]>, string> = {
  xs: "w-6",
  sm: "w-7",
  md: "w-[30px]",
  lg: "w-[34px]",
};

const ICON_GLYPH_SIZE: Record<NonNullable<ButtonProps["size"]>, number> = {
  xs: 12,
  sm: 14,
  md: 14,
  lg: 16,
};

/** 调用方显式给了宽度（`w-*` / `size-*`）就不再套公共宽度，避免两套类打架。 */
function hasExplicitWidth(className?: string): boolean {
  return !!className && /(^|\s)(!?)(w|size)-/.test(className);
}

export interface MacButtonProps extends ButtonProps {
  icon?: IconComponent;
  iconOnly?: boolean;
  children?: ReactNode;
  /** 图标按钮的悬停提示。传入后用统一 Tooltip 替代原生 title。 */
  tip?: ReactNode;
}

export function MacButton({
  icon: Icon,
  iconOnly = false,
  className,
  children,
  size = "sm",
  tip,
  ...props
}: MacButtonProps) {
  const label = iconOnly && typeof children === "string" ? children : props["aria-label"];
  const button = (
    <Button
      size={size}
      className={cn(
        iconOnly && "!px-0",
        iconOnly && !hasExplicitWidth(className) && ICON_BUTTON_WIDTH[size],
        className,
      )}
      aria-label={label}
      {...props}
    >
      {Icon && <Icon size={ICON_GLYPH_SIZE[size]} strokeWidth={1.8} aria-hidden="true" />}
      {!iconOnly && children}
    </Button>
  );
  if (tip) return <Tooltip label={tip}>{button}</Tooltip>;
  return button;
}

export function IconButton({
  icon,
  "aria-label": ariaLabel,
  className,
  size = "sm",
  tip,
  ...props
}: MacButtonProps) {
  return (
    <MacButton
      icon={icon}
      iconOnly
      aria-label={ariaLabel}
      size={size}
      className={className}
      tip={tip}
      {...props}
    />
  );
}

export type MacButtonHTMLAttributes = ButtonHTMLAttributes<HTMLButtonElement>;
