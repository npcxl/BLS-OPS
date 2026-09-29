/**
 * P5.2 部署方案面板。
 *
 * 页面顺序 = 用户的操作顺序（需求填写 → 分析 → 推荐 → 备选 → 风险/未知 → 确认），
 * 中间不藏步骤：所有结论都在同一页上，谁都能从头读到尾。
 *
 * 三条界面纪律：
 *
 * 1. **事实 / 推断 / 建议 / 未知分开显示**（`class` 徽标直接取自后端证据），
 *    推断与建议绝不以"结论"的样子出现；
 * 2. **未就绪就没有确认按钮**：`ready = false` 时只显示必须回答的问题与阻塞项；
 * 3. **AI 未启用就写"AI 未启用"**，不用模板文案假装分析过。
 *
 * 所有 IPC 都经过 `opsApi`，组件里不出现 `invoke`。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { opsApi, toErrorMessage } from "@/api/ops-api";
import type {
  CapacityProfile,
  DeploymentProposal,
  DeploymentSecurityPolicy,
  ProposalOutcome,
  ProposalStatement,
  ProposalTopologyOption,
} from "@/api/ops-api";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { cn } from "@/lib/cn";

import {
  CONFLICT_RESOLUTION_LABELS,
  EVIDENCE_CLASS_LABELS,
  SERVICE_KIND_LABELS,
  SERVICE_ROLE_LABELS,
  TOPOLOGY_KIND_LABELS,
  UNKNOWN_SEVERITY_LABELS,
  VIOLATION_KIND_LABELS,
} from "./labels";
import { AiReviewRow } from "./ai-review";

type Props = {
  applicationId: string;
  environmentId: string;
  /** 已连接的 SSH 会话（有就用来实时探测服务器能力）。 */
  sessionId: string | null;
  onConfirmed: () => void;
};

/** 容量问卷字段定义（顺序即界面顺序）。 */
const CAPACITY_FIELDS: {
  key: keyof CapacityProfile;
  label: string;
  integer?: boolean;
}[] = [
  { key: "expected_dau", label: "Daily active users", integer: true },
  { key: "concurrent_users", label: "Concurrent users", integer: true },
  { key: "peak_qps", label: "Peak QPS" },
  { key: "avg_qps", label: "Average QPS" },
  { key: "websocket_connections", label: "WebSocket connections", integer: true },
  { key: "response_target_ms", label: "Response target (ms)", integer: true },
  { key: "monthly_bandwidth_gb", label: "Monthly bandwidth (GB)" },
  { key: "monthly_upload_gb", label: "Monthly upload (GB)" },
  { key: "monthly_data_growth_gb", label: "Monthly data growth (GB)" },
  { key: "rpo_minutes", label: "RPO (minutes)", integer: true },
  { key: "rto_minutes", label: "RTO (minutes)", integer: true },
  { key: "monthly_budget", label: "Monthly budget" },
];

const AVAILABILITY_OPTIONS = ["99", "99.9", "99.95", "99.99"];

const SEVERITY_TONES: Record<string, string> = {
  info: "border-line bg-surface-2 text-fg-muted",
  low: "border-line bg-surface-2 text-fg-muted",
  medium: "border-amber-400/40 bg-amber-400/10 text-amber-600",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-600",
  critical: "border-danger/50 bg-danger/10 text-danger",
};

