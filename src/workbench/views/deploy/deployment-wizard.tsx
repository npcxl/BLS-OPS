/**
 * P5.6 **部署向导** —— 部署中心的默认入口。
 *
 * # 它是什么
 *
 * 一条连续流程，把「导入项目 → 选服务器 → 描述需求 → 分析 → 追问 → 看方案 →
 * 确认并部署」串成一页，而不是让用户自己在 Applications / Services / Artifacts /
 * Proposal / Runs 之间来回跳。
 *
 * # 步骤从后端状态派生（重要）
 *
 * 当前步骤**不是**组件内部的 `useState`，而是由 `session.status` 映射而来：
 * 刷新页面、切到别的标签再回来，流程都停在原处。已完成的阶段也由后端
 * `plan_id` / `run_id` 反映，不靠前端猜测。
 *
 * # 诚实边界
 *
 * 本组件只调用**已经落地**的后端命令：
 * `deploymentSessionCreate / Ask / Answer / Get / List / ConfirmAndStart`。
 * 「项目分析」「AI 草案生成」两步的后端 IPC 尚未接线，因此界面上如实标注
 * 「接线中」而不是伪造进度或结果。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleDashed, LoaderCircle, TriangleAlert } from "@/components/icons";

import { opsApi } from "@/api/ops-api";
import type { DeploymentSession, SessionStatus } from "@/api/types/deployment";
import { ErrorState } from "@/components/ui/error-state";
import { useActionError } from "@/hooks/use-action-error";
import { cn } from "@/lib/cn";

// -- 步骤 ------------------------------------------------------------------

export type WizardStepId =
  | "source"
  | "target"
  | "describe"
  | "analyzing"
  | "questions"
  | "plan"
  | "execute";

const STEP_ORDER: WizardStepId[] = [
  "source",
  "target",
  "describe",
  "analyzing",
  "questions",
  "plan",
  "execute",
];

const STEP_LABEL_KEYS: Record<WizardStepId, string> = {
  source: "Project source",
  target: "Target",
  describe: "Describe",
  analyzing: "Analyzing",
  questions: "Questions",
  plan: "Plan",
  execute: "Execute",
};

/** 后端状态 → 当前步骤。**唯一映射点**，避免各处各写一套。 */
export function stepForStatus(
  status: SessionStatus | null,
  hasPlan: boolean,
  hasRun: boolean,
): WizardStepId {
  if (hasRun) return "execute";
  if (hasPlan) return "plan";
  switch (status) {
    case null:
    case "created":
      return "source";
    case "importing":
      return "analyzing";
    case "analyzing":
      return "analyzing";
    case "needs_input":
      return "questions";
    case "draft_ready":
    case "confirming":
      return "plan";
    case "preflight":
    case "deploying":
      return "execute";
    case "succeeded":
    case "failed":
    case "rolled_back":
    case "cancelled":
      return "execute";
    default:
      return "describe";
  }
}

// -- 小组件（自包含，避免依赖不确定的内部组件） ---------------------------

const fieldClass =
  "w-full rounded-[7px] border border-line bg-surface-1 px-2 py-1.5 text-12 text-fg outline-none focus:border-fg-subtle";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-11 text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-10 text-fg-subtle">{hint}</span> : null}
    </label>
  );
}

