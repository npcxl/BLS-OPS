/**
 * P5.6 部署向导测试。
 *
 * 重点钉两件事：
 * 1. **当前步骤由后端状态派生**（刷新 / 切标签回来都不丢进度）；
 * 2. 界面只调用**已经落地**的命令，不伪造分析进度。
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import "@/i18n";

const listMock = vi.fn();
const createMock = vi.fn();
const analyzeMock = vi.fn();
const answerMock = vi.fn();

vi.mock("@/api/ops-api", () => ({
  toErrorMessage: (cause: unknown) => String(cause),
  opsApi: {
    deploymentSessionList: (...args: unknown[]) => listMock(...args),
    deploymentSessionCreate: (...args: unknown[]) => createMock(...args),
    deploymentSessionAnalyze: (...args: unknown[]) => analyzeMock(...args),
    deploymentSessionAnswer: (...args: unknown[]) => answerMock(...args),
    // 向导当前不会调用下面这些，但 mock 必须列全（组件绕过 opsApi 直接 invoke 就会崩）。
    deploymentSessionGet: async () => null,
    deploymentSessionEvents: async () => [],
    deploymentSessionAsk: async () => null,
    deploymentSessionConfirmAndStart: async () => {
      throw new Error("not used in this test");
    },
  },
}));

import { i18n } from "@/i18n";
import { DeploymentWizard, isFinished, stepForStatus } from "../views/deploy/deployment-wizard";
import type { DeploymentSession, SessionStatus } from "@/api/types/deployment";

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.clearAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function session(overrides: Partial<DeploymentSession> = {}): DeploymentSession {
  return {
    id: "session-1",
    source_snapshot_id: null,
    application_id: null,
    environment_id: null,
    server_id: "srv-1",
    user_description: "前后端分离",
    status: "created",
    current_question: null,
    proposal_id: null,
    plan_id: null,
    run_id: null,
    input_fingerprint: "",
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DeploymentWizard servers={[{ id: "srv-1", name: "web-01" }]} />);
  });
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await tick();
    });
  }
}

function text(): string {
  return document.body.textContent ?? "";
}

function testId(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

describe("步骤派生", () => {
  it("当前步骤只由后端状态与 plan/run 决定", () => {
    expect(stepForStatus(null, false, false)).toBe("source");
    expect(stepForStatus("created", false, false)).toBe("source");
    expect(stepForStatus("importing", false, false)).toBe("analyzing");
    expect(stepForStatus("analyzing", false, false)).toBe("analyzing");
    expect(stepForStatus("needs_input", false, false)).toBe("questions");
    expect(stepForStatus("draft_ready", true, false)).toBe("plan");
    // 有 run 就一定落在执行页（哪怕状态还没刷新）。
    expect(stepForStatus("deploying", true, true)).toBe("execute");
    expect(stepForStatus("succeeded", true, true)).toBe("execute");
  });

  it("终态判定覆盖四种结束情况", () => {
    for (const status of ["succeeded", "failed", "rolled_back", "cancelled"] as SessionStatus[]) {
      expect(isFinished(status)).toBe(true);
    }
    for (const status of ["created", "analyzing", "draft_ready", "deploying"] as SessionStatus[]) {
      expect(isFinished(status)).toBe(false);
    }
  });
});

describe("部署向导", () => {
  it("默认落在来源步骤，并显示全部七个步骤", async () => {
    listMock.mockResolvedValue([]);
    await render();

    for (const id of [
      "wizard-step-source",
      "wizard-step-target",
      "wizard-step-describe",
      "wizard-step-analyzing",
      "wizard-step-questions",
      "wizard-step-plan",
      "wizard-step-execute",
    ]) {
      expect(testId(id), id).toBeTruthy();
    }
    expect(testId("wizard-step-source")?.getAttribute("data-state")).toBe("current");
    expect(text()).toContain(i18n.t("Deployment wizard"));
  });

  it("挂载时接上未完成的会话（刷新不丢进度）", async () => {
    listMock.mockResolvedValue([
      session({ status: "needs_input", user_description: "峰值 100 QPS" }),
    ]);
    await render();
    expect(listMock).toHaveBeenCalled();
    // 步骤由**后端状态**决定：直接落在"追问"，而不是从头开始。
    expect(testId("wizard-step-questions")?.getAttribute("data-state")).toBe("current");
    expect(text()).toContain("session-1".slice(0, 8));
  });

  it("已结束的会话不会被当成进行中的进度", async () => {
    listMock.mockResolvedValue([session({ status: "succeeded" })]);
    await render();
    expect(testId("wizard-step-source")?.getAttribute("data-state")).toBe("current");
  });

  it("创建会话需要先写需求描述", async () => {
    listMock.mockResolvedValue([]);
    createMock.mockResolvedValue(session());
    // 创建后紧接着就是分析（后端跑，前端只等结果）。
    analyzeMock.mockResolvedValue(session({ status: "analyzing" }));
    await render();

    // 来源 → 目标 → 描述：本地阶段推进。
    for (let step = 0; step < 2; step += 1) {
      await act(async () => {
        (testId("wizard-next") as HTMLButtonElement).click();
        await tick();
      });
    }
    expect(testId("wizard-step-describe")?.getAttribute("data-state")).toBe("current");

    // 空描述时按钮禁用。
    const start = testId("wizard-start") as HTMLButtonElement | null;
    expect(start).toBeTruthy();
    expect(start?.disabled).toBe(true);

    const textarea = testId("wizard-description") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Docker + Nginx + HTTPS");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });

    await act(async () => {
      (testId("wizard-start") as HTMLButtonElement).click();
      await tick();
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ userDescription: "Docker + Nginx + HTTPS" }),
    );
  });

  it("阻塞问题展示原问题，提交回答后回到分析", async () => {
    listMock.mockResolvedValue([
      session({
        status: "needs_input",
        current_question: {
          id: "q1",
          kind: "domain",
          question: "域名是什么？",
          options: ["暂不绑定"],
        },
      }),
    ]);
    answerMock.mockResolvedValue(session({ status: "analyzing" }));
    await render();

    expect(testId("wizard-question")?.textContent).toBe("域名是什么？");

    const input = testId("wizard-answer") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "shop.example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      (testId("wizard-answer-submit") as HTMLButtonElement).click();
      await tick();
    });

    expect(answerMock).toHaveBeenCalledWith("session-1", "q1", "shop.example.com");
    expect(testId("wizard-step-analyzing")?.getAttribute("data-state")).toBe("current");
  });

  it("分析步骤如实标注接线中，不伪造进度", async () => {
    listMock.mockResolvedValue([session({ status: "analyzing" })]);
    await render();
    expect(text()).toContain(
      i18n.t(
        "Analyzing the project and drafting a plan; nothing is deployed in this step.",
      ),
    );
  });

  it("方案步骤强调高风险仍需人工批准", async () => {
    listMock.mockResolvedValue([
      session({ status: "draft_ready", plan_id: "plan-9", input_fingerprint: "fp-1" }),
    ]);
    await render();
    expect(text()).toContain(
      i18n.t(
        "High-risk steps still need your explicit approval; the AI can never approve for you.",
      ),
    );
    expect(text()).toContain("plan-9");
  });
});