export function ProposalPanel({
  applicationId,
  environmentId,
  sessionId,
  onConfirmed,
}: Props) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<CapacityProfile | null>(null);
  const [policy, setPolicy] = useState<DeploymentSecurityPolicy | null>(null);
  const [outcome, setOutcome] = useState<ProposalOutcome | null>(null);
  const [history, setHistory] = useState<DeploymentProposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (applicationId === "") {
      setProfile(null);
      setPolicy(null);
      setHistory([]);
      return;
    }
    try {
      const [nextPolicy, nextHistory] = await Promise.all([
        opsApi.deploymentPolicyGet(applicationId),
        opsApi.deploymentProposalList(applicationId, 10),
      ]);
      setPolicy(nextPolicy);
      setHistory(nextHistory);
      if (environmentId !== "") {
        setProfile(await opsApi.deploymentCapacityGet(environmentId));
      } else {
        setProfile(null);
      }
    } catch (cause) {
      setError(toErrorMessage(cause));
    }
  }, [applicationId, environmentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveCapacity = async () => {
    if (!profile) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await opsApi.deploymentCapacitySave({
        ...profile,
        environment_id: environmentId,
      });
      setProfile(saved);
      setNotice(t("Requirements saved"));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async () => {
    if (!policy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await opsApi.deploymentPolicySave(applicationId, policy);
      setPolicy(saved);
      setNotice(t("Security policy saved (hard limits restored)"));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    if (applicationId === "") return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await opsApi.deploymentProposalGenerate(
        applicationId,
        environmentId === "" ? undefined : environmentId,
        sessionId ?? undefined,
      );
      setOutcome(result);
      setHistory(await opsApi.deploymentProposalList(applicationId, 10));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!outcome) return;
    setBusy(true);
    setError(null);
    try {
      await opsApi.deploymentProposalConfirm(outcome.proposal.id);
      setNotice(t("Proposal confirmed — a draft plan was created (still not approved)"));
      setHistory(await opsApi.deploymentProposalList(applicationId, 10));
      onConfirmed();
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!outcome) return;
    setBusy(true);
    try {
      const updated = await opsApi.deploymentProposalReject(outcome.proposal.id);
      setOutcome({ ...outcome, proposal: updated });
      setHistory(await opsApi.deploymentProposalList(applicationId, 10));
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const proposal = outcome?.proposal ?? null;
  const canConfirm = Boolean(outcome?.ready) && proposal?.status === "draft";
  const openQuestions = useMemo(
    () => outcome?.open_questions ?? [],
    [outcome],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
      {error ? <ErrorText>{error}</ErrorText> : null}
      {notice ? <p className="text-11 text-fg-muted">{notice}</p> : null}

      {/* ---- 1. 需求填写 ---- */}
      <Section step="1" title={t("Requirements")}>
        {environmentId === "" ? (
          <p className="text-11 text-fg-subtle">{t("Select an environment first")}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 md:grid-cols-3">
              {CAPACITY_FIELDS.map((field) => (
                <label key={field.key} className="flex items-center gap-1.5">
                  <span className="w-40 shrink-0 text-11 text-fg-muted">{t(field.label)}</span>
                  <input
                    className={cn(selectClass, "w-24")}
                    inputMode="decimal"
                    value={
                      profile?.[field.key] === null || profile?.[field.key] === undefined
                        ? ""
                        : String(profile[field.key])
                    }
                    aria-label={t(field.label)}
                    onChange={(event) => {
                      const raw = event.target.value.trim();
                      const next = raw === "" ? null : Number(raw);
                      if (raw !== "" && Number.isNaN(next)) return;
                      setProfile((previous) =>
                        previous
                          ? ({ ...previous, [field.key]: next } as CapacityProfile)
                          : previous,
                      );
                    }}
                  />
                </label>
              ))}
              <label className="flex items-center gap-1.5">
                <span className="w-40 shrink-0 text-11 text-fg-muted">
                  {t("Availability target (%)")}
                </span>
                <select
                  className={cn(selectClass, "w-24")}
                  value={profile?.availability_target ?? ""}
                  onChange={(event) =>
                    setProfile((previous) =>
                      previous
                        ? { ...previous, availability_target: event.target.value || null }
                        : previous,
                    )
                  }
                >
                  <option value="">{t("Unknown")}</option>
                  {AVAILABILITY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5">
                <span className="w-40 shrink-0 text-11 text-fg-muted">
                  {t("Budget currency")}
                </span>
                <input
                  className={cn(selectClass, "w-24")}
                  value={profile?.budget_currency ?? ""}
                  onChange={(event) =>
                    setProfile((previous) =>
                      previous
                        ? { ...previous, budget_currency: event.target.value || null }
                        : previous,
                    )
                  }
                />
              </label>
            </div>
            <p className="mt-1.5 text-10 text-fg-subtle">
              {t(
                "Unknown QPS is fine: the engine estimates peak load from DAU or concurrency and writes every assumption down.",
              )}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                disabled={busy || !profile}
                onClick={() => void saveCapacity()}
                className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
              >
                {t("Save requirements")}
              </button>
              {policy ? (
                <label className="flex items-center gap-3 text-11 text-fg-muted">
                  <span className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={policy.require_https}
                      onChange={(event) =>
                        setPolicy({ ...policy, require_https: event.target.checked })
                      }
                    />
                    {t("Require HTTPS")}
                  </span>
                  <span className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      disabled
                      checked={policy.production_requires_approval}
                      onChange={() => undefined}
                    />
                    {t("Production requires approval (cannot be disabled)")}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void savePolicy()}
                    className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
                  >
                    {t("Save policy")}
                  </button>
                </label>
              ) : null}
            </div>
          </>
        )}
      </Section>

      {/* ---- 2. 分析 ---- */}
      <Section step="2" title={t("Analysis")}>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy || applicationId === ""}
            onClick={() => void generate()}
            className="rounded-[7px] bg-accent px-3 py-1 text-11 font-medium text-white disabled:opacity-50"
          >
            {busy ? t("Generating…") : t("Generate proposal")}
          </button>
          <span className="text-10 text-fg-subtle">
            {t("Deterministic rule engine — the same inputs always produce the same proposal.")}
          </span>
        </div>
        {/* P5.5：有 Provider 才给"运行 AI 复核"；没有就如实说"AI 未配置"。 */}
        <AiReviewRow applicationId={applicationId} proposal={proposal} />
        {proposal ? (
          <Fingerprint proposal={proposal} />
        ) : (
          <p className="mt-1.5 text-11 text-fg-subtle">{t("No proposal generated yet")}</p>
        )}
      </Section>

      {proposal ? (
        <>
          {/* ---- 3. 推荐方案 ---- */}
          <Section step="3" title={t("Recommended topology")}>
            <p className="text-12 text-fg">{proposal.summary.headline}</p>
            <TopologyCard option={proposal.recommended_topology} recommended />
            <StatementList statements={proposal.summary.statements} />
            <CapacityBlock proposal={proposal} />
            <ServicesBlock proposal={proposal} />
            <DomainsBlock proposal={proposal} />
            <WorkflowBlock proposal={proposal} />
          </Section>

          {/* ---- 4. 备选方案 ---- */}
          <Section step="4" title={t("Alternative topologies")}>
            {proposal.alternative_topologies.length === 0 ? (
              <p className="text-11 text-fg-subtle">
                {t("No feasible alternative on this server")}
              </p>
            ) : (
              <div className="space-y-2">
                {proposal.alternative_topologies.map((option) => (
                  <TopologyCard key={option.id} option={option} />
                ))}
              </div>
            )}
          </Section>

          {/* ---- 5. 风险 / 未知项 ---- */}
          <Section step="5" title={t("Risks and open questions")}>
            {proposal.risks.length === 0 ? (
              <p className="text-11 text-fg-subtle">{t("No risk flagged")}</p>
            ) : (
              <ul className="space-y-1">
                {proposal.risks.map((risk) => (
                  <li key={risk.id} className="rounded-[7px] border border-line px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <Chip tone={SEVERITY_TONES[risk.severity]}>{t(risk.severity)}</Chip>
                      <span className="text-11 text-fg">{risk.title}</span>
                      {risk.blocks_approval ? (
                        <Chip tone={SEVERITY_TONES.critical}>{t("Blocks approval")}</Chip>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-10 text-fg-subtle">{risk.impact}</p>
                    <p className="text-10 text-fg-muted">
                      {t("Mitigation")}: {risk.mitigation}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            {openQuestions.length > 0 ? (
              <div className="mt-2">
                <div className="text-11 font-medium text-fg-muted">
                  {t("Open questions")}
                </div>
                <ul className="mt-1 space-y-1">
                  {openQuestions.map((unknown) => (
                    <li
                      key={unknown.id}
                      className="rounded-[7px] border border-line px-2 py-1.5"
                    >
                      <div className="flex items-center gap-1.5">
                        <Chip tone={SEVERITY_TONES.info}>
                          {t(UNKNOWN_SEVERITY_LABELS[unknown.severity])}
                        </Chip>
                        <span className="text-11 text-fg">{unknown.question}</span>
                      </div>
                      <p className="mt-0.5 text-10 text-fg-subtle">{unknown.why_it_matters}</p>
                      {unknown.suggested_default ? (
                        <p className="text-10 text-fg-muted">
                          {t("Suggestion")}: {unknown.suggested_default}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {proposal.validation.violations.length > 0 ? (
              <div className="mt-2">
                <div className="text-11 font-medium text-fg-muted">
                  {t("Validation findings")}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {proposal.validation.violations.map((violation) => (
                    <li key={violation.id} className="flex items-start gap-1.5">
                      <Chip
                        tone={
                          violation.blocks_plan
                            ? SEVERITY_TONES.critical
                            : SEVERITY_TONES.high
                        }
                      >
                        {t(VIOLATION_KIND_LABELS[violation.kind])}
                      </Chip>
                      <span className="min-w-0 flex-1 text-10 text-fg-subtle">
                        {violation.location} — {violation.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {proposal.knowledge_conflicts.length > 0 ? (
              <div className="mt-2">
                <div className="text-11 font-medium text-fg-muted">
                  {t("Knowledge base conflicts")}
                </div>
                <ul className="mt-1 space-y-0.5">
                  {proposal.knowledge_conflicts.map((conflict) => (
                    <li key={`${conflict.topic}-${conflict.entries.join()}`} className="text-10 text-fg-subtle">
                      <Chip
                        tone={
                          conflict.resolution === "unresolved"
                            ? SEVERITY_TONES.high
                            : SEVERITY_TONES.info
                        }
                      >
                        {t(CONFLICT_RESOLUTION_LABELS[conflict.resolution])}
                      </Chip>{" "}
                      {conflict.entries.join(" vs ")} — {conflict.explanation}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {proposal.ai_review ? (
              <div className="mt-2">
                <div className="text-11 font-medium text-fg-muted">
                  {t("AI review")} · {proposal.ai_review.model}
                </div>
                <StatementList statements={proposal.ai_review.notes} />
                {proposal.ai_review.rejected.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {proposal.ai_review.rejected.map((rejection, index) => (
                      <li key={`${rejection.reason}-${index}`} className="text-10 text-danger">
                        {t("Rejected")}: {rejection.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Section>

          {/* ---- 6. 确认方案 ---- */}
          <Section step="6" title={t("Confirm the proposal")}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || !canConfirm}
                onClick={() => void confirm()}
                className="rounded-[7px] bg-accent px-3 py-1 text-11 font-medium text-white disabled:opacity-50"
              >
                {t("Confirm proposal")}
              </button>
              <button
                type="button"
                disabled={busy || proposal.status !== "draft"}
                onClick={() => void reject()}
                className="rounded-[7px] border border-line px-2 py-1 text-11 text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-50"
              >
                {t("Reject")}
              </button>
              <span className="text-10 text-fg-subtle">
                {outcome?.ready
                  ? t("Confirming creates a draft plan. Approval and execution come later — nothing is deployed.")
                  : t("This proposal is not ready: answer the open questions and fix the blockers first.")}
              </span>
            </div>
            {proposal.approvals.length > 0 ? (
              <ul className="mt-1.5 space-y-0.5">
                {proposal.approvals.map((approval) => (
                  <li key={approval.id} className="text-10 text-fg-subtle">
                    <Chip tone={SEVERITY_TONES.medium}>{t("Approval required")}</Chip>{" "}
                    {approval.node_key ?? t("Whole proposal")} — {approval.reason}（
                    {approval.required_role}）
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </>
      ) : null}

      {/* ---- 历史 ---- */}
      {history.length > 0 ? (
        <Section step="·" title={t("Proposal history")}>
          <ul className="space-y-0.5">
            {history.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-10 text-fg-subtle">
                <Chip>{item.status}</Chip>
                <span className="min-w-0 flex-1 truncate">{item.summary.headline}</span>
                <span>{item.fingerprint.output_hash.slice(0, 8)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

// -- 子组件 -----------------------------------------------------------------

function Section({
  step,
  title,
  children,
}: {
  step: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[8px] border border-line bg-surface-1 p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-10 text-fg-muted">
          {step}
        </span>
        <span className="text-12 font-semibold text-fg">{title}</span>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Chip({ children, tone }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={cn(
        "rounded-full border border-line bg-surface-2 px-1.5 text-10 text-fg-subtle",
        tone,
      )}
    >
      {children}
    </span>
  );
}

function Fingerprint({ proposal }: { proposal: DeploymentProposal }) {
  const { t } = useTranslation();
  const fingerprint = proposal.fingerprint;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-10 text-fg-subtle">
      <Chip>{t("Input hash")}: {fingerprint.input_hash.slice(0, 12)}</Chip>
      <Chip>{t("Output hash")}: {fingerprint.output_hash.slice(0, 12)}</Chip>
      <Chip>{t("Knowledge")}: {fingerprint.knowledge_version}</Chip>
      <Chip>{t("Engine")}: {fingerprint.engine_version}</Chip>
      <Chip>{t("Prompt")}: {fingerprint.prompt_version}</Chip>
      <Chip>
        {t("Model")}: {fingerprint.model ?? t("AI not enabled (no provider configured)")}
      </Chip>
    </div>
  );
}

/** 一条结论带等级、置信度与依据。 */
function StatementList({ statements }: { statements: ProposalStatement[] }) {
  const { t } = useTranslation();
  return (
    <ul className="mt-1.5 space-y-1">
      {statements.map((statement) => (
        <li key={statement.id} className="rounded-[7px] border border-line px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Chip
              tone={
                statement.class === "fact"
                  ? SEVERITY_TONES.low
                  : statement.class === "unknown"
                    ? SEVERITY_TONES.critical
                    : SEVERITY_TONES.info
              }
            >
              {t(EVIDENCE_CLASS_LABELS[statement.class])}
            </Chip>
            <Chip>{statement.confidence}</Chip>
            <span className="text-11 text-fg">{statement.text}</span>
          </div>
          {statement.evidence.length > 0 ? (
            <ul className="mt-0.5 space-y-0.5">
              {statement.evidence.map((evidence, index) => (
                <li key={`${statement.id}-${index}`} className="text-10 text-fg-subtle">
                  {evidence.detail}
                  {evidence.reference ? ` · ${evidence.reference}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TopologyCard({
  option,
  recommended,
}: {
  option: ProposalTopologyOption;
  recommended?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "rounded-[7px] border px-2 py-1.5",
        recommended ? "border-accent/40 bg-accent/5" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-12 text-fg">{t(TOPOLOGY_KIND_LABELS[option.kind])}</span>
        <Chip>{t("Complexity")} {option.complexity}/5</Chip>
        <Chip tone={option.feasible ? SEVERITY_TONES.low : SEVERITY_TONES.critical}>
          {option.feasible ? t("Feasible on this server") : t("Not feasible here")}
        </Chip>
        {option.monthly_cost_hint !== null ? (
          <Chip>
            {t("About")} {option.monthly_cost_hint} / {t("month")}
          </Chip>
        ) : null}
      </div>
      <p className="mt-0.5 text-10 text-fg-subtle">{option.description}</p>
      {option.pros.length > 0 ? (
        <p className="mt-0.5 text-10 text-fg-muted">+ {option.pros.join("；")}</p>
      ) : null}
      {option.cons.length > 0 ? (
        <p className="text-10 text-fg-muted">- {option.cons.join("；")}</p>
      ) : null}
      {option.blockers.length > 0 ? (
        <p className="text-10 text-danger">
          {t("Blockers")}: {option.blockers.join("；")}
        </p>
      ) : null}
      {option.service_names.length > 0 ? (
        <p className="text-10 text-fg-subtle">
          {t("Covers")}: {option.service_names.join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function CapacityBlock({ proposal }: { proposal: DeploymentProposal }) {
  const { t } = useTranslation();
  const capacity = proposal.capacity_recommendation;
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-11 font-medium text-fg-muted">{t("Capacity")}</span>
        <Chip>
          {t("Peak QPS")}: {capacity.peak_qps ?? t("Unknown")} ·{" "}
          {t(EVIDENCE_CLASS_LABELS[capacity.peak_qps_basis])}
        </Chip>
        <Chip>
          {capacity.vcpu} vCPU / {capacity.memory_mb} MB / {capacity.disk_gb} GB
        </Chip>
        <Chip>
          {t("Headroom")}: {capacity.headroom_percent}%
        </Chip>
        {capacity.bandwidth_mbps !== null ? (
          <Chip>{capacity.bandwidth_mbps} Mbps</Chip>
        ) : null}
        <Chip
          tone={
            capacity.fits_on_server === false
              ? SEVERITY_TONES.critical
              : capacity.fits_on_server === true
                ? SEVERITY_TONES.low
                : SEVERITY_TONES.info
          }
        >
          {capacity.fits_on_server === null
            ? t("Server resources not measured yet")
            : capacity.fits_on_server
              ? t("Fits on the server")
              : t("Does not fit on the server")}
        </Chip>
      </div>
      {proposal.assumptions.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {proposal.assumptions.map((assumption) => (
            <li key={assumption.id} className="text-10 text-fg-subtle">
              <Chip tone={SEVERITY_TONES.info}>
                {t(EVIDENCE_CLASS_LABELS[assumption.class])}
              </Chip>{" "}
              {assumption.statement}
              <span className="text-fg-muted"> — {t("if wrong")}: {assumption.if_wrong}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ServicesBlock({ proposal }: { proposal: DeploymentProposal }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2">
      <div className="text-11 font-medium text-fg-muted">{t("Services")}</div>
      <ul className="mt-0.5 space-y-0.5">
        {proposal.services.map((service) => (
          <li key={service.service_unit_id} className="flex flex-wrap items-center gap-1.5">
            <span className="text-11 text-fg">{service.name}</span>
            <Chip>{t(SERVICE_ROLE_LABELS[service.role])}</Chip>
            <Chip>{t(SERVICE_KIND_LABELS[service.service_kind])}</Chip>
            {service.ports.length > 0 ? (
              <Chip>
                {t("Ports")}: {service.ports.map((port) => port.host_port).join(", ")}
              </Chip>
            ) : (
              <Chip tone={SEVERITY_TONES.info}>{t("Port not decided")}</Chip>
            )}
            <Chip
              tone={service.health_check ? SEVERITY_TONES.low : SEVERITY_TONES.medium}
            >
              {service.health_check
                ? `${t("Health check")}: ${service.health_check.target}`
                : t("No health check")}
            </Chip>
            <Chip>
              {service.resource_estimate.cpu_cores} vCPU /{" "}
              {service.resource_estimate.memory_mb} MB
            </Chip>
          </li>
        ))}
      </ul>
      {proposal.dependencies.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {proposal.dependencies.map((dependency) => (
            <li key={dependency.id} className="text-10 text-fg-subtle">
              {dependency.from_service} → {dependency.to_service}
              {dependency.required ? ` (${t("required")})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DomainsBlock({ proposal }: { proposal: DeploymentProposal }) {
  const { t } = useTranslation();
  if (proposal.domains.length === 0) {
    return null;
  }
  return (
    <div className="mt-2">
      <div className="text-11 font-medium text-fg-muted">{t("Domains")}</div>
      <ul className="mt-0.5 space-y-0.5">
        {proposal.domains.map((domain) => (
          <li key={domain.domain} className="flex flex-wrap items-center gap-1.5">
            <span className="text-11 text-fg">
              {domain.domain}:{domain.listen_port}
            </span>
            <Chip>{domain.service_name ?? t("Not bound")}</Chip>
            <Chip tone={domain.ssl_mode === "none" ? SEVERITY_TONES.high : SEVERITY_TONES.low}>
              {domain.ssl_mode}
            </Chip>
            {domain.certificate_required ? (
              <Chip tone={SEVERITY_TONES.medium}>{t("Certificate will be issued")}</Chip>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkflowBlock({ proposal }: { proposal: DeploymentProposal }) {
  const { t } = useTranslation();
  const workflow = proposal.workflow;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <span className="text-11 font-medium text-fg-muted">{t("Workflow")}</span>
        <Chip>
          {workflow.nodes.length} {t("nodes")} / {workflow.edges.length} {t("edges")}
        </Chip>
        {workflow.nodes.length === 0 ? (
          <Chip tone={SEVERITY_TONES.critical}>{t("No executable plan yet")}</Chip>
        ) : null}
      </div>
      {workflow.nodes.length > 0 ? (
        <ol className="mt-1 space-y-0.5">
          {workflow.nodes.map((node) => (
            <li key={node.id} className="flex flex-wrap items-center gap-1.5 text-10">
              <span className="text-fg-subtle">{node.position + 1}.</span>
              <span className="text-fg">{node.title}</span>
              <Chip>{node.action}</Chip>
              <Chip tone={SEVERITY_TONES[node.risk_level]}>{node.risk_level}</Chip>
              {node.approval_required ? (
                <Chip tone={SEVERITY_TONES.medium}>{t("Approval required")}</Chip>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <StatementList statements={workflow.notes} />
    </div>
  );
}
