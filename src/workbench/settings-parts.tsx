/**
 * Shared building blocks of the settings sidebar.
 *
 * Extracted verbatim from `settings-context-sidebar.tsx` so new sections
 * (P5.1 应用更新) can reuse the exact same macOS-style grouped list instead of
 * growing a second, slightly different look.
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
    <section className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center justify-between px-0.5">
        <span className="text-11 font-semibold uppercase tracking-[0.08em] text-fg-subtle">{title}</span>
        {action}
      </div>
      {hint && <p className="px-0.5 text-11 leading-relaxed text-fg-subtle">{hint}</p>}
      {children}
    </section>
  );
}

/** macOS-style grouped inset list — a rounded panel whose rows are divided. */
export function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-surface-1/70 shadow-[inset_0_1px_0_rgb(255_255_255/0.4)]">
      <div className="divide-y divide-line/60">{children}</div>
    </div>
  );
}

export function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-11 text-fg-subtle">{children}</p>;
}

/** A single `label / value` row. */
export function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="shrink-0 text-11 text-fg-muted">{label}</span>
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
