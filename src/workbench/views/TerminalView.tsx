import { ChevronDown, Columns2, Eraser, FileText, MonitorCog, Rows2, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WorkspaceTab } from "@/workbench/types";
import { cn } from "@/lib/cn";

/** Terminal view — spec §30, §31. */
const MOCK_LINES = [
  { prompt: "root@api-01", cwd: "~", out: "$ docker ps" },
  { out: "CONTAINER ID   IMAGE          STATUS        PORTS" },
  { out: "a1b2c3d4e5f6   nginx:1.27     Up 2 hours    0.0.0.0:80->80/tcp" },
  { out: "f6e5d4c3b2a1   redis:7.2      Up 2 hours    6379/tcp" },
  { prompt: "root@api-01", cwd: "~", out: "$ " },
];

function ToolbarIcon({ label, icon: Icon, active }: { label: string; icon: React.ElementType; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-[5px] text-fg-muted hover:bg-surface-hover hover:text-fg",
        active && "text-accent",
      )}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}

export function TerminalView({ tab }: { tab: WorkspaceTab }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-app">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3">
        <span className="h-[6px] w-[6px] rounded-full bg-success" />
        <span className="text-12 font-semibold text-fg">{tab.title}</span>
        {tab.subtitle && <span className="truncate text-11 text-fg-subtle">{tab.subtitle}</span>}
        <span className="ml-auto flex items-center gap-1 rounded-control border border-line bg-surface-2 px-2 py-0.5 text-11 text-fg-muted">
          Ubuntu 24.04 · 4 CPU · RAM 42%
        </span>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line bg-surface-1 px-1.5">
        <ToolbarIcon label="搜索" icon={Search} />
        <ToolbarIcon label="垂直分栏" icon={Columns2} />
        <ToolbarIcon label="水平分栏" icon={Rows2} />
        <ToolbarIcon label="清空" icon={Eraser} />
        <div className="mx-1.5 h-4 w-px bg-line" />
        <Button variant="ghost" size="xs" className="gap-1 text-11">
          <ChevronDown size={12} />
          <span>API-01</span>
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <ToolbarIcon label="文件" icon={FileText} />
          <ToolbarIcon label="监控" icon={MonitorCog} />
          <ToolbarIcon label="智能助手" icon={Sparkles} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[#090c10] p-3 font-mono text-[13px] leading-[1.55]" data-selectable>
        <div className="flex flex-col">
          {MOCK_LINES.map((line, i) => (
            <div key={i} className="flex gap-1.5">
              {line.prompt && (
                <span>
                  <span className="text-success">{line.prompt}</span>
                  <span className="text-fg-subtle">:{line.cwd}</span>
                  <span className="text-accent">#</span>
                </span>
              )}
              <span className="text-[#c7d0dc]">{line.out}</span>
            </div>
          ))}
          <span className="inline-block h-[15px] w-[7px] animate-pulse bg-fg-muted" />
        </div>
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-surface-1 px-3 text-11 text-fg-subtle">
        <span className="flex items-center gap-1">
          <span className="h-[5px] w-[5px] rounded-full bg-success" />
          已连接
        </span>
        <span>18 ms</span>
        <span className="ml-auto">UTF-8</span>
        <span>CRLF</span>
        <span>xterm</span>
      </div>
    </div>
  );
}
