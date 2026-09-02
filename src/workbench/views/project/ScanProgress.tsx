import { Loader2, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProjectScanStatus } from "@/api/ops-api";

export function ScanProgress({
  scan,
  onCancel,
}: {
  scan: ProjectScanStatus;
  onCancel: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-[12px] border border-line bg-surface-1 shadow-[0_1px_2px_rgb(15_23_42/0.04)]">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Loader2 size={14} className="animate-spin text-accent" />
          <div className="min-w-0">
            <div className="text-12 font-medium text-fg">正在扫描服务器项目</div>
            <div className="truncate text-10 text-fg-subtle">{scan.progress.phase}</div>
          </div>
        </div>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <Pause size={11} />
          取消
        </Button>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div className="flex items-center justify-between text-11 text-fg-muted">
          <span>进度</span>
          <span>{scan.progress.progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${scan.progress.progress}%` }}
          />
        </div>

        <div className="grid gap-2 text-11 text-fg-subtle sm:grid-cols-3">
          <StatChip label="已检查目录" value={scan.progress.checked_directories} />
          <StatChip label="候选项目" value={scan.progress.discovered_candidates} />
          <StatChip label="警告" value={scan.progress.warnings} />
        </div>

        {scan.progress.current_path && (
          <div className="rounded-[8px] border border-line bg-surface-2 px-3 py-2 font-mono text-10 text-fg-muted" title={scan.progress.current_path}>
            {scan.progress.current_path}
          </div>
        )}
      </div>
    </section>
  );
}

function StatChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[8px] border border-line bg-surface-2 px-3 py-2">
      <div className="text-10 text-fg-subtle">{label}</div>
      <div className="mt-0.5 text-12 font-medium text-fg">{value}</div>
    </div>
  );
}
