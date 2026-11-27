import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { ExtremeMessage } from "@/stores/extreme-store";
import { MessageList } from "../MessageList";
import type { DeployStep } from "../deploy-plan";
import type { MessagePart } from "../message-parts";
import type { TaskCardModel } from "../task-view";
import type { ApprovalEntry } from "../view/types";

function taskOf(steps: DeployStep[]): TaskCardModel {
  return {
    id: "task-1",
    source: "agent",
    kind: "probe",
    title: "server · 检测",
    goal: "检查 nginx",
    status: "running",
    result: "",
    server: "server",
    sessionId: "session-1",
    createdAt: 1,
    updatedAt: 1,
    steps,
    artifacts: [],
  };
}

function stepOf(overrides: Partial<DeployStep> = {}): DeployStep {
  return {
    id: "agent-0",
    kind: "tool",
    title: "检查 Nginx 配置",
    detail: "",
    command: "nginx -t",
    state: "success",
    exitCode: 0,
    stdout: "syntax is ok\n",
    elapsedMs: 1200,
    ...overrides,
  };
}

async function render(
  messages: ExtremeMessage[],
  input: {
    asking?: boolean;
    steps?: DeployStep[];
    approvals?: Record<string, ApprovalEntry>;
  } = {},
) {
  const holder = document.body.appendChild(document.createElement("div"));
  const root = createRoot(holder);
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const tree = (
    <MessageList
      messages={messages}
      asking={input.asking ?? false}
      tasks={{ "task-1": taskOf(input.steps ?? [stepOf()]) }}
      approvals={input.approvals}
    />
  );
  await act(async () => root.render(tree));
  return {
    holder,
    rerender: async (next: typeof tree) => act(async () => root.render(next)),
    cleanup: async () => {
      await act(async () => root.unmount());
      holder.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("renders the AI question card inline after its prose", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const questionPart: MessagePart = {
    kind: "question",
    id: "question-q1",
    taskId: "task-1",
    question: {
      questionId: "q1",
      taskId: "task-1",
      workspaceId: "w",
      serverId: null,
      question: "查哪个环境？",
      kind: "single",
      options: [{ id: "prod", label: "生产" }],
      allowCustom: true,
      deadline: Date.now() + 60_000,
    },
    status: "pending",
    draftSelected: [],
    draftCustom: "",
    draftCustomActive: false,
    answer: null,
    error: null,
  };
  const view = await render([
    {
      id: "m-question",
      role: "assistant",
      text: "需要你确认一下。",
      parts: [
        { kind: "text", id: "text-1", text: "需要你确认一下。" },
        questionPart,
      ],
    },
  ]);
  try {
    expect(view.holder.textContent).toContain("查哪个环境？");
    expect(view.holder.textContent).toContain("生产");
    expect(view.holder.querySelector('[data-testid="question-submit"]')).toBeTruthy();
    await view.rerender(
      <MessageList
        messages={[{ id: "m-question", role: "assistant", text: "", parts: [questionPart] }]}
        asking
        tasks={{ "task-1": taskOf([stepOf()]) }}
      />,
    );
    expect(view.holder.querySelector('[data-testid="question-submit"]')).toBeTruthy();
    expect(view.holder.querySelector('[data-testid="extreme-thinking"]')).toBeNull();
  } finally {
    await view.cleanup();
    await i18n.changeLanguage(language);
  }
});

it("renders prose → command → prose in the order they happened", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const view = await render([
    {
      id: "reply",
      role: "assistant",
      taskId: "task-1",
      text: "我先检查 Nginx 配置发现端口没有监听结论是 nginx 没启动",
      parts: [
        { kind: "text", id: "t1", text: "我先检查 Nginx 配置。" },
        { kind: "step", id: "s0", taskId: "task-1", stepIndex: 0, label: "检查 Nginx 配置" },
        { kind: "text", id: "t2", text: "发现 80 端口没有监听，结论是 nginx 没启动。" },
      ],
    },
  ]);
  try {
    const text = view.holder.textContent ?? "";
    const first = text.indexOf("我先检查 Nginx 配置");
    const command = text.indexOf("检查 Nginx 配置");
    const after = text.indexOf("发现 80 端口没有监听");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(command).toBeGreaterThan(first);
    expect(after).toBeGreaterThan(command);
    // 折叠行：操作名 + 状态 + 耗时；命令与输出在展开里。
    const row = view.holder.querySelector("[data-step-part]");
    expect(row?.textContent).toContain("检查 Nginx 配置");
    expect(row?.textContent).toContain("已完成");
    expect(row?.textContent).toContain("1 秒");
    expect(row?.textContent).not.toContain("nginx -t");
    // 常驻的「正在使用工具 · N 次」与重复的「仍在执行」都不再出现。
    expect(text).not.toContain("正在使用工具");
    expect(text).not.toContain("仍在执行");
  } finally {
    await view.cleanup();
    await i18n.changeLanguage(language);
  }
});

it("shows one stage hint: running row, then '整理结果', hidden once prose starts", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const parts: MessagePart[] = [
    { kind: "text", id: "t1", text: "我先检查 Nginx 配置。" },
    { kind: "step", id: "s0", taskId: "task-1", stepIndex: 0, label: "检查 Nginx 配置" },
  ];
  const message: ExtremeMessage = {
    id: "reply",
    role: "assistant",
    taskId: "task-1",
    text: "我先检查 Nginx 配置。",
    parts,
  };
  const view = await render([message], {
    asking: true,
    steps: [stepOf({ state: "running" })],
  });
  try {
    expect(view.holder.textContent).toContain("运行中");
    expect(view.holder.textContent).not.toContain("正在整理结果");

    // 命令结束、模型还没开始写：只留一行轻量提示。
    await view.rerender(
      <MessageList
        messages={[message]}
        asking
        tasks={{ "task-1": taskOf([stepOf({ state: "success" })]) }}
      />,
    );
    // 提示延迟 200ms 出现（避免快命令闪一下），等过阈值再断言。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 240));
    });
    expect(view.holder.textContent).toContain("正在整理结果");
    expect(view.holder.textContent).not.toContain("运行中");

    // 正文一开始长，提示就收起。
    const withProse: ExtremeMessage = {
      ...message,
      text: "我先检查 Nginx 配置。端口没有监听，",
      parts: [
        ...parts,
        { kind: "text", id: "t2", text: "端口没有监听，" },
      ],
    };
    await view.rerender(
      <MessageList
        messages={[withProse]}
        asking
        tasks={{ "task-1": taskOf([stepOf({ state: "success" })]) }}
      />,
    );
    expect(view.holder.textContent).not.toContain("正在整理结果");
  } finally {
    await view.cleanup();
    await i18n.changeLanguage(language);
  }
});

