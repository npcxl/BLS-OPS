/** 快速入口：每个按钮都走已有的模块导航（`openModuleTab` / 真实弹窗）。 */
import type { IconComponent } from "@/components/icons";
import { cn } from "@/lib/cn";

export interface QuickAction {
  id: string;
  label: string;
  hint: string;
  icon: IconComponent;
  onSelect: () => void;
}

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            onClick={action.onSelect}
            data-testid={`home-action-${action.id}`}
            className={cn(
              "group flex min-w-0 items-center gap-2.5 rounded-[10px] border border-line bg-surface-1/70 px-3 py-2.5 text-left",
              "transition-colors hover:border-line-strong hover:bg-surface-hover/60",
            )}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-fg-muted transition-colors group-hover:bg-accent/10 group-hover:text-accent">
              <Icon size={14} strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-12 font-medium text-fg">{action.label}</span>
              <span className="truncate text-11 text-fg-subtle">{action.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
