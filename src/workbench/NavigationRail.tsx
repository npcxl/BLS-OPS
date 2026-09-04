import { useTranslation } from "react-i18next";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { NavModule } from "@/workbench/types";
import { cn } from "@/lib/cn";
import {
  TerminalIcon,
  WorldIcon,
  GearIcon,
  FileDescriptionIcon,
  Stack3Icon,
  RocketIcon,
  UnorderedListIcon,
  SparklesIcon,
} from "@/components/its-hover";
import type { ComponentType } from "react";

/**
 * Primary Navigation Rail — the far-left icon strip.
 * Icons only, label reveals on hover, accent highlight for the active module.
 */

interface NavItem {
  id: NavModule;
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string; color?: string }>;
  divider?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "ssh", label: "Module: Terminal", icon: TerminalIcon },
  { id: "services", label: "Module: Services", icon: WorldIcon },
  { id: "logs", label: "Module: Logs", icon: FileDescriptionIcon },
  { id: "projects", label: "Module: Projects", icon: Stack3Icon },
  { id: "deploy", label: "Module: Deploy", icon: RocketIcon },
  { id: "tasks", label: "Module: Tasks", icon: UnorderedListIcon },
  { id: "ai", label: "Module: AI", icon: SparklesIcon, divider: true },
  { id: "settings", label: "Module: Settings", icon: GearIcon },
];

function RailButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  const Icon = item.icon;
  const label = t(item.label);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-10 w-10 items-center justify-center rounded-[10px] outline-none transition-colors",
        active ? "text-accent" : "text-fg-subtle hover:text-fg",
      )}
    >
      {/* active indicator bar (left) */}
      <span
        className={cn(
          "pointer-events-none absolute left-[-8px] h-5 w-[3px] rounded-r-full bg-accent transition-all duration-200",
          active ? "opacity-100 scale-y-100" : "opacity-0 scale-y-0",
        )}
      />
      <Icon size={19} className="transition-transform duration-200 group-hover:scale-110" color="currentColor" />
      <span className="pointer-events-none absolute left-[calc(100%+6px)] z-50 whitespace-nowrap rounded-[7px] border border-line bg-surface-3 px-2 py-1 text-11 text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}

export function NavigationRail() {
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const openModuleTab = useWorkbenchStore((s) => s.openModuleTab);

  return (
    <nav
      className="relative z-30 flex w-[52px] shrink-0 flex-col items-center gap-1  py-2"
      aria-label="Navigation"
    >
      {NAV_ITEMS.map((item) =>
        item.divider ? (
          <div key="divider" className="my-1.5 h-px w-5 bg-line" />
        ) : (
          <RailButton key={item.id} item={item} active={activeModule === item.id} onClick={() => openModuleTab(item.id)} />
        ),
      )}
    </nav>
  );
}
