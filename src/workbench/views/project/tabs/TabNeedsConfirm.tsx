import { useMemo } from "react";
import { CircleHelp } from "lucide-react";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { ProjectCandidate, ReviewState } from "@/api/ops-api";
import { CandidateCard } from "../CandidateCard";

/**
 * 待确认 tab：用户还没拍板（review 既不是 confirmed 也不是 ignored）的目录。
 * 低置信度的"可能项目"也在这里，让用户一次性过一遍，而不是被自动丢弃。
 */
export function TabNeedsConfirm({
  candidates,
  serverId,
  reviews,
  onOpenPath,
  onClosePath,
  onReview,
}: {
  candidates: ProjectCandidate[];
  serverId: string;
  reviews: Record<string, ReviewState>;
  onOpenPath: (path: string) => void;
  onClosePath: () => void;
  onReview: (path: string, state: ReviewState) => void;
}) {
  const list = useMemo(
    () =>
      candidates
        .filter((c) => {
          const r = reviews[c.path] ?? c.review;
          return r !== "confirmed" && r !== "ignored";
        })
        .sort((a, b) => b.score - a.score),
    [candidates, reviews],
  );

  if (list.length === 0) {
    return (
      <ModuleEmpty
        icon={CircleHelp}
        title="没有待确认的目录"
        hint="所有候选都已被确认或忽略。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-11 text-fg-subtle">
        以下目录可能是项目，但系统无法 100% 确定。请逐个确认或忽略，结论会保存并在下次扫描沿用。
      </p>
      {list.map((candidate) => (
        <CandidateCard
          key={candidate.id}
          candidate={candidate}
          serverId={serverId}
          review={(reviews[candidate.path] ?? candidate.review) ?? "pending"}
          onOpenPath={onOpenPath}
          onClosePath={onClosePath}
          onReview={onReview}
        />
      ))}
    </div>
  );
}
