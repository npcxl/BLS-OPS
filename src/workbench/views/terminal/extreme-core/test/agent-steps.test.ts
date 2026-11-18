import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentStep } from "@/api/types/agent";
import {
  agentSummary,
  cardFromAgent,
  kindOfSteps,
  mergeAgentStep,
  riskLabel,
  stepTitle,
  toDeploySteps,
  type Translate,
} from "../agent-steps";

/** 极简翻译：把 `{{name}}` 换成参数值，key 原样返回。 */
const t: Translate = (key, options) => {
  if (!options) return key;
  return key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
};

let clock = 1_700_000_000_000;
const at = () => (clock += 1000);

function started(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    taskId: "task-1",
    kind: "step_started",
    stepIndex: 0,
    callId: "call-0-0",
    tool: "run_shell",
    command: "uname -a",
    risk: "read",
    state: "running",
    cwd: "/root",
    ...overrides,
  };
}

function finished(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    ...started(),
    kind: "tool_finished",
    state: "success",
    stdout: "Linux web-01\n",
    exitCode: 0,
    ...overrides,
  } as AgentEvent;
}

describe("Agent 事件合并", () => {
  it("开始 → 增量 → 结束都落在同一个 index 上", () => {
    let steps: AgentStep[] = [];
    steps = mergeAgentStep(steps, started());
    expect(steps).toHaveLength(1);
    expect(steps[0].state).toBe("running");

    steps = mergeAgentStep(steps, {
      taskId: "task-1",
      kind: "tool_output",
      stepIndex: 0,
      stdout: "Linux ",
    });
    steps = mergeAgentStep(steps, {
      taskId: "task-1",
      kind: "tool_output",
      stepIndex: 0,
      stdout: "web-01\n",
    });
    expect(steps[0].stdout).toBe("Linux web-01\n");

    steps = mergeAgentStep(steps, finished());
    expect(steps[0].state).toBe("success");
    expect(steps[0].exitCode).toBe(0);
    expect(steps[0].stdout).toBe("Linux web-01\n");
  });

  it("不同 index 各自独立，迟到的事件不会覆盖新步骤", () => {
    let steps = mergeAgentStep([], started());
    steps = mergeAgentStep(steps, started({ stepIndex: 1, callId: "call-0-1", command: "df -h" }));
    steps = mergeAgentStep(steps, finished({ stepIndex: 1, stdout: "/dev/sda1 40G\n" }));
    steps = mergeAgentStep(
      steps,
      started({ stepIndex: 0, state: "failed", risk: "write", command: "rm -f /tmp/x" }),
    );
    expect(steps.map((step) => step.command)).toEqual(["rm -f /tmp/x", "df -h"]);
    expect(steps[0].state).toBe("failed");
    expect(steps[1].state).toBe("success");
    expect(steps[1].stdout).toContain("/dev/sda1");
  });

  it("等待确认的步骤保留命令与影响说明", () => {
    const steps = mergeAgentStep(
      [],
      started({
        kind: "approval_required",
        state: "waiting",
        risk: "danger",
        tool: "run_shell",
        command: "sudo systemctl restart nginx",
        impact: "以 root 权限执行",
      }),
    );
    expect(steps[0].state).toBe("waiting");
    expect(steps[0].impact).toBe("以 root 权限执行");
    expect(steps[0].risk).toBe("danger");
  });

  it("没有 stepIndex 的事件直接忽略", () => {
    expect(mergeAgentStep([], { taskId: "task-1", kind: "finished" })).toEqual([]);
  });
});

