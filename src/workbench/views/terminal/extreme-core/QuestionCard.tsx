/**
 * AI 提问的选择卡：单选 / 多选 / 自定义。
 *
 * 选择草稿直接写在消息 part 上（`draftSelected` / `draftCustom`），
 * 所以切换会话再回来、甚至重开应用后，还没提交的选择仍在。
 */
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { opsApi } from "@/api/ops-api";
import { useExtremeStore } from "@/stores/extreme-store";
import { useExtremeSettingsStore } from "@/stores/extreme-settings-store";
import {
  partsOf,
  updateQuestionPart,
  type MessageQuestionPart,
} from "./message-parts";
import { cn } from "@/lib/cn";

export function QuestionCard({
  part,
  messageId,
}: {
  part: MessageQuestionPart;
  messageId: string;
}) {
  const { t } = useTranslation();
  const customRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const question = part.question;
  const interactive = part.status === "pending" || part.status === "failed";
  const customTrim = part.draftCustom.trim();
  const customSelected = question.allowCustom && part.draftCustomActive;

  useEffect(() => {
    if (customSelected && interactive) customRef.current?.focus();
  }, [customSelected, interactive]);

  const patch = (
    update: Parameters<typeof updateQuestionPart>[2],
  ) => {
    const state = useExtremeStore.getState();
    // 提交期间用户可能切走：按问题归属找到原对话，不要只改当前前台消息。
    const owner = question.workspaceId ?? state.workspaceId;
    const messages =
      owner === state.workspaceId
        ? state.messages
        : (state.workspaces.find((workspace) => workspace.id === owner)?.messages ?? []);
    const message = messages.find((item) => item.id === messageId);
    if (!message) return;
    const parts = updateQuestionPart(partsOf(message), question.questionId, update);
    if (owner) state.patchMessageIn(owner, messageId, { parts });
    else state.patchMessage(messageId, { parts });
  };

  const chooseOption = (id: string) => {
    if (!interactive) return;
    if (question.kind === "single") {
      patch({
        draftSelected: [id],
        draftCustomActive: false,
      });
      return;
    }
    const selected = part.draftSelected.includes(id)
      ? part.draftSelected.filter((value) => value !== id)
      : [...part.draftSelected, id];
    patch({ draftSelected: selected });
  };

  const chooseCustom = () => {
    if (!interactive) return;
    if (question.kind === "single") {
      patch({ draftSelected: [], draftCustomActive: true });
      return;
    }
    patch({ draftCustomActive: !part.draftCustomActive });
  };

  const customValid = !customSelected || customTrim.length > 0;
  const hasAnswer =
    question.kind === "single"
      ? customSelected
        ? customTrim.length > 0
        : part.draftSelected.length === 1
      : part.draftSelected.length > 0 ||
        (customSelected && customTrim.length > 0);
  const canSubmit =
    interactive && part.status !== "submitting" && hasAnswer && customValid;

  const submit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    const selected = [...part.draftSelected];
    const custom = customSelected && customTrim ? customTrim : null;
    patch({ status: "submitting", error: null });
    try {
      const ok = await opsApi.aiAgentAnswer(
        question.taskId,
        question.questionId,
        selected,
        custom,
      );
      if (!ok) throw new Error(t("这个问题已经回答或已过期"));
      patch({
        status: "answered",
        answer: { selected, custom },
        error: null,
      });
      // 仅把明确询问个人习惯/回复偏好的预设选项记为全局偏好；服务或任务选择不跨对话。
      if (useExtremeSettingsStore.getState().memoryEnabled && !custom && selected.length > 0 &&
          /回复语言|回复风格|个人偏好|个人习惯|表达风格|response language|personal preference|response style/i.test(question.question)) {
        const labels = selected.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
        if (labels.length) void opsApi.extremeMemorySave({
          id: `choice:${question.taskId}:${question.questionId}`.slice(0, 128),
          scope: "global", serverId: null, workspaceId: null,
          content: `${question.question} → ${labels.join("、")}`, source: "user-choice", updatedAt: Date.now(),
        }).then(() => {
          const state = useExtremeStore.getState();
          if (state.workspaceId === question.workspaceId) state.setNotice(t("已将这次个人偏好保存为全局记忆。"));
        }).catch(() => {
          const state = useExtremeStore.getState();
          if (state.workspaceId === question.workspaceId) state.setNotice(t("这次选择已提交，但未能保存到长期记忆。"));
        });
      }
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      patch({ status: "failed", error: reason });
    } finally {
      submittingRef.current = false;
    }
  };

  if (part.status === "answered") {
    const selected = part.answer?.selected ?? [];
    const custom = part.answer?.custom?.trim() ?? "";
    return (
      <div
        className="extreme-core-question extreme-core-question-answered"
        data-testid="agent-question"
        data-question-id={question.questionId}
        data-state="answered"
      >
        <div className="flex items-center gap-1.5 text-12 text-accent">
          <Check size={14} />
          {t("已回答")}
        </div>
        <p className="mt-2 break-words text-14 leading-6 text-fg-muted">{question.question}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {selected.map((id) => {
            const option = question.options.find((item) => item.id === id);
            return (
              <span
                key={id}
                className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-12 text-accent"
              >
                {option?.label ?? id}
              </span>
            );
          })}
          {custom && (
            <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-12 text-accent">
              {t("自定义：{{text}}", { text: custom })}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (part.status === "expired") {
    return (
      <div
        className="extreme-core-question"
        data-testid="agent-question"
        data-question-id={question.questionId}
        data-state="expired"
      >
        <p className="break-words text-14 leading-6 text-fg-muted">{question.question}</p>
        <p className="mt-1 text-12 text-fg-subtle">{t("这个问题已失效，任务不再等待回答。")}</p>
      </div>
    );
  }

  const busy = part.status === "submitting";
  return (
    <div
      className="extreme-core-question"
      data-testid="agent-question"
      data-question-id={question.questionId}
      data-state={busy ? "submitting" : part.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-12 text-fg-muted">
        <span className="rounded-md bg-accent/10 px-2 py-0.5 text-12 font-medium text-accent">
          {question.kind === "single" ? t("单选") : t("多选")}
        </span>
        {busy ? t("提交中…") : t("需要你决定")}
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-15 font-medium leading-6 text-fg">
        {question.question}
      </p>

      <div className="mt-3 flex flex-col gap-2">
        {question.options.map((option) => {
          const selected =
            question.kind === "single"
              ? !part.draftCustomActive && part.draftSelected.includes(option.id)
              : part.draftSelected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              role={question.kind === "single" ? "radio" : "checkbox"}
              aria-checked={selected}
              data-testid={`question-option-${option.id}`}
              disabled={!interactive || busy}
              onClick={() => chooseOption(option.id)}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-14 leading-5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
                selected
                  ? "border-accent/50 bg-accent/10 text-fg"
                  : "border-line/60 text-fg-muted hover:bg-surface-hover",
                (!interactive || busy) && "cursor-default opacity-70",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid size-4 shrink-0 place-items-center border",
                  question.kind === "single" ? "rounded-full" : "rounded-[3px]",
                  selected ? "border-accent bg-accent text-surface-1" : "border-line-strong",
                )}
              >
                {selected && <Check size={9} strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
            </button>
          );
        })}

        {question.allowCustom && (
          <div className="rounded-xl border border-line/60 px-3 py-2.5">
            <button
              type="button"
              role={question.kind === "single" ? "radio" : "checkbox"}
              aria-checked={customSelected}
              data-testid="question-custom-toggle"
              disabled={!interactive || busy}
              onClick={chooseCustom}
              className="flex min-h-6 w-full items-center gap-3 text-left text-14 leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span
                className={cn(
                  "grid size-4 shrink-0 place-items-center border",
                  question.kind === "single" ? "rounded-full" : "rounded-[3px]",
                  customSelected
                    ? "border-accent bg-accent text-surface-1"
                    : "border-line-strong",
                )}
              >
                {customSelected && <Check size={9} strokeWidth={3} />}
              </span>
              <span className="text-fg-muted">{t("自定义回答")}</span>
            </button>
            {customSelected && (
              <input
                ref={customRef}
                data-testid="question-custom"
                className="mt-2 w-full rounded-lg border border-line bg-surface-1 px-3 py-2 text-14 text-fg outline-none focus:border-accent/60"
                value={part.draftCustom}
                disabled={!interactive || busy}
                placeholder={t("请输入具体内容（不能为空）")}
                onChange={(event) => patch({ draftCustom: event.target.value })}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && canSubmit) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            )}
          </div>
        )}
      </div>

      {part.error && (
        <p className="mt-2 break-words text-12 text-danger" data-testid="question-error">
          {part.error}
        </p>
      )}
      {customSelected && customTrim.length === 0 && (
        <p className="mt-2 text-12 text-warning">{t("自定义内容不能为空")}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        <span className="mr-auto text-12 text-fg-muted">
          {t("回答后 AI 会继续当前任务")}
        </span>
        <Button
          size="sm"
          data-testid="question-submit"
          disabled={!canSubmit || busy}
          onClick={() => void submit()}
        >
          {busy ? t("提交中…") : part.status === "failed" ? t("重试") : t("完成")}
        </Button>
      </div>
    </div>
  );
}
