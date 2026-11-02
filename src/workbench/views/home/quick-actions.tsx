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
    <div className="home-shortcuts">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            onClick={action.onSelect}
            data-testid={`home-action-${action.id}`}
            className={cn(
              "home-shortcut group min-w-0 text-left",
              "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2",
            )}
          >
            <span className="home-shortcut-icon">
              <Icon size={19} strokeWidth={1.65} />
            </span>
            <span className="min-w-0 flex flex-col">
              <span className="truncate text-13 font-medium text-fg">{action.label}</span>
              <span className="truncate text-11 text-fg-subtle">{action.hint}</span>
            </span>
            <svg className="home-shortcut-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
          </button>
        );
      })}
    </div>
  );
}
