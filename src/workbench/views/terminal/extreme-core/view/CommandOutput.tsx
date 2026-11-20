import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useChatScroll } from "../use-chat-scroll";
import type { TaskCardModel } from "../task-view";

export function CommandOutput({ task }: { task?: TaskCardModel }) {
  const { t } = useTranslation();
  const { ref, follow } = useChatScroll(true);
  const steps = task?.steps;
  useEffect(() => follow(), [steps, follow]);

  return (
    <div ref={ref} tabIndex={0} className="min-h-0 flex-1 overflow-auto [overflow-anchor:none]">
      {steps?.length ? (
        <pre className="whitespace-pre-wrap px-2 py-1 font-mono text-10 text-fg-muted">
          {steps.map((step) => `$ ${step.command ?? step.title}\n${step.stdout ?? ""}${step.stderr ?? ""}`).join("\n")}
        </pre>
      ) : (
        <p className="px-3 py-2 text-11 text-fg-subtle">{t("还没有命令输出")}</p>
      )}
    </div>
  );
}
