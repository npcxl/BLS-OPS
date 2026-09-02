import { cn } from "@/lib/cn";

export function PanelButton({
  label,
  icon: Icon,
  disabled,
  className,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg",
        disabled && "pointer-events-none opacity-40",
        className,
      )}
    >
      <Icon size={13} strokeWidth={1.75} />
    </button>
  );
}
