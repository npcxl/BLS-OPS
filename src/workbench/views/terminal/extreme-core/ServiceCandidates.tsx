import { useTranslation } from "react-i18next";
import { Container, X } from "@/components/icons";
import type { ServiceCandidate } from "./update-plan";

export interface ServiceCandidatesProps {
  candidates: ServiceCandidate[];
  /** 选中一个服务 → 生成更新计划（不会直接执行）。 */
  onPick: (service: ServiceCandidate) => void;
  onDismiss: () => void;
}

/**
 * 服务候选条：只读探测的结果。
 *
 * 点一个服务只是**生成计划**，不点就不会动服务器；探测本身也是只读的。
 */
export function ServiceCandidates({ candidates, onPick, onDismiss }: ServiceCandidatesProps) {
  const { t } = useTranslation();

  return (
    <div className="shrink-0 border-b border-line px-4 py-2">
      <div className="extreme-core-column mx-auto w-full">
        <div className="mb-1 flex items-center gap-2 text-11 text-fg-muted">
          <Container size={12} className="shrink-0" />
          <span>{t("选择要更新的服务（{{n}} 个候选）", { n: candidates.length })}</span>
          <button
            type="button"
            aria-label={t("取消选择")}
            className="ml-auto text-fg-subtle hover:text-fg"
            onClick={onDismiss}
          >
            <X size={12} />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {candidates.map((service) => (
            <button
              key={service.name}
              type="button"
              onClick={() => onPick(service)}
              title={`${service.image} · ${service.ports || t("无端口映射")}`}
              className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-11 text-fg-muted hover:border-accent hover:text-fg"
            >
              {service.name}
              <span className="ml-1 text-fg-subtle">{service.image}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
