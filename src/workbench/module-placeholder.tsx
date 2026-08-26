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
import type { NavModule } from "@/workbench/types";

/**
 * Placeholder sidebar bodies for modules that land in later phases.
 * Each entry lists the real planned context sections from the spec.
 */

interface ModuleSpec {
  title: string;
  icon: LucideIcon;
  phase: string;
  sections: string[];
}

const MODULES: Record<NavModule, ModuleSpec> = {
  ssh: { title: "SSH", icon: SquareTerminal, phase: "Phase 1", sections: [] },
  servers: {
    title: "Servers",
    icon: Server,
    phase: "Phase 2",
    sections: ["Server tree", "Groups", "Status", "Search"],
  },
  files: {
    title: "Files",
    icon: Files,
    phase: "Phase 3",
    sections: ["Remote Explorer", "Transfer Queue"],
  },
  projects: {
    title: "Projects",
    icon: Boxes,
    phase: "Phase 5",
    sections: ["Recent", "Groups", "Relations"],
  },
  deploy: {
    title: "Deploy",
    icon: Rocket,
    phase: "Phase 6",
    sections: ["Targets", "Workflows", "History"],
  },
  docker: {
    title: "Docker",
    icon: Container,
    phase: "Phase 4",
    sections: ["Servers", "Containers", "Images", "Compose"],
  },
  nginx: {
    title: "Nginx",
    icon: Globe,
    phase: "Phase 4",
    sections: ["Instances", "Sites", "Upstreams", "Certificates"],
  },
  tasks: {
    title: "Tasks",
    icon: ListTodo,
    phase: "Phase 2",
    sections: ["Build", "Upload", "Deploy", "History"],
  },
  ai: {
    title: "AI",
    icon: Sparkles,
    phase: "Phase 7",
    sections: ["Context", "Providers", "History"],
  },
  settings: {
    title: "Settings",
    icon: Settings,
    phase: "Phase 1",
    sections: ["General", "Credentials", "Known hosts", "Keyring"],
  },
};

export function ModulePlaceholderSidebar({ module }: { module: NavModule }) {
  const spec = MODULES[module];
  const Icon = spec.icon;
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-[6px] border border-line bg-surface-2 text-fg-subtle">
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <div>
          <div className="text-12 font-semibold text-fg">{spec.title}</div>
          <div className="text-11 text-fg-subtle">{spec.phase}</div>
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        {spec.sections.map((section) => (
          <div
            key={section}
            className="flex h-7 items-center rounded-[6px] px-2.5 text-12 text-fg-muted hover:bg-surface-hover hover:text-fg"
          >
            {section}
          </div>
        ))}
      </div>
      <p className="mt-1 border-t border-line pt-2 text-11 leading-relaxed text-fg-subtle">
        {spec.title} context lands in {spec.phase}.
      </p>
    </div>
  );
}