describe("步骤标题与卡片", () => {
  const readStep = mergeAgentStep([], finished());
  const writeStep = mergeAgentStep(
    [],
    finished({
      stepIndex: 1,
      tool: "write_file",
      risk: "write",
      path: "/var/www/app/index.html",
      command: "printf %s 'PGgxPg==' | base64 -d > /var/www/app/index.html",
      backupPath: "/var/www/app/index.html.bls-bak.7",
      rollback: "cp -a '/var/www/app/index.html.bls-bak.7' '/var/www/app/index.html'",
      state: "success",
    }),
  );

  it("命令本身就是标题，write_file 用路径", () => {
    expect(stepTitle(readStep[0], t)).toBe("uname -a");
    expect(stepTitle(writeStep[0], t)).toBe("写入 /var/www/app/index.html");
    expect(riskLabel("danger", t)).toBe("危险");
  });

  it("write_file 的命令体不展示（base64 会刷屏），备份与回滚保留", () => {
    const [step] = toDeploySteps(writeStep, t);
    expect(step.kind).toBe("tool");
    expect(step.command).toBeUndefined();
    expect(step.backupPath).toBe("/var/www/app/index.html.bls-bak.7");
    expect(step.rollback).toContain("cp -a");
    expect(step.state).toBe("success");
    expect(step.risk).toBe("write");
  });

  it("待确认的那一步在操作链上只留摘要，不重复卡片里的命令", () => {
    const steps = mergeAgentStep(
      [],
      started({
        kind: "approval_required",
        state: "waiting",
        risk: "write",
        command: "nginx -t && nginx -s reload",
        summary: "重载 Nginx",
        impact: "改完配置后重载，连接会短暂中断",
      }),
    );
    const [step] = toDeploySteps(steps, t);
    expect(step.title).toBe("重载 Nginx");
    expect(step.command).toBeUndefined();
    expect(step.detail).toContain("在下方确认后才会执行");
  });

  it("实际执行脚本单独带出，主命令仍是可读的那条", () => {
    const steps = mergeAgentStep(
      [],
      finished({
        command: "ls -la /var/www",
        script: "if ! cd /root; then exit 98; fi\nls -la /var/www\n__bls_rc=$?",
      }),
    );
    const [step] = toDeploySteps(steps, t);
    expect(step.command).toBe("ls -la /var/www");
    expect(step.script).toContain("__bls_rc");
  });

  it("只读步骤是检测任务，有写入就是自动化任务（风险辅助判断）", () => {
    expect(kindOfSteps(readStep)).toBe("probe");
    expect(kindOfSteps(writeStep)).toBe("automation");
  });

  it("卡片类型按用户目标判断，不按步骤风险反推", () => {
    const query = cardFromAgent({
      taskId: "task-q",
      server: "prod",
      sessionId: "ssh-1",
      goal: "查一下当前跑了哪些服务",
      // 即使中间有一步写入，用户目标仍是查询。
      steps: writeStep,
      status: "success",
      t,
      now: at(),
    });
    expect(query.kind).toBe("query");

    const auto = cardFromAgent({
      taskId: "task-a",
      server: "prod",
      sessionId: "ssh-1",
      goal: "重启 nginx",
      steps: readStep,
      status: "success",
      t,
      now: at(),
    });
    expect(auto.kind).toBe("automation");
  });

  it("卡片状态：等待确认 / 完成 / 失败 / 停止", () => {
    const waiting = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      originMessageId: "msg-1",
      goal: "看看这台机器",
      steps: mergeAgentStep([], started({ kind: "approval_required", state: "waiting", risk: "write" })),
      status: "waiting",
      t,
      now: at(),
    });
    expect(waiting.status).toBe("confirming");
    expect(waiting.result).toContain("等待你确认");

    const done = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      originMessageId: "msg-1",
      goal: "看看这台机器",
      steps: readStep,
      status: "success",
      t,
      now: at(),
    });
    expect(done.status).toBe("done");
    expect(done.result).toBe("已完成 1 步");
    // 类型看用户目标（"看看…" = 查询）；步骤全是只读不再强制归成检测。
    expect(done.kind).toBe("query");

    const failed = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      goal: "改文件",
      steps: mergeAgentStep([], finished({ state: "failed", stderr: "Permission denied" })),
      status: "failed",
      error: "第 1 步失败",
      t,
      now: at(),
    });
    expect(failed.status).toBe("failed");
    expect(failed.result).toBe("第 1 步失败");

    const cancelled = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      goal: "改文件",
      steps: writeStep,
      status: "cancelled",
      t,
      now: at(),
    });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.result).toContain("已停止");
  });

  it("快照说 running、但有一步在等确认时按「等你确认」显示", () => {
    const steps = mergeAgentStep(
      [],
      started({ kind: "approval_required", state: "waiting", risk: "write" }),
    );
    const card = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      originMessageId: "msg-1",
      goal: "重启 nginx",
      steps,
      status: "running",
      t,
      now: at(),
    });
    expect(card.status).toBe("confirming");
    expect(card.result).toContain("等待你确认");
  });

  it("沿用已有卡片的来源消息、名称与创建时间", () => {
    const existing = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      originMessageId: "msg-1",
      goal: "原始目标",
      steps: [],
      status: "running",
      t,
      now: 1000,
    });
    const next = cardFromAgent({
      taskId: "task-1",
      server: "prod",
      sessionId: "ssh-1",
      originMessageId: "msg-2",
      goal: "新目标",
      steps: readStep,
      status: "success",
      existing: { ...existing, title: "自定义名字" },
      t,
      now: 5000,
    });
    expect(next.originMessageId).toBe("msg-1");
    expect(next.title).toBe("自定义名字");
    expect(next.goal).toBe("原始目标");
    expect(next.createdAt).toBe(1000);
    expect(next.updatedAt).toBe(5000);
  });
});

describe("一句话结论", () => {
  it("失败时说清第几步、什么错", () => {
    const steps = mergeAgentStep(
      [],
      finished({ stepIndex: 2, state: "failed", stderr: "bash: nginx: command not found" }),
    );
    expect(agentSummary(steps, "failed", undefined, t)).toBe(
      "第 3 步失败：bash: nginx: command not found",
    );
  });

  it("运行中显示正在执行的命令", () => {
    const steps = mergeAgentStep([], started());
    expect(agentSummary(steps, "running", null, t)).toBe("正在执行：uname -a");
  });
});
