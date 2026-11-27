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
    kind: "tool_started",
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

  it("不同 index 各自独立，迟到的事件不会覆盖旧步骤", () => {
    let steps = mergeAgentStep([], started());
    steps = mergeAgentStep(steps, finished({ stepIndex: 0, stdout: "Linux web-01\n" }));
    steps = mergeAgentStep(steps, started({ stepIndex: 1, callId: "call-0-1", command: "df -h" }));
    steps = mergeAgentStep(steps, finished({ stepIndex: 1, stdout: "/dev/sda1 40G\n" }));
    steps = mergeAgentStep(
      steps,
      started({ stepIndex: 2, callId: "call-0-2", state: "failed", risk: "write", command: "rm -f /tmp/x" }),
    );
    expect(steps.map((step) => step.command)).toEqual(["uname -a", "df -h", "rm -f /tmp/x"]);
    expect(steps[0].state).toBe("success");
    expect(steps[1].state).toBe("success");
    expect(steps[1].stdout).toContain("/dev/sda1");
    expect(steps[2].state).toBe("failed");
  });

  it("终态之后到达的开始 / 输出 / 非终态完成事件不能把步骤改回运行中", () => {
    let steps = mergeAgentStep([], started());
    steps = mergeAgentStep(steps, finished({ stdout: "done\n" }));
    // 重复 / 乱序的 tool_started：命令与状态都不该被改写。
    steps = mergeAgentStep(steps, started({ state: "running", command: "rm -f /tmp/x" }));
    expect(steps[0].state).toBe("success");
    expect(steps[0].command).toBe("uname -a");
    // 迟到的增量不能追加到已完成输出后面。
    steps = mergeAgentStep(steps, {
      taskId: "task-1",
      kind: "tool_output",
      stepIndex: 0,
      stdout: "late chunk",
    });
    expect(steps[0].stdout).toBe("done\n");
    // 不合法的"完成但仍运行"事件也不能回退状态。
    steps = mergeAgentStep(steps, finished({ state: "running" }));
    expect(steps[0].state).toBe("success");
  });

  it("子任务服务器、依赖与待核实标记跟到卡片历史", () => {
    const steps = mergeAgentStep(
      [],
      finished({
        tool: "child_agent",
        groupId: "children-0",
        server: "test",
        serverId: "srv-b",
        childId: "memory",
        stale: true,
      }),
    );
    const card = toDeploySteps(steps, t)[0];
    expect(card.server).toBe("test");
    expect(card.serverId).toBe("srv-b");
    expect(card.childId).toBe("memory");
    expect(card.stale).toBe(true);
    // JSON 落盘 / 恢复不能丢掉这些身份字段。
    expect(JSON.parse(JSON.stringify(card))).toMatchObject({
      server: "test",
      serverId: "srv-b",
      childId: "memory",
      stale: true,
    });
  });

  it("并行子任务的迟到开始事件不会覆盖终态", () => {
    let steps = mergeAgentStep([], started({ kind: "tool_started", groupId: "children-2", state: "pending" }));
    steps = mergeAgentStep(steps, started({ kind: "tool_started", groupId: "children-2", state: "running" }));
    steps = mergeAgentStep(steps, started({ kind: "tool_started", groupId: "children-2", state: "pending" }));
    expect(steps[0].state).toBe("running");
    steps = mergeAgentStep(steps, finished({ groupId: "children-2", state: "success" }));
    steps = mergeAgentStep(steps, started({ kind: "tool_started", groupId: "children-2", state: "running" }));
    expect(steps[0].state).toBe("success");
    expect(toDeploySteps(steps, t)[0].groupId).toBe("children-2");
  });

  it("子任务的估算用量与来源跟随事件及历史卡片", () => {
    const usage = { requests: 2, inputTokens: 1000, outputTokens: 250 };
    const steps = mergeAgentStep([], finished({ tool: "child_agent", groupId: "children-0", childUsage: usage }));
    expect(steps[0].childUsage).toEqual(usage);
    const cardStep = toDeploySteps(steps, t)[0];
    expect(cardStep.sourceTool).toBe("child_agent");
    expect(cardStep.childUsage).toEqual(usage);
    expect(JSON.parse(JSON.stringify(cardStep)).childUsage).toEqual(usage);
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

describe("内部纠错 / 权限拦截的分类", () => {
  it("平台打回的命令落成内部调整，不是执行失败", () => {
    let steps = mergeAgentStep([], started({ state: "running" }));
    steps = mergeAgentStep(
      steps,
      finished({
        state: "skipped",
        category: "internal",
        stderr: "你声明这一步是只读，但命令里有写操作",
        exitCode: null,
      }),
    );
    expect(steps[0].category).toBe("internal");

    const [deploy] = toDeploySteps(steps, t);
    expect(deploy.category).toBe("internal");
    expect(deploy.state).toBe("skipped");
    // 说明"没发到服务器"，而不是把平台内部措辞写成标题。
    expect(deploy.detail).toContain("命令没有发到服务器");
    expect(deploy.detail).not.toContain("执行失败");
    // 真实原因仍保留在可展开的详情里（审计不丢）。
    expect(deploy.stderr).toContain("只读");
  });

  it("旧记录没有类别时按真实执行展示，不能当成内部纠错隐藏", () => {
    const legacy: AgentStep = {
      index: 0,
      callId: "call-0-0",
      tool: "run_shell",
      risk: "write",
      state: "failed",
      command: "systemctl restart nginx",
      stdout: "",
      stderr: "Job for nginx.service failed",
      cwd: "/root",
      truncated: false,
      elapsedMs: 10,
    };
    const [deploy] = toDeploySteps([legacy], t);
    expect(deploy.category).toBeUndefined();
    expect(deploy.state).toBe("failed");
    expect(deploy.stderr).toContain("failed");
  });

  it("未执行的原因用结构化代码说人话，不回显内部代码", () => {
    let steps = mergeAgentStep([], started({ state: "waiting", risk: "write" }));
    steps = mergeAgentStep(
      steps,
      finished({
        state: "skipped",
        category: "denied",
        blocked: "read_only",
        exitCode: null,
      }),
    );

    const [deploy] = toDeploySteps(steps, t);
    expect(deploy.blocked).toBe("read_only");
    expect(deploy.detail).toContain("只读模式");
    expect(deploy.detail).toContain("没有执行");
    // 代码本身不是给用户看的文案。
    expect(deploy.detail).not.toContain("read_only");
    expect(deploy.state).toBe("skipped");
  });

  it("未登记的代码只说未执行，不猜原因", () => {
    const [deploy] = toDeploySteps(
      [
        {
          index: 0,
          callId: "call-0-0",
          tool: "run_shell",
          risk: "write",
          state: "skipped",
          command: "systemctl restart nginx",
          stdout: "",
          stderr: "",
          cwd: "/root",
          truncated: false,
          elapsedMs: 0,
          category: "denied",
          blocked: "something_new",
        },
      ],
      t,
    );
    expect(deploy.detail).toContain("未执行（权限或确认拦住）");
    expect(deploy.detail).not.toContain("something_new");
  });

  it("成功步数 / 失败定位只算真正执行过的步骤", () => {
    let steps = mergeAgentStep([], started({ state: "running" }));
    steps = mergeAgentStep(
      steps,
      finished({ state: "skipped", category: "internal", exitCode: null }),
    );
    steps = mergeAgentStep(
      steps,
      started({ stepIndex: 1, callId: "call-0-1", command: "uname -a" }),
    );
    steps = mergeAgentStep(steps, finished({ stepIndex: 1 }));

    expect(agentSummary(steps, "success", null, t)).toBe("已完成 1 步");
    // 内部纠错的 write 不该把任务归成"自动化"。
    expect(kindOfSteps(steps)).toBe("probe");
  });
});
