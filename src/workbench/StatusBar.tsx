import { APP_VERSION } from "@/app/app-meta";
import { cn } from "@/lib/cn";

interface StatusBarProps {
  connectedSessions: number;
  runningTasks: number;
  transferDown: string;
  transferUp: string;
  aiReady: boolean;
}

/** Status Bar — spec §15. */
export function StatusBar({ connectedSessions, runningTasks, transferDown, transferUp, aiReady }: StatusBarProps) {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-0 border-t border-line bg-surface-1 px-2.5 text-11 text-fg-muted">
      <span className="flex items-center gap-1.5">
        <span className="h-[6px] w-[6px] rounded-full bg-success" />
        终端 {connectedSessions}
      </span>
      <Divider />
      <span>任务 {runningTasks}</span>
      <Divider />
      <span className="flex items-center gap-1">
        <Arrow direction="down" />
        {transferDown}
      </span>
      <span className="flex items-center gap-1">
        <Arrow direction="up" />
        {transferUp}
      </span>

      <div className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <span className={cn("h-[6px] w-[6px] rounded-full", aiReady ? "bg-ai" : "bg-fg-subtle")} />
          智能助手 {aiReady ? "就绪" : "离线"}
        </span>
        <span>v{APP_VERSION}</span>
      </div>
    </footer>
  );
}

function Divider() {
  return <span className="mx-1.5 h-3 w-px bg-line" />;
}

function Arrow({ direction }: { direction: "down" | "up" }) {
  return <span aria-hidden>{direction === "down" ? "↓" : "↑"}</span>;
}
