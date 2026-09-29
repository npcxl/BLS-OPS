/**
 * P5.3 / P5.4 —— **部署执行页**。
 *
 * 三栏结构（需求逐条对应）：
 *
 * ```
 * 左：应用 / 环境 / 计划 选择 + 预检入口
 * 中：预检报告 → 部署步骤与日志（单节点重试、审批后继续）
 * 右：方案与风险、审批摘要、历史版本与一键回滚、失败原因与 AI 诊断入口
 * ```
 *
 * # 为什么"高风险节点"要在这里显式确认
 *
 * 后端在遇到需要确认的节点时会把运行**暂停**并等一个批准（不跳过、不代签）。
 * 界面上因此必须提供两件事：**预先批准**（"这份计划我已经审过"）与
 * **逐节点确认**（跑到那一步再决定）。两者都会写进运行元数据，可审计。
 *
 * # 事件是主路径，轮询只是兜底
 *
 * 后端每条动作边界都会推一次 `DeploymentRunDetail`；订阅失败（浏览器里跑测试）
 * 或漏事件时，`deploymentRunGet` 轮询会把状态拉回来。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  opsApi,
  type DeploymentProposal,
  type DeploymentRun,
  type DeploymentRunDetail,
  type DnsGuidance,
  type CertificatePlan,
  type PreflightOutcome,
  type RunNode,
} from "@/api/ops-api";
import { StatusBadge, StatusNotice } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { ErrorText, selectClass } from "@/components/ui/modal";
import { LoadingState } from "@/components/ui/loading";
import { EmptyState } from "@/components/ui/empty-state";
import { deploymentRunEvent } from "@/lib/events";
import { cn } from "@/lib/cn";
import { useSessionStore } from "@/stores/session-store";

import { useDeploymentCenter } from "./use-deployment-center";
import {
  ARTIFACT_KIND_LABELS,
  CHECK_STATE_LABELS,
  RISK_TONES,
  RUN_ACTION_KIND_LABELS,
  RUN_NODE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  RELEASE_STATUS_LABELS,
} from "./labels";

type Props = {
  applicationId: string;
  environmentId: string;
  /** 已连接的 SSH 会话；没有它就不能执行任何远程动作。 */
  sessionId: string | null;
  onChanged: () => void;
};

// -- 纯逻辑（有单测）---------------------------------------------------------

/** 当前步骤：第一个还没成功的节点。全成功则返回 null。 */
export function currentStep(nodes: RunNode[]): RunNode | null {
  return (
    nodes.find(
      (node) =>
        node.status !== "succeeded" && node.status !== "skipped" && node.status !== "cancelled",
    ) ?? null
  );
}

/** 卡在审批上的节点（运行暂停时展示"确认并继续"）。 */
export function pendingApproval(nodes: RunNode[]): RunNode | null {
  return nodes.find((node) => node.status === "blocked") ?? null;
}

/** 失败的节点（"重试本节点"的目标）。 */
export function failedStep(nodes: RunNode[]): RunNode | null {
  return nodes.find((node) => node.status === "failed") ?? null;
}

/** 运行能否取消：只有还在跑或暂停中的运行可以。 */
export function canCancel(run: DeploymentRun | null): boolean {
  return run?.status === "running" || run?.status === "paused";
}

/** 运行能否回滚：结束后（失败或已回滚过的都允许再试）才谈回滚。 */
export function canRollback(run: DeploymentRun | null): boolean {
  return (
    run != null &&
    (run.status === "failed" || run.status === "succeeded" || run.status === "rolled_back")
  );
}

/** 失败原因（界面要显示人话，不是空白）。 */
export function failureReason(run: DeploymentRun | null, nodes: RunNode[]): string | null {
  if (!run || run.status !== "failed") return null;
  const failed = failedStep(nodes);
  return failed?.error_message ?? run.error_message ?? null;
}

/** 进度：已完成节点 / 总节点（0-100）。 */
export function progressPercent(nodes: RunNode[]): number {
  if (nodes.length === 0) return 0;
  const done = nodes.filter(
    (node) => node.status === "succeeded" || node.status === "skipped",
  ).length;
  return Math.round((done / nodes.length) * 100);
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  pending: "neutral",
  running: "info",
  succeeded: "success",
  failed: "danger",
  skipped: "neutral",
  cancelled: "warning",
  blocked: "warning",
};

