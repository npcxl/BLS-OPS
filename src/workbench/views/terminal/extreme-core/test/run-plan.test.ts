import { describe, expect, it } from "vitest";
import {
  canContinue,
  headlineFor,
  mergeSteps,
  normalizeStepState,
  shouldPlan,
  stepsFromExecution,
  type RunStep,
} from "../run-plan";

const step = (patch: Partial<RunStep> & { id: string }): RunStep => ({
  title: patch.id,
  state: "pending",
  ...patch,
});

describe("步骤状态", () => {
  it("两套来源都归一（deploy 的 success 与 agent 的 done 都是完成）", () => {
    expect(normalizeStepState("success")).toBe("done");
    expect(normalizeStepState("done")).toBe("done");
    expect(normalizeStepState("running")).toBe("running");
    expect(normalizeStepState("failed")).toBe("failed");
    expect(normalizeStepState("cancelled")).toBe("skipped");
    expect(normalizeStepState(undefined)).toBe("pending");
  });
});

describe("要不要展开计划", () => {
  it("简单查询不展开", () => {
    expect(shouldPlan({ goal: "看下磁盘用了多少", steps: [] })).toBe(false);
    expect(
      shouldPlan({ goal: "看下磁盘用了多少", steps: [step({ id: "1", state: "done", command: "df -h" })] }),
    ).toBe(false);
  });

  it("步骤多、写操作多、或出现过审批都展开", () => {
    expect(
      shouldPlan({
        goal: "看看这台机器",
        steps: [step({ id: "1" }), step({ id: "2" }), step({ id: "3" })],
      }),
    ).toBe(true);
    expect(
      shouldPlan({
        goal: "看看这台机器",
        steps: [
          step({ id: "1", state: "done", command: "systemctl restart nginx" }),
          step({ id: "2", state: "done", command: "cp a b" }),
        ],
      }),
    ).toBe(true);
    expect(shouldPlan({ goal: "重启 nginx", steps: [], approvals: 1 })).toBe(true);
  });

  it("请求本身是发布/迁移这类规模词时，一开始就按计划对待", () => {
    for (const goal of [
      "更新 OPS 前端，检查域名和证书",
      "把旧库迁移到新实例",
      "发布灰度版本并回滚验证",
    ]) {
      expect(shouldPlan({ goal, steps: [] }), goal).toBe(true);
    }
    expect(shouldPlan({ goal: "nginx 版本是多少", steps: [] })).toBe(false);
  });
});

describe("结构化事件合并", () => {
  it("新步骤追加、同 id 覆盖证据", () => {
    const current = [step({ id: "a", title: "查目录", state: "done", evidence: "ok" })];
    const next = mergeSteps(current, [
      step({ id: "a", title: "查目录", state: "done", evidence: "ls 输出" }),
      step({ id: "b", title: "备份" }),
    ]);
    expect(next).toHaveLength(2);
    expect(next[0].evidence).toBe("ls 输出");
    expect(next[1].title).toBe("备份");
  });

  it("已完成的步骤不会被回退（迟到的 pending 事件无效）", () => {
    const next = mergeSteps(
      [step({ id: "a", state: "done" })],
      [step({ id: "a", state: "pending" })],
    );
    expect(next[0].state).toBe("done");
  });

  it("但失败可以覆盖完成（执行器说了算）", () => {
    const next = mergeSteps(
      [step({ id: "a", state: "done" })],
      [step({ id: "a", state: "failed", evidence: "exit 1" })],
    );
    expect(next[0].state).toBe("failed");
  });
});

describe("一句话进展", () => {
  const base = {
    taskId: "t1",
    goal: "更新前端",
    complexity: "plan" as const,
    updatedAt: 0,
  };

  it("运行中显示当前步骤", () => {
    expect(
      headlineFor({
        ...base,
        status: "running",
        steps: [step({ id: "1", title: "备份", state: "running" })],
      }),
    ).toBe("正在执行：备份");
  });

  it("等待确认 / 失败带步骤位置 / 完成带进度", () => {
    expect(
      headlineFor({
        ...base,
        status: "waiting",
        steps: [step({ id: "1", title: "重启 nginx", state: "running" })],
      }),
    ).toBe("等待确认：重启 nginx");
    expect(
      headlineFor({
        ...base,
        status: "failed",
        steps: [
          step({ id: "1", state: "done" }),
          step({ id: "2", title: "发布", state: "failed" }),
        ],
      }),
    ).toBe("停在第 2 步：发布");
    expect(
      headlineFor({
        ...base,
        status: "done",
        steps: [step({ id: "1", state: "done" }), step({ id: "2", state: "done" })],
      }),
    ).toBe("已完成 2/2 步");
  });

  it("简单任务没有步骤时只说在分析 / 已完成", () => {
    expect(headlineFor({ ...base, status: "running", steps: [] })).toBe("正在分析");
    expect(headlineFor({ ...base, status: "done", steps: [] })).toBe("已完成");
  });
});

describe("执行器事实 → 计划步骤", () => {
  it("输出取首行、优先 stderr，并截断", () => {
    const steps = stepsFromExecution([
      {
        title: "看磁盘",
        command: "df -h",
        state: "success",
        stdout: "/dev/vda1 40G 20G 18G 53% /\n第二行",
      },
      { title: "重启", state: "failed", stderr: "Job failed: timeout\n更多" },
      { title: "收尾", state: "pending", stdout: "x".repeat(400) },
    ]);
    expect(steps[0].state).toBe("done");
    expect(steps[0].evidence).toBe("/dev/vda1 40G 20G 18G 53% /");
    expect(steps[1].state).toBe("failed");
    expect(steps[1].evidence).toBe("Job failed: timeout");
    expect(steps[2].evidence?.length).toBe(160);
  });

  it("失败后只要还有已完成的步骤，就能从现有结果继续", () => {
    expect(
      canContinue({
        taskId: "t",
        goal: "g",
        status: "failed",
        complexity: "plan",
        headline: "",
        updatedAt: 0,
        steps: [step({ id: "1", state: "done" }), step({ id: "2", state: "failed" })],
      }),
    ).toBe(true);
    expect(
      canContinue({
        taskId: "t",
        goal: "g",
        status: "failed",
        complexity: "plan",
        headline: "",
        updatedAt: 0,
        steps: [step({ id: "1", state: "failed" })],
      }),
    ).toBe(false);
  });
});
