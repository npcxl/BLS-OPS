/**
 * P5.5 —— 方案页里的 **AI 复核** 区。
 *
 * 三条产品承诺（与需求对应）：
 *
 * 1. **没配 Provider 就直说"AI 未配置"**，确定性方案照常可用，
 *    绝不显示伪造的 AI 评价；
 * 2. **复核不阻塞**：确定性方案已经展示，复核只是单独的一段进度；
 * 3. **AI 建议与确定性结论视觉上分开**，并明写"仅供人工参考，
 *    不会自动修改部署计划"。
 *
 * 事件是主路径（`aiReviewEvent`），轮询是兜底 —— 慢模型不能占着界面。
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { opsApi, type AiReviewTask, type AiTaskStatus } from "@/api/ops-api";
import { aiReviewEvent } from "@/lib/events";

import { isAiTaskActive, type DeploymentProposal } from "@/api/types/deployment";

type Props = {
  applicationId: string;
  proposal: DeploymentProposal | null;
};

export function AiReviewRow({ applicationId, proposal }: Props) {
  const { t } = useTranslation();
  const proposalId = proposal?.id ?? null;

  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [task, setTask] = useState<AiReviewTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = async () => {
    const providers = await opsApi.aiProviderList();
    setHasProvider(providers.some((provider) => provider.enabled && provider.is_default));
  };

  useEffect(() => {
    void loadProviders().catch(() => setHasProvider(false));
  }, [applicationId]);

  useEffect(() => {
    if (!proposalId) return;
    let disposed = false;
    let stop: (() => void) | null = null;

    void (async () => {
      const status = await opsApi.deploymentProposalAiReviewStatus(proposalId).catch(() => null);
      if (!disposed) setTask(status ?? null);
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unsubscribe = await listen<AiReviewTask>(
          aiReviewEvent(proposalId),
          (event) => setTask(event.payload),
        );
        if (disposed) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
      } catch {
        /* 事件不可用时靠轮询 */
      }
    })();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [proposalId]);

  // 轮询兜底：只在任务还在跑时每秒问一次。
  useEffect(() => {
    if (!proposalId || !isAiTaskActive(task)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await opsApi
          .deploymentProposalAiReviewStatus(proposalId)
          .catch(() => null);
        if (next) setTask(next);
      })();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [proposalId, task?.status]);

  const run = async () => {
    if (!proposalId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await opsApi.deploymentProposalAiReview(proposalId);
      setTask(created);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!proposalId) return;
    await opsApi.deploymentProposalAiReviewCancel(proposalId).catch(() => undefined);
  };

  const review = proposal?.ai_review ?? null;
  const status: AiTaskStatus = task?.status ?? (review ? "succeeded" : "idle");

  const label = useMemo(() => {
    switch (status) {
      case "queued":
        return t("AI review queued");
      case "running":
        return t("AI review running");
      case "succeeded":
        return t("AI review finished");
      case "failed":
        return t("AI review failed");
      case "cancelled":
        return t("AI review cancelled");
      default:
        return t("AI not configured");
    }
  }, [status, t]);

  if (hasProvider === false) {
    return (
      <span className="rounded-full border border-line bg-surface-2 px-1.5 text-10 text-fg-subtle">
        {t("AI not configured")} · {t("Add a model in Settings → AI models")}
      </span>
    );
  }

  return (
    <div className="mt-2 w-full space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line bg-surface-2 px-1.5 text-10 text-fg-subtle">
          {label}
        </span>
        {proposalId && !isAiTaskActive(task) ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="rounded-[7px] border border-line px-2 py-0.5 text-10 disabled:opacity-50"
          >
            {t("Run AI review")}
          </button>
        ) : null}
        {isAiTaskActive(task) ? (
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-[7px] border border-line px-2 py-0.5 text-10"
          >
            {t("Cancel")}
          </button>
        ) : null}
        {status === "failed" && proposalId ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run()}
            className="rounded-[7px] border border-line px-2 py-0.5 text-10"
          >
            {t("Retry AI review")}
          </button>
        ) : null}
        <span className="text-10 text-fg-subtle">
          {t("AI suggestions are advisory only and never modify this proposal.")}
        </span>
      </div>

      {error || task?.error ? (
        <p className="text-10 text-danger">{error ?? task?.error}</p>
      ) : null}

      {review ? (
        <div className="rounded-md border border-line bg-surface-2 p-2 text-11">
          <div className="flex flex-wrap items-center gap-2 text-10 text-fg-subtle">
            <span>
              {t("Model")}: {review.model}
            </span>
            <span>
              {t("Accepted")}: {review.accepted}
            </span>
            <span>
              {t("Rejected")}: {review.rejected.length}
            </span>
            <span>
              {t("Attempts")}: {review.attempts}
            </span>
            {task?.duration_ms != null ? (
              <span>
                {t("Duration")}: {task?.duration_ms} ms
              </span>
            ) : null}
          </div>

          {review.notes.length > 0 ? (
            <ul className="mt-1 space-y-1">
              {review.notes.map((note) => (
                <li key={note.id} className="flex gap-1.5">
                  <span className="mt-0.5 rounded border border-accent/40 px-1 text-9 text-accent">
                    {t("AI suggestion")}
                  </span>
                  <span className="text-fg">{note.text}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {review.rejected.length > 0 ? (
            <details className="mt-1">
              <summary className="cursor-pointer text-10 text-fg-subtle">
                {t("Rejected AI content")} ({review.rejected.length})
              </summary>
              <ul className="mt-1 space-y-1 text-10 text-fg-subtle">
                {review.rejected.map((rejection, index) => (
                  <li key={`${rejection.kind}-${index}`}>
                    <span className="mr-1 rounded border border-line px-1">{rejection.kind}</span>
                    {rejection.reason}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {review.knowledge_refs.length > 0 ? (
            <div className="mt-1 text-10 text-fg-subtle">
              {t("Knowledge citations")}:{" "}
              {review.knowledge_refs
                .map((reference) => `${reference.entry_id}@${reference.version}`)
                .join("，")}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
