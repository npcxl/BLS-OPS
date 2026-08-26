import type { LucideIcon } from "lucide-react";
import {
  Boxes,
  Container,
  Files,
  Globe,
  ListTodo,
  Rocket,
  Server,
  Settings,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import { useWorkbenchStore } from "@/stores/workbench-store";
import type { NavModule } from "@/workbench/types";
import { cn } from "@/lib/cn";

/**
 * Primary Navigation Rail — spec §7.
 * 48px, icons only, label reveals on hover, 2px active indicator on the left.
 */

interface NavItem {
  id: NavModule;
  label: string;
  icon: LucideIcon;
  divider?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "ssh", label: "SSH", icon: SquareTerminal },
  { id: "servers", label: "Servers", icon: Server },
  { id: "files", label: "Files", icon: Files },
  { id: "projects", label: "Projects", icon: Boxes },
  { id: "deploy", label: "Deploy", icon: Rocket },
  { id: "docker", label: "Docker", icon: Container },
  { id: "nginx", label: "Nginx", icon: Globe },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "ai", label: "AI", icon: Sparkles, divider: true },
  { id: "settings", label: "Settings", icon: Settings },
];

function RailButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={item.label}
      className={cn(
        "group relative flex h-11 w-11 items-center justify-center outline-none",
        active ? "bg-surface-active text-accent" : "text-fg-subtle hover:bg-surface-hover hover:text-fg",
      )}
    >
      {/* active indicator */}
      <span
        className={cn(
          "absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r-full transition-opacity",
          active ? "bg-accent opacity-100" : "opacity-0",
        )}
      />
      <Icon size={18} strokeWidth={1.75} />
      {/* hover label (tooltip-style) */}
      <span className="pointer-events-none absolute left-[calc(100%+6px)] z-50 whitespace-nowrap rounded-[6px] border border-line bg-surface-3 px-2 py-1 text-11 text-fg opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100">
        {item.label}
      </span>
    </button>
  );
}

export function NavigationRail() {
  const activeModule = useWorkbenchStore((s) => s.activeModule);
  const setModule = useWorkbenchStore((s) => s.setModule);

  return (
    <nav className="flex w-12 shrink-0 flex-col items-center border-r border-line bg-surface-1 py-1" aria-label="Navigation">
      {NAV_ITEMS.map((item) =>
        item.divider ? (
          <div key="divider" className="my-1 h-px w-6 bg-line" />
        ) : (
          <RailButton key={item.id} item={item} active={activeModule === item.id} onClick={() => setModule(item.id)} />
        ),
      )}
    </nav>
  );
}
