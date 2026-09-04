import type { ReactNode } from "react";

/** Uppercase section heading with an optional right-aligned action row. */
export function SectionTitle({
  children,
  actions,
}: {
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center justify-between px-2.5">
      <span className="text-11 font-semibold tracking-[0.08em] text-fg-subtle uppercase">
        {children}
      </span>
      {actions}
    </div>
  );
}
