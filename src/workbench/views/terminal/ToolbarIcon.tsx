import { cn } from "@/lib/cn";

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
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-[8px] border border-transparent text-fg-muted transition-colors duration-150 ease-out hover:border-line hover:bg-surface-2 hover:text-fg",
        active && "border-line bg-surface-active text-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}
