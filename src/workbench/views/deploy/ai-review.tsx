/**
 * P5.5 —— 方案页里的 **AI 复核** 区。
 *
 * 三条产品承诺（与需求对应）：
 *
 * 1. **没配 Provider 就直说"AI 未配置"**，确定性方案照常可用，
 *    绝不显示伪造的 AI 评价；"还没有方案"与"没有 Provider"是**两件事** ——
 *    前者显示"还没有生成方案"，后者才引导去设置。
 * 2. **复核不阻塞**：确定性方案已经展示，复核只是单独的一段进度；
 * 3. **AI 建议与确定性结论视觉上分开**，并明写"仅供人工参考，
 *    不会自动修改部署计划"。
 *
 * 事件是主路径（`aiReviewEvent`），轮询是兜底 —— 慢模型不能占着界面。
 *
 * # 状态机（P5.5.1）
 *
 * 每个状态**只有一个**主操作按钮：idle/cancelled → 运行；running/queued →
 * 取消；failed → 重试；succeeded → 再跑一次。成功事件到达后立即把最新方案
 * 拉回来（`onProposalUpdated`），因此 AI 建议不需要刷新页面就可见。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { opsApi, type AiReviewTask, type AiTaskStatus } from "@/api/ops-api";
import { aiReviewEvent } from "@/lib/events";
import { useWorkbenchStore } from "@/stores/workbench-store";

import { isAiTaskActive, type DeploymentProposal } from "@/api/types/deployment";

type Props = {
  applicationId: string;
  proposal: DeploymentProposal | null;
  /** 复核成功后把**最新方案**写回上层，避免这里持有过期 proposal。 */
  onProposalUpdated?: (proposal: DeploymentProposal) => void;
};

export function AiReviewRow({ applicationId, proposal, onProposalUpdated }: Props) {
  const { t } = useTranslation();
  const openModuleTab = useWorkbenchStore((state) => state.openModuleTab);
  const proposalId = proposal?.id ?? null;

  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const [task, setTask] = useState<AiReviewTask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    const providers = await opsApi.aiProviderList();
    setHasProvider(providers.some((provider) => provider.enabled && provider.is_default));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadProviders();
      } catch {
        // 取不到就说"没有可用提供方"，绝不假装能复核。
        setHasProvider(false);
      }
    })();
  }, [loadProviders, applicationId]);

  /**
   * 落地任务状态；**成功时立刻把最新方案拉回来**。
   *
   * 这是"AI 建议在成功事件到达后立即显示"的实现：事件 → 拉取方案 →
   * 写回上层 → 上层把新 proposal 传回本组件。
   */
  const applyTask = useCallback(
    async (next: AiReviewTask) => {
      setTask(next);
      if (next.status !== "succeeded" || !proposalId || !onProposalUpdated) return;
      try {
        const fresh = await opsApi.deploymentProposalGet(proposalId);
        if (fresh) onProposalUpdated(fresh);
      } catch {
        /* 拉取失败不影响任务状态展示，下一次事件/轮询会再试 */
      }
    },
    [proposalId, onProposalUpdated],
  );

  useEffect(() => {
    if (!proposalId) return;
    let disposed = false;
    let stop: (() => void) | null = null;

    void (async () => {
      let status: AiReviewTask | null = null;
      try {
        status = await opsApi.deploymentProposalAiReviewStatus(proposalId);
      } catch {
        status = null;
      }
      if (!disposed && status) void applyTask(status);
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unsubscribe = await listen<AiReviewTask>(aiReviewEvent(proposalId), (event) => {
          void applyTask(event.payload);
        });
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
  }, [proposalId, applyTask]);

  // 轮询兜底：只在任务还在跑时每秒问一次。
  useEffect(() => {
    if (!proposalId || !isAiTaskActive(task)) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const next = await opsApi.deploymentProposalAiReviewStatus(proposalId);
          if (next) await applyTask(next);
        } catch {
          /* 轮询失败：下个周期再试 */
        }
      })();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [proposalId, task?.status, applyTask]);

  const run = async () => {
    if (!proposalId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await opsApi.deploymentProposalAiReview(proposalId);
      await applyTask(created);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!proposalId) return;
    try {
      await opsApi.deploymentProposalAiReviewCancel(proposalId);
    } catch {
      /* 取消失败：最终状态仍以事件 / 轮询为准 */
    }
  };

  const review = proposal?.ai_review ?? null;
  const active = isAiTaskActive(task);
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
        return t("AI review idle");
    }
  }, [status, t]);

  // **还没有方案** —— 与"没配 Provider"是两件事，这里只说方案的事。
  if (!proposalId) {
    return <p className="mt-1.5 text-11 text-fg-subtle">{t("No proposal generated yet")}</p>;
  }

  // Provider 还在加载：先给加载态，别急着下"未配置"的结论。
  if (hasProvider === null) {
    return <p className="mt-1.5 text-11 text-fg-subtle">{t("Loading")}</p>;
  }

  if (!hasProvider) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-11 text-fg-subtle">
        <span className="rounded-full border border-line bg-surface-2 px-1.5 text-10">
          {t("AI not configured")}
        </span>
        {/* 可点击入口（不是纯文本）：直接跳到「设置 → AI 模型」。 */}
        <button
          type="button"
          data-testid="ai-go-to-settings"
          className="rounded-[7px] border border-line px-2 py-0.5 text-10 hover:bg-surface-hover hover:text-fg"
          onClick={() => openModuleTab("settings")}
        >
          {t("Go to settings → AI models")}
        </button>
      </div>
    );
  }

  // 每个状态**只有一个**主操作按钮：失败时不再同时出现"运行"与"重试"。
  const primary =
    status === "queued" || status === "running"
      ? { label: t("Cancel"), onClick: () => void cancel(), disabled: false }
      : status === "failed"
        ? { label: t("Retry AI review"), onClick: () => void run(), disabled: busy }
        : status === "succeeded"
          ? { label: t("Run again"), onClick: () => void run(), disabled: busy }
          : { label: t("Run AI review"), onClick: () => void run(), disabled: busy };

  return (
    <div className="mt-2 w-full space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line bg-surface-2 px-1.5 text-10 text-fg-subtle">
          {label}
        </span>
        <button
          type="button"
          data-testid="ai-primary-action"
          disabled={primary.disabled}
          onClick={primary.onClick}
          className="rounded-[7px] border border-line px-2 py-0.5 text-10 disabled:opacity-50"
        >
          {primary.label}
        </button>
        <span className="text-10 text-fg-subtle">
          {t("AI suggestions are advisory only and never modify this proposal.")}
        </span>
      </div>

      {error || task?.error ? (
        <p className="text-10 text-danger">{error ?? task?.error}</p>
      ) : null}

      {active && !review ? (
        <p className="text-10 text-fg-subtle">{t("AI review running")}…</p>
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
