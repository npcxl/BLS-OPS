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
    <div className="rounded-[10px] border border-line bg-surface-1 p-4">
      <div className="flex items-center gap-2 text-12 font-medium">
        <Loader2 size={14} className="animate-spin text-accent" />
        正在扫描服务器
      </div>
      <div className="mt-2 flex justify-between text-11 text-fg-muted">
        <span>当前阶段：{scan.progress.phase}</span>
        <span>{scan.progress.progress}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full bg-accent transition-[width]"
          style={{ width: `${scan.progress.progress}%` }}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-10 text-fg-subtle">
        <span>
          已检查 {scan.progress.checked_directories} 个目录 · 已发现{" "}
          {scan.progress.discovered_candidates} 个候选 · 警告{" "}
          {scan.progress.warnings} 个
        </span>
        <Button variant="ghost" size="xs" onClick={onCancel}>
          <Pause size={11} />
          取消扫描
        </Button>
      </div>
      {scan.progress.current_path && (
        <div
          className="mt-2 truncate font-mono text-10 text-fg-subtle"
          title={scan.progress.current_path}
        >
          {scan.progress.current_path}
        </div>
      )}
    </div>
  );
}
