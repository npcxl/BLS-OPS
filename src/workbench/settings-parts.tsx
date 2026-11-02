/**
 * Shared building blocks of the settings page.
 *
 * 统一使用页面骨架的「设置分组」样式（`.page-form-*`）：分组标题、说明、
 * 分组列表与行高只有一处定义，新增设置项不再各写一套圆角/内边距。
 */
import { cn } from "@/lib/cn";

export function Group({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="page-form-group">
      <div className="page-form-heading">
        <span>{title}</span>
        {action}
      </div>
      {hint && <p className="page-form-help px-0.5">{hint}</p>}
      {children}
    </section>
  );
}

/** Grouped inset list — one surface, rows divided by a hairline. */
export function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="page-form-list">
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

export function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="page-form-row justify-center text-11 text-fg-subtle">{children}</p>;
}

/** A single `label / value` row. */
export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="page-form-row">
      <span className="page-form-label shrink-0 text-fg-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right text-11 text-fg">{value}</span>
    </div>
  );
}

/**
 * macOS-style switch.
 *
 * A `button[role=switch]` rather than a checkbox input: the desktop chrome
 * draws its own knob and the accessible state comes from `aria-checked`.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-[32px] shrink-0 cursor-default rounded-full transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-accent" : "bg-surface-active",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-150",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}
