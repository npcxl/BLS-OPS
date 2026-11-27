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
    <div className="shrink-0 px-4 pb-1 pt-2 min-[1180px]:px-8">
      <div className="extreme-core-column mx-auto w-full rounded-2xl border border-line/65 bg-surface-1/90 px-3.5 py-2.5 shadow-[0_4px_16px_-8px_rgb(0_0_0/0.12)] backdrop-blur-sm">
        <div className="mb-2 flex items-center gap-2 text-11 font-medium text-fg-muted">
          <span className="grid size-5 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
            <Container size={12} />
          </span>
          <span>{t("选择要更新的服务（{{n}} 个候选）", { n: candidates.length })}</span>
          <button
            type="button"
            aria-label={t("取消选择")}
            className="ml-auto rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg"
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
              className="group inline-flex items-center gap-1.5 rounded-full border border-line/75 bg-surface-2/80 px-3 py-1 text-11 font-medium text-fg transition-all duration-150 hover:border-accent/60 hover:bg-accent/[0.07] active:scale-[0.98]"
            >
              <span>{service.name}</span>
              <span className="rounded bg-surface-1/80 px-1.5 py-0.5 font-mono text-10 font-normal text-fg-subtle group-hover:text-fg-muted">
                {service.image}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