function Stepper({
  current,
  reached,
}: {
  current: WizardStepId;
  reached: WizardStepId;
}) {
  const { t } = useTranslation();
  const currentIndex = STEP_ORDER.indexOf(current);
  const reachedIndex = STEP_ORDER.indexOf(reached);
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {STEP_ORDER.map((id, index) => {
        const state =
          index < reachedIndex ? "done" : index === currentIndex ? "current" : "todo";
        const Icon =
          state === "done" ? CircleCheck : state === "current" ? LoaderCircle : CircleDashed;
        return (
          <li key={id} className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-10",
                state === "current" && "border-line bg-surface-2 text-fg",
                state === "done" && "border-line text-fg-muted",
                state === "todo" && "border-line text-fg-subtle",
              )}
              data-testid={`wizard-step-${id}`}
              data-state={state}
            >
              <Icon size={10} />
              {t(STEP_LABEL_KEYS[id])}
            </span>
            {index < STEP_ORDER.length - 1 ? (
              <span className="h-px w-3 bg-line" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 rounded-[7px] border px-2 py-1.5 text-11 leading-relaxed",
        tone === "warn"
          ? "border-line bg-surface-2 text-fg-muted"
          : "border-line text-fg-subtle",
      )}
    >
      <TriangleAlert size={12} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// __APPEND__
export interface DeploymentWizardProps {
  servers: ReadonlyArray<{ id: string; name: string }>;
  applicationId?: string | null;
  environmentId?: string | null;
}

/** 项目来源（本期只登记，真正的克隆 / 导入由后端命令执行）。 */
type SourceKind = "git" | "folder" | "archive";

const SOURCE_OPTIONS: ReadonlyArray<{ id: SourceKind; labelKey: string }> = [
  { id: "git", labelKey: "Git repository" },
  { id: "folder", labelKey: "Local folder" },
  { id: "archive", labelKey: "Archive" },
];

export function isFinished(status: SessionStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "rolled_back" ||
    status === "cancelled"
  );
}

export function DeploymentWizard({
  servers,
  applicationId = null,
  environmentId = null,
}: DeploymentWizardProps) {
  const { t } = useTranslation();
  const [session, setSession] = useState<DeploymentSession | null>(null);
  const [serverId, setServerId] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("git");
  const [sourceValue, setSourceValue] = useState("");
  const [description, setDescription] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  // 原始异常 + 可重试：向导的每一步都能原地再点一次，不用从头再来。
  const { error, fail, clear, retry } = useActionError();
  const [notice, setNotice] = useState<string | null>(null);

  // 挂载时接上"未完成的那条会话"：刷新页面 / 切标签回来都不会丢进度。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await opsApi.deploymentSessionList(1);
        const first = list[0];
        if (!cancelled && first && !isFinished(first.status)) {
          setSession(first);
          setDescription(first.user_description);
          if (first.server_id) setServerId(first.server_id);
        }
      } catch (cause) {
        if (!cancelled) fail(cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 会话创建**之前**用本地阶段推进（来源 → 目标 → 描述）；
  // 一旦会话存在，步骤一律由后端状态派生 —— 刷新页面也不会跳步。
  const [localStep, setLocalStep] = useState<WizardStepId>("source");
  const step = useMemo(
    () =>
      session
        ? // 会话刚建好（还没开始分析）时停在"描述"这一步，
          // 别因为状态是 `created` 就把用户弹回"来源"。
          session.status === "created"
          ? "describe"
          : stepForStatus(session.status, Boolean(session.plan_id), Boolean(session.run_id))
        : localStep,
    [session, localStep],
  );

  const guard = useCallback(
    // 具名函数表达式：重试要能引用自己，又不触发"自我推断"的类型错误。
    async function runGuarded(run: () => Promise<void>): Promise<void> {
      setBusy(true);
      clear();
      try {
        await run();
      } catch (cause) {
        fail(cause, () => void runGuarded(run));
      } finally {
        setBusy(false);
      }
    },
    [clear, fail],
  );

  const startSession = () =>
    guard(async () => {
      const created = await opsApi.deploymentSessionCreate({
        applicationId,
        environmentId,
        serverId: serverId || null,
        userDescription: description,
      });
      setSession(created);
      // 分析在后端跑（组装提示词 → 七道校验 → 确定性计划图），**不部署**。
      const analyzed = await opsApi.deploymentSessionAnalyze(created.id);
      setSession(analyzed);
    });

  const submitAnswer = () =>
    guard(async () => {
      if (!session?.current_question) return;
      const next = await opsApi.deploymentSessionAnswer(
        session.id,
        session.current_question.id,
        answer,
      );
      setSession(next);
      setAnswer("");
    });

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 ops-scroll">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-13 font-semibold text-fg">{t("Deployment wizard")}</h2>
          <p className="mt-0.5 text-11 text-fg-muted">
            {t(
              "Import a project, describe what you need, and confirm before anything is deployed.",
            )}
          </p>
        </div>
        <Stepper current={step} reached={step} />
      </header>

      {error ? <ErrorState error={error} compact onRetry={retry} /> : null}
      {notice ? <Notice tone="info">{notice}</Notice> : null}

      {step === "source" ? (
        <div className="grid gap-3">
          <Field label={t("Project source")}>
            <div className="flex gap-1.5">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-testid={`wizard-source-${option.id}`}
                  onClick={() => setSourceKind(option.id)}
                  className={cn(
                    "rounded-[7px] border px-2 py-1 text-11",
                    sourceKind === option.id
                      ? "border-fg-subtle bg-surface-2 text-fg"
                      : "border-line text-fg-muted",
                  )}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </Field>
          <Field
            label={t("Repository or path")}
            hint={t("For Git repositories the URL must not contain any username or token.")}
          >
            <input
              className={fieldClass}
              data-testid="wizard-source-value"
              value={sourceValue}
              placeholder={
                sourceKind === "git" ? "https://github.com/acme/shop.git" : "/srv/projects/shop"
              }
              onChange={(event) => setSourceValue(event.target.value)}
            />
          </Field>
          <button
            type="button"
            data-testid="wizard-next"
            className="justify-self-start rounded-[7px] border border-line px-3 py-1 text-12 text-fg"
            onClick={() => setLocalStep("target")}
          >
            {t("Next step")}
          </button>
        </div>
      ) : null}

      {step === "target" ? (
        <div className="grid gap-3">
          <Field
            label={t("Server")}
            hint={t("The server is probed read-only; nothing is changed here.")}
          >
            <select
              className={cn(fieldClass, "ops-select !pr-7")}
              data-testid="wizard-server"
              value={serverId}
              onChange={(event) => setServerId(event.target.value)}
            >
              <option value="">{t("Select a server first")}</option>
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            data-testid="wizard-next"
            className="justify-self-start rounded-[7px] border border-line px-3 py-1 text-12 text-fg"
            onClick={() => setLocalStep("describe")}
          >
            {t("Next step")}
          </button>
        </div>
      ) : null}

      {step === "describe" ? (
        <Field
          label={t("What do you want to deploy?")}
          hint={t("For example: a front-end and back-end split project, 100 QPS at peak, Docker + Nginx + HTTPS.")}
        >
          <textarea
            className={cn(fieldClass, "min-h-24")}
            data-testid="wizard-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      ) : null}

      {session && step !== "describe" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted"
            data-testid="wizard-reset"
            onClick={() => {
              setSession(null);
              setLocalStep("source");
              setNotice(null);
              setDescription("");
            }}
          >
            {t("Start over")}
          </button>
          <span className="text-10 text-fg-subtle">
            {t("Session")}: {session.id.slice(0, 8)} · {session.status}
          </span>
        </div>
      ) : null}

      {step === "describe" ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy || description.trim().length === 0}
            data-testid="wizard-start"
            className="rounded-[7px] border border-line bg-surface-2 px-3 py-1.5 text-12 text-fg disabled:opacity-50"
            onClick={startSession}
          >
            {busy ? t("Working") : t("Start analysis")}
          </button>
          <span className="text-10 text-fg-subtle">
            {t("Creating a session never touches the server.")}
          </span>
        </div>
      ) : null}

      {step === "analyzing" ? (
        <div className="grid gap-2">
          <Notice tone="info">
            {t("Analyzing the project and drafting a plan; nothing is deployed in this step.")}
          </Notice>
          <p className="text-11 text-fg-muted">
            {t("Current stage")}: {session?.status ?? "created"}
          </p>
        </div>
      ) : null}

      {step === "questions" && session?.current_question ? (
        <div className="grid gap-2">
          <p className="text-12 text-fg" data-testid="wizard-question">
            {session.current_question.question}
          </p>
          {session.current_question.options.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {session.current_question.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted"
                  onClick={() => setAnswer(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <input
              className={fieldClass}
              data-testid="wizard-answer"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || answer.trim().length === 0}
              data-testid="wizard-answer-submit"
              className="rounded-[7px] border border-line bg-surface-2 px-3 py-1.5 text-12 text-fg disabled:opacity-50"
              onClick={submitAnswer}
            >
              {t("Answer")}
            </button>
          </div>
        </div>
      ) : null}

      {step === "plan" ? (
        <div className="grid gap-2">
          <Notice tone="info">
            {t("Review the plan in the Plan tab; nothing has been deployed yet.")}
          </Notice>
          <p className="text-11 text-fg-muted">
            {t("Plan")}: {session?.plan_id ?? t("not compiled yet")}
          </p>
          <p className="text-10 text-fg-subtle">
            {t(
              "High-risk steps still need your explicit approval; the AI can never approve for you.",
            )}
          </p>
        </div>
      ) : null}

      {step === "execute" ? (
        <div className="grid gap-2">
          <p className="text-11 text-fg-muted">
            {t("Run")}: {session?.run_id ?? t("not started")}
          </p>
          <p className="text-10 text-fg-subtle">
            {t("Live steps, logs and health checks live in the Runs tab.")}
          </p>
        </div>
      ) : null}
    </section>
  );
}