it("keeps the approval on its own step and shows '未执行' after a denial", async () => {
  const language = i18n.language;
  await i18n.changeLanguage("zh-CN");
  const approval: ApprovalEntry = {
    approval: {
      taskId: "task-1",
      callId: "call-1",
      stepIndex: 0,
      tool: "run_shell",
      server: "server",
      risk: "write",
      command: "systemctl restart nginx",
      summary: "重启服务 nginx",
      impact: "停止系统服务",
      cwd: "/root",
    },
    phase: "pending",
    failure: null,
    closed: false,
  };
  const message: ExtremeMessage = {
    id: "reply",
    role: "assistant",
    taskId: "task-1",
    text: "重启之前先确认一下。",
    parts: [
      { kind: "text", id: "t1", text: "重启之前先确认一下。" },
      { kind: "step", id: "s0", taskId: "task-1", stepIndex: 0, label: "重启服务 nginx" },
    ],
  };
  const view = await render([message], {
    steps: [stepOf({ state: "waiting", command: "systemctl restart nginx" })],
    approvals: { "task-1:call-1": approval },
  });
  try {
    // 确认入口就在这一步里面，而不是输入框上方。
    const inline = view.holder.querySelector('[data-step-part] [data-testid="agent-approval"]');
    expect(inline).not.toBeNull();
    expect(inline?.textContent).toContain("重启服务 nginx");

    // 拒绝后：原地「未执行」，不显示成执行失败。
    const denied: ExtremeMessage = {
      ...message,
      parts: [
        { kind: "text", id: "t1", text: "重启之前先确认一下。" },
        {
          kind: "step",
          id: "s0",
          taskId: "task-1",
          stepIndex: 0,
          label: "重启服务 nginx",
          denied: true,
        },
      ],
    };
    await view.rerender(
      <MessageList
        messages={[denied]}
        asking={false}
        tasks={{
          "task-1": taskOf([
            stepOf({
              state: "failed",
              command: "systemctl restart nginx",
              stderr: "用户拒绝执行这条命令",
            }),
          ]),
        }}
        approvals={{
          "task-1:call-1": { ...approval, phase: "denied", closed: true },
        }}
      />,
    );
    expect(view.holder.textContent).toContain("未执行");
    expect(view.holder.textContent).not.toContain("用户拒绝执行这条命令");
  } finally {
    await view.cleanup();
    await i18n.changeLanguage(language);
  }
});
