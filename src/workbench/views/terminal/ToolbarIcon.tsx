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
          "flex h-7 w-7 items-center justify-center rounded-[8px] text-fg-muted transition-colors duration-150 ease-out hover:bg-tab-hover hover:text-fg",
          // 选中态与页签共用一套：薄填充 + 发丝高光。图标留强调色，
          // 免得和 hover 只差一个色阶、看不出"开着"。
          active && "bg-tab-active text-accent shadow-[var(--tab-active-shadow)]",
          disabled && "pointer-events-none opacity-40",
        )}
      >
        <Icon size={13} strokeWidth={1.75} />
      </button>
    </Tooltip>
  );
}
