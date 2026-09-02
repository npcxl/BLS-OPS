import { useState } from "react";
import { Check, ChevronDown, FolderSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { ProjectCandidate } from "@/api/ops-api";
import { Detail } from "./Detail";

export function CandidateCard({ candidate }: { candidate: ProjectCandidate }) {
  const [expanded, setExpanded] = useState(false);
  const running = candidate.runtime_links.length > 0;
  const confidence =
    candidate.confidence === "high"
      ? "高置信度"
      : candidate.confidence === "likely"
        ? "待确认"
        : "可能项目";
  return (
    <article className="rounded-[10px] border border-line bg-surface-1">
      <button
        type="button"
        className="flex w-full items-start gap-3 p-3 text-left hover:bg-surface-hover"
        onClick={() => setExpanded((value) => !value)}
      >
        <FolderSearch size={16} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <strong className="truncate text-13 text-fg">
              {candidate.name}
            </strong>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-10",
                candidate.confidence === "high"
                  ? "bg-success/12 text-success"
                  : "bg-warning/12 text-warning",
              )}
            >
              {confidence} · {candidate.score} 分
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-10",
                candidate.category === "deployed"
                  ? "bg-accent/12 text-accent"
                  : "bg-surface-2 text-fg-subtle",
              )}
            >
              {candidate.category === "deployed" ? "已部署" : "仅源码"}
            </span>
            {running && <span className="text-10 text-success">正在运行</span>}
          </div>
          <div className="mt-1 truncate font-mono text-11 text-fg-muted">
            {candidate.path}
          </div>
          <div className="mt-1 text-10 text-fg-subtle">
            {candidate.project_type} · {candidate.modules.length} 个模块 ·{" "}
            {candidate.detected_ports.length} 个端口 · 准备度{" "}
            {candidate.readiness.score}
          </div>
        </div>
        <ChevronDown
          size={14}
          className={cn(
            "mt-1 text-fg-subtle transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-line px-3 pb-3 pt-2 text-11">
          <Detail
            title="判定依据"
            items={candidate.evidence.map(
              (item) => `+${item.weight} ${item.summary}（${item.source}）`,
            )}
          />
          <Detail
            title="扣分与风险"
            items={candidate.penalties.map(
              (item) => `-${item.weight} ${item.summary}`,
            )}
          />
          <Detail
            title="运行关联"
            items={candidate.runtime_links.map(
              (item) =>
                `${item.kind}：${item.name}${item.ports.length ? ` · 端口 ${item.ports.join(", ")}` : ""}`,
            )}
          />
          <Detail
            title="环境变量名称"
            items={candidate.required_environment_names}
          />
          <Detail
            title="部署准备"
            items={[
              ...candidate.readiness.blockers.map((item) => `阻塞：${item}`),
              ...candidate.readiness.warnings.map((item) => `警告：${item}`),
              ...candidate.readiness.confirmed_facts,
            ]}
          />
          <div className="mt-3 flex gap-1">
            <Button variant="secondary" size="xs">
              <Check size={11} />
              确认项目
            </Button>
            <Button variant="ghost" size="xs">
              忽略目录
            </Button>
            <Button variant="ghost" size="xs">
              合并 / 拆分
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