const RUN_STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  pending: "neutral",
  running: "info",
  paused: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "warning",
  rolled_back: "neutral",
};

// -- 组件 --------------------------------------------------------------------

export function RunPanel({ applicationId, environmentId, sessionId, onChanged }: Props) {
  const { t } = useTranslation();
  const center = useDeploymentCenter();
  const sessions = useSessionStore((state) => state.sessions);

  const [planId, setPlanId] = useState("");
  const [preflight, setPreflight] = useState<PreflightOutcome | null>(null);
  const [detail, setDetail] = useState<DeploymentRunDetail | null>(null);
  const [proposal, setProposal] = useState<DeploymentProposal | null>(null);
  const [guidance, setGuidance] = useState<DnsGuidance | null>(null);
  const [sslPlan, setSslPlan] = useState<CertificatePlan | null>(null);
  const [approveAll, setApproveAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 没有会话时退而求其次：这台服务器上任意一个已连接的会话都能执行。
  const effectiveSession = useMemo(() => {
    if (sessionId) return sessionId;
    const serverId = center.applications.find((item) => item.id === applicationId)?.server_id;
    if (!serverId) return null;
    return (
      Object.values(sessions).find(
        (session) => session.serverId === serverId && session.status === "connected",
      )?.sessionId ?? null
    );
  }, [sessionId, center.applications, applicationId, sessions]);

  const plans = useMemo(
    () => center.plans.filter((plan) => plan.environment_id === environmentId),
    [center.plans, environmentId],
  );

  // 默认选中最新的一份计划（列表已按创建时间倒序）。
  useEffect(() => {
    if (planId && plans.some((plan) => plan.id === planId)) return;
    setPlanId(plans[0]?.id ?? "");
  }, [plans, planId]);

  const runs = useMemo(
    () => center.runs.filter((run) => run.environment_id === environmentId),
    [center.runs, environmentId],
  );
  const releases = useMemo(
    () => center.releases.filter((release) => release.environment_id === environmentId),
    [center.releases, environmentId],
  );

  /** 把一条运行的状态灌进界面（事件与轮询共用）。 */
  const applyDetail = useCallback((next: DeploymentRunDetail | null) => {
    setDetail(next);
  }, []);

  // 打开某个计划：先拉最近一次运行，界面不至于空白。
  const openPlan = useCallback(
    async (id: string) => {
      setBusy(true);
      setError(null);
      try {
        const [latest] = await opsApi.deploymentRunList(applicationId, id, 1);
        if (latest) {
          applyDetail(await opsApi.deploymentRunGet(latest.id));
        } else {
          applyDetail(null);
        }
        setPreflight(await opsApi.deploymentRunPreflight(id, effectiveSession ?? undefined));
      } catch (cause) {
        setError(opsApi && cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [applicationId, applyDetail, effectiveSession],
  );

  useEffect(() => {
    if (!planId) {
      applyDetail(null);
      setPreflight(null);
      return;
    }
    void openPlan(planId);
    // 只在计划变化时重新拉，避免输入法/焦点抖动导致重复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId]);

  // 方案摘要（右侧）：取最近一份方案。
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const [latest] = await opsApi.deploymentProposalList(applicationId, 1);
        if (!disposed) setProposal(latest ?? null);
      } catch {
        if (!disposed) setProposal(null);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [applicationId]);

  // 域名与证书指导：只在用户展开时拉，避免无谓请求。
  const loadGuidance = useCallback(async () => {
    try {
      const bindings = await opsApi.deploymentDomainList(environmentId);
      const binding = bindings[0];
      if (!binding) {
        setError("这个环境还没有绑定域名");
        return;
      }
      setGuidance(await opsApi.deploymentDnsGuidance(binding.id));
      setSslPlan(await opsApi.deploymentSslPlan(binding.id, effectiveSession ?? undefined));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [environmentId, effectiveSession]);

  // ---- 事件（主路径）----
  useEffect(() => {
    if (!environmentId) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const unsubscribe = await listen<DeploymentRunDetail>(
          deploymentRunEvent(environmentId),
          (event) => {
            applyDetail(event.payload);
          },
        );
        if (disposed) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
      } catch {
        /* 事件不可用（例如浏览器里跑测试）时静默降级为轮询。 */
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, [environmentId, applyDetail]);

  // ---- 轮询兜底：运行中每秒拉一次 ----
  const runId = detail?.run.id ?? null;
  const running = detail?.run.status === "running";
  useEffect(() => {
    if (!runId || !running) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const next = await opsApi.deploymentRunGet(runId).catch(() => null);
        if (next) applyDetail(next);
      })();
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [runId, running, applyDetail]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await center.reload();
      if (planId) {
        setPreflight(await opsApi.deploymentRunPreflight(planId, effectiveSession ?? undefined));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      if (!planId || !effectiveSession) return;
      const next = await opsApi.deploymentRunStart(planId, effectiveSession, approveAll);
      applyDetail(next);
      onChanged();
    });

  const approve = (nodeKey: string) =>
    run(async () => {
      if (!runId) return;
      const next = await opsApi.deploymentRunApproveNode(
        runId,
        nodeKey,
        effectiveSession ?? undefined,
      );
      applyDetail(next);
      onChanged();
    });

  const retry = (nodeKey: string) =>
    run(async () => {
      if (!runId || !effectiveSession) return;
      const next = await opsApi.deploymentRunResume(runId, effectiveSession, nodeKey);
      applyDetail(next);
      onChanged();
    });

  const cancel = () =>
    run(async () => {
      if (!runId) return;
      await opsApi.deploymentRunCancel(runId);
      applyDetail(await opsApi.deploymentRunGet(runId));
      onChanged();
    });

  const rollback = (target?: DeploymentRun) =>
    run(async () => {
      const id = target?.id ?? runId;
      if (!id || !effectiveSession) return;
      const next = await opsApi.deploymentRunRollback(id, effectiveSession);
      applyDetail(next);
      onChanged();
    });

  const nodes = detail?.nodes ?? [];
  const current = currentStep(nodes);
  const approval = pendingApproval(nodes);
  const failed = failedStep(nodes);
  const reason = failureReason(detail?.run ?? null, nodes);

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
      {/* ---------- 左：应用 / 环境 / 计划 ---------- */}
      <aside className="min-h-0 space-y-3 overflow-auto ops-scroll">
        <div className="rounded-md border border-line bg-surface-2 p-3">
          <div className="text-xs font-medium text-fg-muted">{t("Applications")}</div>
          <div className="mt-1 truncate text-sm">
            {center.applications.find((item) => item.id === applicationId)?.name ?? "—"}
          </div>
          <div className="mt-3 text-xs font-medium text-fg-muted">{t("Environments")}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate text-sm">
              {center.environments.find((item) => item.id === environmentId)?.name ?? "—"}
            </span>
            <StatusBadge tone={preflight?.environment_kind === "production" ? "danger" : "neutral"}>
              {preflight?.environment_kind ?? "—"}
            </StatusBadge>
          </div>
          <div className="mt-3 text-xs font-medium text-fg-muted">{t("Plans")}</div>
          <select
            className={cn(selectClass, "mt-1 w-full")}
            value={planId}
            onChange={(event) => setPlanId(event.target.value)}
          >
            {plans.length === 0 ? <option value="">{t("No plans yet")}</option> : null}
            {plans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.name} · v{plan.version}
              </option>
            ))}
          </select>
          <div className="mt-3 text-xs text-fg-muted">
            {effectiveSession
              ? t("SSH session ready")
              : t("No connected SSH session: connect a terminal first")}
          </div>
        </div>

        {/* 预检 */}
        {preflight ? (
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-fg-muted">{t("Preflight")}</span>
              <StatusBadge tone={preflight.report.can_run ? "success" : "danger"}>
                {preflight.report.can_run ? t("Ready to run") : t("Blocked")}
              </StatusBadge>
            </div>
            <ul className="mt-2 space-y-1">
              {preflight.report.checks.map((check) => (
                <li key={check.id} className="text-xs">
                  <StatusBadge tone={STATUS_TONE[check.state] ?? "neutral"}>
                    {t(CHECK_STATE_LABELS[check.state] ?? check.state)}
                  </StatusBadge>
                  <span className="ml-1">{check.label}</span>
                  <div className="text-fg-muted">{check.detail}</div>
                </li>
              ))}
            </ul>
            {preflight.report.warnings.map((warning) => (
              <div key={warning} className="mt-2 text-xs text-amber-600">
                {warning}
              </div>
            ))}
          </div>
        ) : null}
      </aside>

      {/* ---------- 中：步骤与日志 ---------- */}
      <section className="flex min-h-0 flex-col rounded-md border border-line bg-surface">
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t("Deploy run")}</span>
            {detail ? (
              <StatusBadge tone={RUN_STATUS_TONE[detail.run.status] ?? "neutral"}>
                {t(RUN_STATUS_LABELS[detail.run.status])}
              </StatusBadge>
            ) : null}
            {detail ? (
              <span className="text-xs text-fg-muted">
                {detail.run.plan_version ? `v${detail.run.plan_version} · ` : ""}
                {progressPercent(nodes)}%
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-fg-muted">
              <input
                type="checkbox"
                checked={approveAll}
                onChange={(event) => setApproveAll(event.target.checked)}
              />
              {t("Approve high-risk steps up front")}
            </label>
            <Button
              size="sm"
              disabled={busy || !planId || !effectiveSession || !preflight?.report.can_run}
              onClick={() => void start()}
            >
              {t("Start deployment")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !canCancel(detail?.run ?? null)}
              onClick={() => void cancel()}
            >
              {t("Cancel")}
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto ops-scroll p-3">
          {error ? <ErrorText>{error}</ErrorText> : null}
          {busy && !detail ? <LoadingState label={t("Loading")} compact /> : null}
          {!detail ? (
            <EmptyState
              title={t("No deployment run yet")}
              description={t("Pick a plan and run the preflight to begin.")}
            />
          ) : (
            <ol className="space-y-2">
              {nodes.map((node) => (
                <li
                  key={node.id}
                  className={cn(
                    "rounded-md border p-2",
                    node.status === "failed"
                      ? "border-danger/40 bg-danger/5"
                      : node.status === "blocked"
                        ? "border-amber-400/40 bg-amber-400/5"
                        : "border-line bg-surface-2",
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={STATUS_TONE[node.status] ?? "neutral"}>
                      {t(RUN_NODE_STATUS_LABELS[node.status])}
                    </StatusBadge>
                    <span className="text-sm">
                      {node.action
                        ? t(RUN_ACTION_KIND_LABELS[node.action] ?? node.title)
                        : node.title}
                    </span>
                    <span
                      className={cn(
                        "rounded border px-1 text-xs",
                        RISK_TONES[node.risk_level] ?? "border-line bg-surface-2",
                      )}
                    >
                      {node.risk_level}
                    </span>
                    <span className="text-xs text-fg-muted">{node.node_key}</span>
                    {node.attempt > 1 ? (
                      <span className="text-xs text-fg-muted">
                        {t("Attempt")} {node.attempt}
                      </span>
                    ) : null}
                    {node.duration_ms != null ? (
                      <span className="text-xs text-fg-muted">{node.duration_ms} ms</span>
                    ) : null}
                    <span className="ml-auto flex gap-1">
                      {node.status === "blocked" ? (
                        <Button
                          size="xs"
                          disabled={busy || !effectiveSession}
                          onClick={() => void approve(node.node_key)}
                        >
                          {t("Confirm and continue")}
                        </Button>
                      ) : null}
                      {node.status === "failed" ? (
                        <Button
                          size="xs"
                          variant="secondary"
                          disabled={busy || !effectiveSession}
                          onClick={() => void retry(node.node_key)}
                        >
                          {t("Retry this step")}
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {node.error_message ? (
                    <div className="mt-1 text-xs text-danger">{node.error_message}</div>
                  ) : null}
                  {node.output ? (
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface p-2 text-xs">
                      {node.output}
                    </pre>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="border-t border-line px-3 py-2 text-xs text-fg-muted">
          {approval
            ? `${t("Waiting for confirmation")}: ${approval.node_key}`
            : failed
              ? `${t("Failed step")}: ${failed.node_key}`
              : current
                ? `${t("Current step")}: ${current.node_key}`
                : detail
                  ? t("All steps finished")
                  : t("Not started")}
        </footer>
      </section>

      {/* ---------- 右：方案 / 风险 / 审批 / 历史 ---------- */}
      <aside className="min-h-0 space-y-3 overflow-auto ops-scroll">
        {reason ? (
          <StatusNotice tone="danger" title={t("Failure reason")}>
            <div className="space-y-2">
              <p className="text-xs">{reason}</p>
              <Button size="xs" variant="secondary" disabled title={t("AI advisor is disabled")}>
                {t("AI diagnosis (not enabled)")}
              </Button>
              <p className="text-xs text-fg-muted">
                {t(
                  "The AI advisor is off in this build: the decision stays with you and a human review is required.",
                )}
              </p>
            </div>
          </StatusNotice>
        ) : null}

        {proposal ? (
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <div className="text-xs font-medium text-fg-muted">{t("Plan and risks")}</div>
            <p className="mt-1 text-sm">{proposal.summary?.headline}</p>
            <ul className="mt-2 space-y-1">
              {(proposal.risks ?? []).slice(0, 5).map((risk) => (
                <li key={risk.id} className="text-xs">
                  <span className={cn("mr-1 rounded border px-1", RISK_TONES[risk.severity])}>
                    {risk.severity}
                  </span>
                  {risk.title}
                </li>
              ))}
            </ul>
            <div className="mt-2 text-xs font-medium text-fg-muted">{t("Approvals")}</div>
            <ul className="mt-1 space-y-1 text-xs">
              {(proposal.approvals ?? []).map((approval) => (
                <li key={approval.id}>
                  {approval.node_key ?? t("Whole plan")} · {approval.reason}
                </li>
              ))}
            </ul>
            {(proposal.validation?.violations ?? []).length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-danger">
                {proposal.validation.violations.map((violation) => (
                  <li key={violation.id}>{violation.detail}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-md border border-line bg-surface-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-fg-muted">{t("History and rollback")}</span>
            <Button size="xs" variant="ghost" onClick={() => void loadGuidance()}>
              {t("Domains and certificates")}
            </Button>
          </div>
          <ul className="mt-2 space-y-2">
            {runs.length === 0 ? (
              <li className="text-xs text-fg-muted">{t("No runs yet")}</li>
            ) : null}
            {runs.slice(0, 8).map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-xs">
                <StatusBadge tone={RUN_STATUS_TONE[item.status] ?? "neutral"}>
                  {t(RUN_STATUS_LABELS[item.status])}
                </StatusBadge>
                <span className="truncate">{new Date(item.created_at).toLocaleString()}</span>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  disabled={busy || !effectiveSession || !canRollback(item)}
                  onClick={() => void rollback(item)}
                >
                  {t("Roll back")}
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs font-medium text-fg-muted">{t("Releases")}</div>
          <ul className="mt-1 space-y-1 text-xs">
            {releases.length === 0 ? (
              <li className="text-fg-muted">{t("No releases yet")}</li>
            ) : null}
            {releases.slice(0, 6).map((release) => (
              <li key={release.id} className="flex items-center gap-2">
                <StatusBadge tone={release.is_active ? "success" : "neutral"}>
                  {t(RELEASE_STATUS_LABELS[release.status])}
                </StatusBadge>
                <span className="truncate">{release.version_label}</span>
                {release.artifact_id ? (
                  <span className="text-fg-muted">
                    {t(ARTIFACT_KIND_LABELS.folder) /* 占位：制品类型由制品列表决定 */}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        {guidance ? (
          <div className="rounded-md border border-line bg-surface-2 p-3">
            <div className="text-xs font-medium text-fg-muted">
              {t("DNS records to add")} · {guidance.provider_name}
            </div>
            <table className="mt-1 w-full text-xs">
              <tbody>
                {guidance.instructions.map((item) => (
                  <tr key={`${item.record_type}-${item.name}`}>
                    <td className="pr-2 align-top">{item.record_type}</td>
                    <td className="pr-2 align-top">{item.name}</td>
                    <td className="text-fg-muted">{item.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-fg-muted">
              {guidance.automation_supported
                ? t("This provider can be automated.")
                : t(
                    "No DNS provider API is called in this version: add the records yourself, then verify the resolution.",
                  )}
            </p>
            {sslPlan ? (
              <div className="mt-2 text-xs">
                <div className="font-medium text-fg-muted">
                  {t("Certificate plan")} · {sslPlan.challenge}
                  {sslPlan.wildcard ? " (wildcard)" : ""}
                </div>
                <ul className="mt-1 space-y-1 text-fg-muted">
                  {sslPlan.preconditions.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                {sslPlan.blocked_reason ? (
                  <div className="mt-1 text-danger">{sslPlan.blocked_reason}</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
