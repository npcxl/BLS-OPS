import { useMemo } from "react";
import { FolderSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ModuleEmpty } from "@/workbench/views/module-frame";
import type { GatewayRoute, ReviewState } from "@/api/ops-api";
import type { DisplayCandidate } from "@/workbench/views/project/merge-applications";
import { CandidateCard } from "../CandidateCard";

/** 主 tab：业务项目 + 待确认项目，按评分降序。已忽略的目录不出现。 */
export function TabApplications({
  candidates,
  serverId,
  reviews,
  onOpenPath,
  onClosePath,
  onReview,
  gatewayRoutes,
  mergedChildren,
  mergeTargets,
  onMerge,
}: {
  candidates: DisplayCandidate[];
  serverId: string;
  reviews: Record<string, ReviewState>;
  onOpenPath: (path: string) => void;
  onClosePath: () => void;
  onReview: (path: string, state: ReviewState) => void;
  /** Nginx 网关路由：按 linked_project_id 过滤后作为项目"访问入口"展示。 */
  gatewayRoutes: GatewayRoute[];
  /** 已人工并入的子目录，按父路径分组。 */
  mergedChildren: Map<string, string[]>;
  /** 「并入其他项目」的目标列表（路径 + 名称）。 */
  mergeTargets: { path: string; name: string }[];
  /** 合并/拆分回调：parentPath 为 null 表示拆分。 */
  onMerge: (childPath: string, parentPath: string | null) => void;
}) {
  const { t } = useTranslation();
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
        title={t("No projects found")}
        hint={t(
          "No recognizable project directories on the server, or all were ignored. Run a scan again, or check low-confidence directories under Needs review.",
        )}
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
          onClosePath={onClosePath}
          onReview={onReview}
          scanInfo={{
            scanState: candidate.scanState,
            kindChanged: candidate.kindChanged,
            confirmedMissing: candidate.confirmedMissing,
          }}
          gatewayRoutes={gatewayRoutes}
          mergedChildren={mergedChildren.get(candidate.path) ?? []}
          mergeTargets={mergeTargets}
          onMerge={onMerge}
        />
      ))}
    </div>
  );
}
