import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";

/**
 * 图标小按钮：`label` 是英文 key（模块级常量里不能调 hook），渲染处统一
 * `t(...)` 输出到 aria-label 与 title。
 */
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
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-label={t(label)}
      title={t(label)}
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
