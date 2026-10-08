/**
 * P5.2 方案面板测试。
 *
 * 三条产品承诺必须在界面上看得见：
 *
 * 1. **未就绪就没有确认按钮**（`ready = false` 时只给问题，不给"执行"）；
 * 2. **事实 / 推断 / 建议分开显示**（证据等级直接来自后端）；
 * 3. **没配置提供方就说"AI 未启用"**，不用模板文案假装分析过。
 *
 * 与其它部署测试同一套约定：mock 里只列 opsApi 上真实存在的方法，
 * 组件一旦绕过 opsApi 直接 `invoke` 就会崩。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

const generateMock = vi.fn();
const confirmMock = vi.fn(async (_id: string) => ({
  plan: { id: "plan-1" },
  nodes: [],
  edges: [],
}));

vi.mock("@/api/ops-api", () => ({
  toErrorMessage: (cause: unknown) => String(cause),
  opsApi: {
    deploymentPolicyGet: async () => ({
      require_health_check: true,
      require_https: true,
      require_backup_for_production: true,
      forbid_secrets_in_artifact: true,
      allow_root_service: false,
      production_requires_approval: true,
      require_rollback_plan: true,
      min_headroom_percent: 30,
      allowed_ports: [],
      allow_privileged_containers: false,
      notes: "",
    }),
    deploymentPolicySave: async (_id: string, policy: unknown) => policy,
    deploymentCapacityGet: async () => null,
    deploymentCapacitySave: async (profile: unknown) => profile,
    deploymentProposalList: async () => [],
    deploymentProposalGenerate: (applicationId: string, environmentId?: string) => {
      generateMock(applicationId, environmentId);
      return Promise.resolve(current);
    },
    deploymentProposalConfirm: (id: string) => confirmMock(id),
    deploymentProposalReject: async () => current.proposal,
    deploymentProposalGet: async () => current.proposal,
    deploymentProposalDelete: async () => undefined,
    // P5.5：AI 复核区会问一次"有没有可用的提供方"。
    aiProviderList: async () => [],
    deploymentProposalAiReviewStatus: async () => null,
  },
}));

import { i18n } from "@/i18n";
import type { ProposalOutcome } from "@/api/types/deployment";
import { ProposalPanel } from "../proposal-panel";

type Fixture = ProposalOutcome;

/** 一份最小但完整的方案（只填界面真正读到的字段）。 */
function fixture(overrides: Partial<Fixture> = {}): Fixture {
  const base = {
    ready: true,
    approvable: true,
    open_questions: [],
    blockers: [],
    proposal: {
      id: "proposal-1",
      schema_version: "deployment-proposal/1",
      application_id: "app-1",
      environment_id: "env-1",
      server_id: "srv-1",
      status: "draft",
      summary: {
        headline: "Deploy 1 service(s) to prod on srv-1 using Static site behind Nginx",
        statements: [
          {
            id: "topo-recommended",
            text: "推荐 Nginx 托管静态站点",
            class: "inference",
            confidence: 75,
            impact: "decision",
            evidence: [
              { class: "fact", source: { kind: "server_fact", field: "deployment.nginx" }, detail: "deployment.nginx 已安装", reference: "deployment.nginx" },
            ],
          },
        ],
      },
      assumptions: [
        {
          id: "as-peak-factor",
          statement: "峰值流量约为平均流量的 3 倍。",
          class: "inference",
          evidence: [],
          if_wrong: "峰值更高时 CPU 会先打满。",
        },
      ],
      unknowns: [],
      recommended_topology: {
        id: "topology-static-site-behind-nginx",
        kind: "static_nginx",
        name: "Static site behind Nginx",
        description: "静态产物直接由 Nginx 托管",
        pros: ["deployment.nginx 已安装"],
        cons: [],
        complexity: 1,
        monthly_cost_hint: 30,
        feasible: true,
        blockers: [],
        service_names: ["web"],
        evidence: [],
      },
      alternative_topologies: [
        {
          id: "topology-docker-compose-stack",
          kind: "docker_compose",
          name: "Docker Compose stack",
          description: "整组服务交给一个 compose 项目",
          pros: [],
          cons: [],
          complexity: 3,
          monthly_cost_hint: null,
          feasible: false,
          blockers: ["服务器上没有 deployment.docker（实时事实）"],
          service_names: ["web"],
          evidence: [],
        },
      ],
      services: [
        {
          service_unit_id: "svc-web",
          name: "web",
          role: "static",
          service_kind: "static_nginx",
          runtime: { kind: "static_nginx", site_name: "web", root: "/opt/shop/web" },
          artifact_id: null,
          artifact_kind: null,
          deploy_path: "/opt/shop/web",
          ports: [{ host_port: 80, container_port: 80, protocol: "tcp" }],
          health_check: {
            kind: "http",
            target: "/",
            interval_seconds: 30,
            timeout_seconds: 5,
            failure_threshold: 3,
            evidence: [],
          },
          env_keys: [],
          resource_estimate: { cpu_cores: 1, memory_mb: 640, disk_mb: 1024, basis: "inference", evidence: [] },
          evidence: [],
        },
      ],
      dependencies: [],
      capacity_recommendation: {
        peak_qps: 80,
        peak_qps_basis: "fact",
        concurrent_users: 200,
        vcpu: 1,
        memory_mb: 640,
        disk_gb: 1,
        bandwidth_mbps: 3,
        headroom_percent: 40,
        monthly_cost_hint: 30,
        fits_on_server: true,
        assumptions: [],
        unknowns: [],
        evidence: [],
      },
      domains: [],
      workflow: {
        nodes: [
          {
            id: "check_dependencies",
            plan_id: "",
            node_key: "check_dependencies",
            title: "Check server dependencies",
            action: "check_dependencies",
            service_unit_id: null,
            risk_level: "low",
            approval_required: false,
            skippable: false,
            params_json: "{}",
            position: 0,
            created_at: 0,
            updated_at: 0,
          },
          {
            id: "activate_release",
            plan_id: "",
            node_key: "activate_release",
            title: "Activate the new release",
            action: "activate_release",
            service_unit_id: null,
            risk_level: "medium",
            approval_required: false,
            skippable: false,
            params_json: "{}",
            position: 1,
            created_at: 0,
            updated_at: 0,
          },
        ],
        edges: [],
        notes: [],
      },
      risks: [],
      approvals: [
        {
          id: "approval-production-deploy",
          node_key: null,
          reason: "这是生产类环境的部署，必须有人确认后才能执行。",
          required_role: "owner",
          required: true,
          evidence: [],
        },
      ],
      rollback_strategy: { automatic: true, steps: [], restores: ["previous release"], data_rollback: "外部托管", trigger: "任一变更类节点失败时触发" },
      knowledge_references: [],
      knowledge_conflicts: [],
      validation: {
        checks: [],
        violations: [
          {
            id: "v-risk-shop.example.com",
            kind: "risk",
            severity: "high",
            source: "risk",
            location: "shop.example.com",
            detail: "安全策略要求 HTTPS，但该域名没有配置证书",
            blocks_plan: false,
            blocks_approval: true,
          },
        ],
      },
      ai_review: null,
      inputs: {
        application_id: "app-1",
        application_kind: "full_stack",
        environment_id: "env-1",
        environment_kind: "production",
        server_id: "srv-1",
        service_count: 1,
        domain_count: 0,
        has_capability_profile: true,
        has_capacity_profile: true,
        domains: [],
        observed_resources: { cpu_cores: 8, memory_mb: 16384, disk_free_gb: 200 },
      },
      fingerprint: {
        engine_version: "p5.2-engine-1",
        schema_version: "deployment-proposal/1",
        model: null,
        prompt_version: "p5.2-prompt-1",
        knowledge_version: "kb-2026.09.1",
        input_hash: "a".repeat(64),
        output_hash: "b".repeat(64),
        generated_at: 1_700_000_000_000,
      },
      created_at: 1_700_000_000_000,
    },
  };
  return { ...base, ...overrides } as unknown as Fixture;
}

