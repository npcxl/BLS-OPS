import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";

/** Small square icon button used in the terminal toolbar. */
export function ToolbarIcon({
  label,
  icon: Icon,
  active,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-[8px] text-fg-muted transition-colors duration-150 ease-out hover:bg-fg/8 hover:text-fg",
          // 与顶栏 Select(iconOnly) 共用一套中性薄填充；激活态仅保留强调色与柔和底色。
          active && "bg-fg/10 text-accent",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        <Icon size={13} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}
