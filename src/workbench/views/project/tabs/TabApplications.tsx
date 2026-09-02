import { useMemo } from "react";
import { FolderSearch } from "lucide-react";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { ProjectCandidate, ReviewState } from "@/api/ops-api";
import { CandidateCard } from "../CandidateCard";

/** 主 tab：业务项目 + 待确认项目，按评分降序。已忽略的目录不出现。 */
export function TabApplications({
  candidates,
  serverId,
  reviews,
  onOpenPath,
  onReview,
}: {
  candidates: ProjectCandidate[];
  serverId: string;
  reviews: Record<string, ReviewState>;
  onOpenPath: (path: string) => void;
  onReview: (path: string, state: ReviewState) => void;
}) {
  const list = useMemo(
    () =>
      candidates
        .filter((c) => (reviews[c.path] ?? c.review) !== "ignored")
        .sort((a, b) => b.score - a.score),
    [candidates, reviews],
  );

  if (list.length === 0) {
    return (
      <ModuleEmpty
        icon={FolderSearch}
        title="未发现项目"
        hint="服务器上暂无可识别的项目目录，或已全部被忽略。可以重新执行扫描，或在「待确认」里查看低置信度目录。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {list.map((candidate) => (
        <CandidateCard
          key={candidate.id}
          candidate={candidate}
          serverId={serverId}
          review={(reviews[candidate.path] ?? candidate.review) ?? "pending"}
          onOpenPath={onOpenPath}
          onReview={onReview}
        />
      ))}
    </div>
  );
}
