import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Minus, Search, X } from "lucide-react";
import { cn } from "@/lib/cn";

export interface MacWindowControlsProps extends HTMLAttributes<HTMLDivElement> {
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  labels?: {
    close?: string;
    minimize?: string;
    maximize?: string;
  };
}

export function MacWindowControls({
  onClose,
  onMinimize,
  onMaximize,
  labels = {},
  className,
  ...props
}: MacWindowControlsProps) {
  const { t } = useTranslation();
  const controls = [
    { label: labels.close ?? t("Close window"), icon: X, onClick: onClose, color: "bg-[#ff5f57]" },
    { label: labels.minimize ?? t("Minimize window"), icon: Minus, onClick: onMinimize, color: "bg-[#febc2e]" },
    { label: labels.maximize ?? t("Maximize window"), icon: null, onClick: onMaximize, color: "bg-[#28c840]" },
  ];

  return (
    <div className={cn("group/window-controls flex items-center gap-2", className)} {...props}>
      {controls.map(({ label, icon: Icon, onClick, color }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          className={cn(
            "flex size-3.5 items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgb(0_0_0/0.16)]",
            "transition-[filter,transform] duration-150 hover:brightness-95 active:scale-90",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            color,
          )}
          onClick={onClick}
        >
          {Icon && <Icon className="size-2.5 opacity-0 transition-opacity group-hover/window-controls:opacity-70" strokeWidth={2.5} />}
          {!Icon && <span className="size-1.5 rounded-[1px] border-[1.5px] border-black/45 opacity-0 transition-opacity group-hover/window-controls:opacity-70" />}
        </button>
      ))}
    </div>
  );
}

// `title` is widened from the DOM's `string` to any node, so the DOM
// attribute is dropped from the inherited props.
export interface MacTitlebarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  controls?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
}

export function MacTitlebar({
  title,
  subtitle,
  leading,
  trailing,
  controls = true,
  onClose,
  onMinimize,
  onMaximize,
  className,
  ...props
}: MacTitlebarProps) {
  return (
    <header
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-3 border-b border-line bg-surface-2/75 px-3",
        "[--titlebar-height:44px]",
        className,
      )}
      {...props}
    >
      {controls && <MacWindowControls onClose={onClose} onMinimize={onMinimize} onMaximize={onMaximize} />}
      {leading}
      <div className="min-w-0 flex-1 text-center">
        {title && <div className="truncate text-12 font-semibold text-fg">{title}</div>}
        {subtitle && <div className="truncate text-10 text-fg-subtle">{subtitle}</div>}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">{trailing}</div>
    </header>
  );
}

export interface MacToolbarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  divided?: boolean;
}

export function MacToolbar({ children, divided = true, className, ...props }: MacToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center gap-1.5 bg-surface-1/65 px-3 py-1.5",
        divided && "border-b border-line",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface MacSegmentedControlProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
}

export function MacSegmentedControl({ value, onChange, options, className, ...props }: MacSegmentedControlProps) {
  return (
    <div
      role="radiogroup"
      className={cn("inline-flex min-h-7 rounded-[7px] bg-surface-3 p-0.5 shadow-[inset_0_0_0_1px_rgb(var(--line)/0.7)]", className)}
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            className={cn(
              "rounded-[5px] px-2.5 text-11 font-medium transition-[background-color,box-shadow,color] duration-150",
              "disabled:pointer-events-none disabled:opacity-45",
              selected
                ? "bg-surface-1 text-fg shadow-[0_1px_2px_rgb(15_23_42/0.14),0_0_0_0.5px_rgb(var(--line)/0.9)]"
                : "text-fg-muted hover:text-fg",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface MacSearchFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  onClear?: () => void;
}

export function MacSearchField({ onClear, className, ...props }: MacSearchFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="relative flex min-w-0 items-center">
      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-fg-subtle" strokeWidth={2} aria-hidden="true" />
      <input
        type="search"
        className={cn(
          "h-7 min-w-0 w-full rounded-[7px] border border-line bg-surface-2/80 pl-8 pr-7 text-11 text-fg",
          "outline-none placeholder:text-fg-subtle shadow-[inset_0_1px_1px_rgb(15_23_42/0.04)] focus:border-accent",
          "[&::-webkit-search-cancel-button]:hidden",
          className,
        )}
        {...props}
      />
      {onClear && props.value && (
        <button type="button" aria-label={t("Clear search")} className="absolute right-1.5 rounded-full p-0.5 text-fg-subtle hover:bg-surface-hover hover:text-fg" onClick={onClear}>
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

export interface MacSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function MacSwitch({ checked, onChange, className, ...props }: MacSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative inline-flex h-5 w-8 shrink-0 rounded-full p-0.5 transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        checked ? "bg-accent" : "bg-surface-3 shadow-[inset_0_0_0_1px_rgb(var(--line-strong)/0.9)]",
        className,
      )}
      onClick={() => onChange(!checked)}
      {...props}
    >
      <span className={cn("flex size-4 items-center justify-center rounded-full bg-white shadow-[0_1px_2px_rgb(15_23_42/0.22)] transition-transform duration-150", checked && "translate-x-3")}>
        {checked && <Check className="size-2.5 text-accent" strokeWidth={3} aria-hidden="true" />}
      </span>
    </button>
  );
}

export function MacSelectChevron() {
  return <ChevronDown className="pointer-events-none size-3.5 text-fg-subtle" aria-hidden="true" />;
}
