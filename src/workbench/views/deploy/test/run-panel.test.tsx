/**
 * 部署执行页测试。
 *
 * 两件事分开测：
 *
 * 1. **纯逻辑**（当前节点、待审批节点、失败节点、能否取消 / 回滚、进度、失败原因）——
 *    这些决定"界面上该出现哪个按钮"，必须能在没有 DOM 的情况下证明。
 * 2. **渲染与交互**：预检结论、逐节点确认、单节点重试、失败原因与 AI 诊断入口。
 *
 * 与其它部署测试同一套约定：mock 里只列 opsApi 上真实存在的方法，组件一旦绕过
 * opsApi 直接 `invoke` 就会崩。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "@/i18n";

const runListMock = vi.fn();
const runGetMock = vi.fn();
const preflightMock = vi.fn();
const approveMock = vi.fn();
const resumeMock = vi.fn();
const rollbackMock = vi.fn();
const proposalListMock = vi.fn();

vi.mock("@/api/ops-api", () => ({
  toErrorMessage: (cause: unknown) => String(cause),
  opsApi: {
    deploymentRunList: (...args: unknown[]) => runListMock(...args),
    deploymentRunGet: (...args: unknown[]) => runGetMock(...args),
    deploymentRunPreflight: (...args: unknown[]) => preflightMock(...args),
    deploymentRunStart: async () => detail,
    deploymentRunApproveNode: (...args: unknown[]) => approveMock(...args),
    deploymentRunResume: (...args: unknown[]) => resumeMock(...args),
    deploymentRunCancel: async () => true,
    deploymentRunRollback: (...args: unknown[]) => rollbackMock(...args),
    deploymentProposalList: (...args: unknown[]) => proposalListMock(...args),
    deploymentDomainList: async () => [],
    deploymentDnsGuidance: async () => null,
    deploymentSslPlan: async () => null,
  },
}));

const reloadMock = vi.fn(async () => {});
vi.mock("../use-deployment-center", () => ({
  useDeploymentCenter: () => ({
    applicationId: "app-1",
    environmentId: "env-1",
    applications: [{ id: "app-1", name: "Shop", server_id: "srv-1" }],
    environments: [{ id: "env-1", name: "production", kind: "production" }],
    plans: [{ id: "plan-1", name: "Deploy 1.0.0", version: 3, environment_id: "env-1" }],
    runs: [runFixture("run-1", "failed")],
    releases: [
      {
        id: "rel-1",
        environment_id: "env-1",
        version_label: "v1.1",
        status: "active",
        is_active: true,
        artifact_id: "art-1",
      },
    ],
    reload: reloadMock,
  }),
}));

import { i18n } from "@/i18n";
import type { DeploymentRun, DeploymentRunDetail, RunNode } from "@/api/types/deployment";

import {
  RunPanel,
  canCancel,
  canRollback,
  currentStep,
  failedStep,
  failureReason,
  pendingApproval,
  progressPercent,
} from "../run-panel";

function nodeFixture(overrides: Partial<RunNode>): RunNode {
  return {
    id: `run-1:${overrides.node_key ?? "node"}`,
    run_id: "run-1",
    node_id: null,
    node_key: "upload_artifact",
    title: "Upload artifact",
    action: "upload_artifact",
    risk_level: "medium",
    status: "pending",
    attempt: 1,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    exit_code: null,
    output: "",
    error_message: null,
    created_at: 1,
    ...overrides,
  };
}

function runFixture(id: string, status: DeploymentRun["status"]): DeploymentRun {
  return {
    id,
    plan_id: "plan-1",
    application_id: "app-1",
    environment_id: "env-1",
    server_id: "srv-1",
    server_name: "prod",
    status,
    trigger_source: "manual",
    plan_version: 3,
    started_at: 1,
    finished_at: 2,
    duration_ms: 1,
    log: "",
    error_message: null,
    snapshot_json: null,
    release_id: null,
    created_at: 1,
  };
}

const detail: DeploymentRunDetail = {
  run: runFixture("run-1", "failed"),
  nodes: [
    nodeFixture({ node_key: "check_dependencies", status: "succeeded", risk_level: "low" }),
    nodeFixture({ node_key: "upload_artifact", status: "succeeded" }),
    nodeFixture({
      node_key: "write_nginx_config",
      action: "write_nginx_config",
      title: "Write nginx config",
      status: "blocked",
    }),
    nodeFixture({
      node_key: "reload_nginx",
      action: "reload_nginx",
      title: "Reload nginx",
      status: "failed",
      error_message: "拒绝 reload：nginx -t 未通过",
      output: "nginx: configuration file test failed",
    }),
  ],
};

const preflight = {
  report: {
    checks: [
      { id: "plan_status", label: "Plan approved", state: "ready", detail: "ok" },
      {
        id: "capability",
        label: "Server capability",
        state: "unknown",
        detail: "checked at run time",
      },
    ],
    can_run: true,
    warnings: ["This is production: high-risk steps need confirmation."],
  },
  environment_id: "env-1",
  environment_kind: "production",
  version_label: "v3.1",
  approval_nodes: ["write_nginx_config"],
};

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  // 纯逻辑用例不渲染，这里必须容忍"没有 root"。
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.clearAllMocks();
});

/** 渲染面板并等待首轮异步请求落地。 */
async function render(props: { sessionId: string | null }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  runListMock.mockResolvedValue([runFixture("run-1", "failed")]);
  runGetMock.mockResolvedValue(detail);
  preflightMock.mockResolvedValue(preflight);
  proposalListMock.mockResolvedValue([
    {
      summary: { headline: "单机部署：静态站点 + 一个后端" },
      risks: [{ id: "r1", title: "没有备份", severity: "high" }],
      approvals: [{ id: "a1", node_key: "promote_release", reason: "提升版本会切流量" }],
      validation: { violations: [] },
    },
  ]);
  await act(async () => {
    root.render(
      <RunPanel
        applicationId="app-1"
        environmentId="env-1"
        sessionId={props.sessionId}
        onChanged={() => {}}
      />,
    );
  });
  // 挂载效果里有三段串行请求（运行列表 → 运行详情 → 预检），
  // 每个宏任务推进一轮，跑几轮再断言。
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 让 promise 链推进一轮。 */
async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function text(): string {
  return document.body.textContent ?? "";
}

describe("部署执行页的纯逻辑", () => {
  it("当前节点是第一个还没成功的节点", () => {
    expect(currentStep(detail.nodes)?.node_key).toBe("write_nginx_config");
    const allDone = detail.nodes.map((node) => ({ ...node, status: "succeeded" as const }));
    expect(currentStep(allDone)).toBeNull();
  });

  it("待确认与失败节点分开定位", () => {
    expect(pendingApproval(detail.nodes)?.node_key).toBe("write_nginx_config");
    expect(failedStep(detail.nodes)?.node_key).toBe("reload_nginx");
  });

  it("只有跑着或暂停中的运行能取消", () => {
    expect(canCancel(runFixture("run-1", "running"))).toBe(true);
    expect(canCancel(runFixture("run-1", "paused"))).toBe(true);
    expect(canCancel(runFixture("run-1", "succeeded"))).toBe(false);
    expect(canCancel(null)).toBe(false);
  });

  it("回滚只在运行结束后才有意义", () => {
    expect(canRollback(runFixture("run-1", "failed"))).toBe(true);
    expect(canRollback(runFixture("run-1", "succeeded"))).toBe(true);
    expect(canRollback(runFixture("run-1", "running"))).toBe(false);
    expect(canRollback(null)).toBe(false);
  });

  it("失败原因优先取节点错误", () => {
    expect(failureReason(detail.run, detail.nodes)).toBe("拒绝 reload：nginx -t 未通过");
    expect(failureReason(runFixture("run-1", "running"), detail.nodes)).toBeNull();
  });

  it("进度按已完成节点算", () => {
    expect(progressPercent(detail.nodes)).toBe(50);
    expect(progressPercent([])).toBe(0);
  });
});

describe("部署执行页的界面", () => {
  it("展示预检结论、逐节点确认 / 重试、失败原因与 AI 诊断入口", async () => {
    await render({ sessionId: "sess-1" });

    // 预检：通过 + 本地无法判定（如实标注，不假装通过）。
    expect(text()).toContain("Plan approved");
    expect(text()).toContain("Server capability");
    expect(text()).toContain("production");
    // 动作标签与风险级别。
    expect(text()).toContain(i18n.t("写入 Nginx 配置"));
    expect(text()).toContain(i18n.t("重载 Nginx"));
    expect(text()).toContain("medium");
    // 待确认节点与失败节点各自的入口。
    expect(findButton(i18n.t("确认并继续"))).toBeTruthy();
    expect(findButton(i18n.t("重试本节点"))).toBeTruthy();
    // 失败原因 + AI 诊断入口（明说未启用，不用模板假装分析）。
    expect(text()).toContain(i18n.t("失败原因"));
    expect(text()).toContain("拒绝 reload：nginx -t 未通过");
    expect(text()).toContain(i18n.t("AI 诊断（未启用）"));
    // 右侧：方案与风险、审批、历史与回滚。
    expect(text()).toContain("没有备份");
    expect(text()).toContain("提升版本会切流量");
    expect(text()).toContain(i18n.t("历史与回滚"));
    expect(text()).toContain("v1.1");
  });

  it("没有已连接的会话时不允许开始部署", async () => {
    await render({ sessionId: null });
    const start = findButton(i18n.t("开始部署"));
    expect(start).toBeTruthy();
    expect(start?.disabled).toBe(true);
    expect(text()).toContain(i18n.t("没有已连接的 SSH 会话：请先连接终端"));
  });

  it("确认节点会把节点 key 与会话一起交给后端", async () => {
    approveMock.mockResolvedValue(detail);
    await render({ sessionId: "sess-1" });
    const confirm = findButton(i18n.t("确认并继续"));
    await act(async () => {
      confirm?.click();
      await flush();
    });
    expect(approveMock).toHaveBeenCalledWith("run-1", "write_nginx_config", "sess-1");
  });
});
