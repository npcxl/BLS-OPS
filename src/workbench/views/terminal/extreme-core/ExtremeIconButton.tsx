import type { IconComponent } from "@/components/icons";
import { Tooltip, type TooltipSide } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

/**
 * 超能模式统一的图标按钮。
 *
 * 所有纯图标操作都走项目统一的 `Tooltip`，不再混用浏览器原生 `title`、
 * 也没有"有的有提示、有的没有"。尺寸 / 圆角 / hover 也固定为一套，
 * 避免输入框、操作链、右栏各自长一个样。
 */
export function ExtremeIconButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  side = "top",
  className,
  iconSize = 13,
  danger = false,
  active = false,
}: {
  label: string;
  icon: IconComponent;
  onClick?: () => void;
  disabled?: boolean;
  side?: TooltipSide;
  className?: string;
  iconSize?: number;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip label={label} side={side}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[8px] text-fg-subtle transition-colors",
          "hover:bg-fg/8 hover:text-fg",
          "focus-visible:outline-2 focus-visible:outline-accent",
          "disabled:pointer-events-none disabled:opacity-40",
          active && "bg-accent/10 text-accent hover:text-accent",
          danger && "hover:bg-danger/10 hover:text-danger",
          className,
        )}
      >
        <Icon size={iconSize} />
      </button>
    </Tooltip>
  );
}