let current: Fixture = fixture();
let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  current = fixture();
  generateMock.mockClear();
  confirmMock.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      <ProposalPanel
        applicationId="app-1"
        environmentId="env-1"
        sessionId={null}
        onConfirmed={() => undefined}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function generate() {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === i18n.t("Generate proposal"),
  );
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function button(text: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe("部署方案面板", () => {
  it("展示需求问卷；没有方案时说明还没有生成方案，不伪造 AI 评价", async () => {
    await render();
    expect(document.body.textContent).toContain(i18n.t("Requirements"));
    expect(document.body.textContent).toContain(i18n.t("Daily active users"));
    // P5.5.1："还没有方案"与"没配 Provider"是两件事 —— 这里说前者。
    expect(document.body.textContent).toContain(i18n.t("No proposal generated yet"));
    expect(document.body.textContent).not.toContain(i18n.t("AI not configured"));
    // 绝不显示伪造的 AI 评价。
    expect(document.body.textContent).not.toContain("AI 已分析");
  });

  it("就绪的方案给出推荐、备选、指纹与确认入口", async () => {
    await render();
    await generate();

    expect(generateMock).toHaveBeenCalledWith("app-1", "env-1");
    expect(document.body.textContent).toContain("Static site behind Nginx");
    // 备选方案用 i18n 译名渲染（形态名是英文 key）。
    expect(document.body.textContent).toContain(i18n.t("Docker Compose stack"));
    expect(document.body.textContent).toContain(i18n.t("Not feasible here"));
    expect(document.body.textContent).toContain("服务器上没有 deployment.docker（实时事实）");
    // 指纹：输入/输出哈希与知识库版本都要能看到（审计要求）。
    expect(document.body.textContent).toContain("aaaaaaaaaaaa");
    expect(document.body.textContent).toContain("kb-2026.09.1");
    // 推断与依据：等级徽标与证据文本都在。
    expect(document.body.textContent).toContain(i18n.t("Inference"));
    expect(document.body.textContent).toContain("deployment.nginx 已安装");

    const confirm = button(i18n.t("Confirm proposal"));
    expect(confirm).toBeTruthy();
    expect(confirm?.disabled).toBe(false);
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });
    expect(confirmMock).toHaveBeenCalledWith("proposal-1");
  });

  it("未就绪时只给问题与阻塞项，不给确认按钮", async () => {
    current = fixture({
      ready: false,
      approvable: false,
      open_questions: [
        {
          id: "q-environment",
          question: "这个应用还没有环境（部署到哪台机器、哪个根目录）。",
          why_it_matters: "服务目录、域名与容量都以环境为边界。",
          severity: "blocks_plan",
          suggested_default: "先建一个环境并填部署根目录",
          evidence: [],
        },
      ],
    });
    // 未就绪的方案：后端把工作流清空。
    (current.proposal as unknown as { workflow: { nodes: unknown[] } }).workflow.nodes = [];
    await render();
    await generate();

    expect(document.body.textContent).toContain("这个应用还没有环境");
    expect(document.body.textContent).toContain(i18n.t("Blocks the plan"));
    expect(document.body.textContent).toContain(
      i18n.t("This proposal is not ready: answer the open questions and fix the blockers first."),
    );
    // 工作流为空时明确指出"尚无可执行计划"。
    expect(document.body.textContent).toContain(i18n.t("No executable plan yet"));
    expect(button(i18n.t("Confirm proposal"))?.disabled).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("校验违规按类型展示，且需要审批的动作带审批标记", async () => {
    await render();
    await generate();
    expect(document.body.textContent).toContain(i18n.t("Risk"));
    expect(document.body.textContent).toContain("shop.example.com");
    expect(document.body.textContent).toContain(i18n.t("Approval required"));
  });
});
